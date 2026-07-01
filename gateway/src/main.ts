/**
 * x402 payment gateway for Bunny Edge Scripting (x402 protocol v2).
 *
 * A standalone Edge Script that sits in front of an origin web service and
 * enforces the HTTP 402 "Payment Required" flow before proxying a request
 * through. It is deliberately generic: the accepted payment methods, the
 * settlement facilitator, and the upstream origin are all supplied through
 * environment variables, so nothing here is tied to a single blockchain,
 * token, currency, or facilitator operator.
 *
 * Flow for a protected request:
 *   1. No PAYMENT-SIGNATURE header -> 402 carrying a PAYMENT-REQUIRED header
 *                                     that lists every accepted way to pay.
 *   2. PAYMENT-SIGNATURE present   -> validate the client's chosen option,
 *                                     then ask the facilitator to /verify it.
 *   3. Verified                    -> fetch the origin response.
 *   4. Origin produced a resource  -> ask the facilitator to /settle payment.
 *   5. Settled                     -> return the origin response tagged with a
 *                                     PAYMENT-RESPONSE settlement receipt.
 *
 * Wire format notes live in FINDINGS.md. The short version: v2 puts the
 * challenge in the PAYMENT-REQUIRED response header (not the body), the client
 * pays via the PAYMENT-SIGNATURE request header, the payload echoes the chosen
 * requirement as `accepted`, and the receipt comes back in PAYMENT-RESPONSE.
 */
import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.12.1";
import process from "node:process";

/** Read a config value from Deno.env first, then a node:process fallback. */
function env(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const d = (globalThis as any).Deno;
    const v = d?.env?.get?.(name);
    if (v != null && v !== "") return v;
  } catch {
    // env permission not granted in this context; fall through to process.env
  }
  const p = process.env?.[name];
  return p != null && p !== "" ? p : undefined;
}

// ----------------------------------------------------------------------------
// Types mirroring the x402 v2 wire format (@x402/core).
// ----------------------------------------------------------------------------

interface PaymentRequirements {
  scheme: string;
  network: string; // CAIP-2, e.g. "eip155:84532"
  asset: string;
  amount: string; // atomic units
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
}

interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
}

interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
}

const X402_VERSION = 2;

// ----------------------------------------------------------------------------
// Configuration (all from environment variables / secrets).
// ----------------------------------------------------------------------------

const FACILITATOR_URL = (
  env("X402_FACILITATOR_URL") ?? "https://x402.org/facilitator"
).replace(/\/+$/, "");

/** Optional Authorization header value for facilitators that require auth. */
const FACILITATOR_AUTH = env("X402_FACILITATOR_AUTH");

/** Upstream web service that Bunny proxies once payment is settled. */
const ORIGIN_URL = env("X402_ORIGIN_URL");

/**
 * Path prefixes served for free (comma separated). `/health` is always free
 * through its own handler, so it doesn't need to be listed here.
 */
const FREE_PATHS = (env("X402_FREE_PATHS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** If set, ONLY these prefixes are gated; everything else is free. */
const PROTECT_PATHS = (env("X402_PROTECT_PATHS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Build the list of accepted payment requirements.
 *
 * Prefers a full JSON array in X402_ACCEPTS so an operator can offer several
 * chains / tokens / currencies at once — the payer picks one. Falls back to a
 * single requirement assembled from individual variables for convenience.
 * Nothing here assumes a particular asset or network.
 */
function buildAccepts(): PaymentRequirements[] {
  const raw = env("X402_ACCEPTS");
  let templates: Partial<PaymentRequirements>[];

  if (raw) {
    const parsed = JSON.parse(raw);
    templates = Array.isArray(parsed) ? parsed : [parsed];
  } else {
    const name = env("X402_ASSET_NAME");
    const version = env("X402_ASSET_VERSION");
    // Only the non-default values live here; the .map() below fills the rest.
    templates = [
      {
        network: env("X402_NETWORK"),
        amount: env("X402_AMOUNT") ?? env("X402_PRICE") ?? "10000",
        asset: env("X402_ASSET"),
        payTo: env("X402_PAY_TO"),
        maxTimeoutSeconds: env("X402_MAX_TIMEOUT")
          ? Number(env("X402_MAX_TIMEOUT"))
          : undefined,
        // extra carries the token's EIP-712 domain (name/version) for EVM.
        extra: name || version ? { name, version } : undefined,
      },
    ];
  }

  return templates.map((t) => ({
    scheme: t.scheme ?? "exact",
    network: t.network ?? "eip155:84532",
    asset: t.asset ?? "",
    amount: String(t.amount ?? "0"),
    payTo: t.payTo ?? "",
    maxTimeoutSeconds: Number(t.maxTimeoutSeconds ?? 120),
    ...(t.extra ? { extra: t.extra } : {}),
  }));
}

// The configuration is static for the script's lifetime, so parse it once.
const ACCEPTS = buildAccepts();
const RES_DESCRIPTION = env("X402_RESOURCE_DESCRIPTION") ?? "Paid API access";
const RES_MIME = env("X402_RESOURCE_MIME") ?? "application/json";

function resourceInfo(url: URL): ResourceInfo {
  return {
    url: `${url.origin}${url.pathname}`,
    description: RES_DESCRIPTION,
    mimeType: RES_MIME,
  };
}

// ----------------------------------------------------------------------------
// Header encoding — byte-for-byte identical to @x402/core's helpers.
// ----------------------------------------------------------------------------

/** base64(JSON(value)); matches @x402/core safeBase64Encode. */
function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode a base64 protocol header into an object. */
function decodeHeader<T>(header: string): T {
  const bin = atob(header.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ----------------------------------------------------------------------------
// Helpers.
// ----------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT",
  "Access-Control-Expose-Headers":
    "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
};

function jsonResponse(
  body: unknown,
  status: number,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS, ...extra },
  });
}

/** Re-emit an origin response with CORS (and any extra) headers overlaid. */
function proxiedResponse(
  body: ArrayBuffer,
  origin: Response,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers(origin.headers);
  for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...extra })) {
    headers.set(k, v);
  }
  return new Response(body, { status: origin.status, headers });
}

/**
 * Build the 402 challenge. The machine-readable copy travels in the
 * PAYMENT-REQUIRED header (what the client reads); the JSON body is the same
 * object, included so humans and curl can see it too.
 */
function challenge(url: URL, error: string): Response {
  const body: PaymentRequired = {
    x402Version: X402_VERSION,
    error,
    resource: resourceInfo(url),
    accepts: ACCEPTS,
  };
  return jsonResponse(body, 402, { "PAYMENT-REQUIRED": encodeHeader(body) });
}

const norm = (s: string) => s.trim().toLowerCase();

/** Every field we advertised in `extra` must be echoed back unchanged. */
function extraMatches(
  offered: Record<string, unknown> | undefined,
  accepted: Record<string, unknown> | undefined,
): boolean {
  if (!offered) return true;
  if (!accepted) return false;
  for (const key of Object.keys(offered)) {
    if (JSON.stringify(offered[key]) !== JSON.stringify(accepted[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Confirm the requirement the client says it paid against is really one we
 * offered. Guards against a client self-selecting a cheaper price, a different
 * recipient, a longer authorization window, or a substituted token domain.
 * Returns the matching offered requirement, or undefined.
 */
function matchOffered(
  accepted: PaymentRequirements,
  offered: PaymentRequirements[],
): PaymentRequirements | undefined {
  return offered.find((o) => {
    if (o.scheme !== accepted.scheme) return false;
    if (norm(o.network) !== norm(accepted.network)) return false;
    if (norm(o.asset) !== norm(accepted.asset)) return false;
    if (norm(o.payTo) !== norm(accepted.payTo)) return false;
    if (Number(o.maxTimeoutSeconds) !== Number(accepted.maxTimeoutSeconds)) {
      return false;
    }
    if (!extraMatches(o.extra, accepted.extra)) return false;
    try {
      // The "exact" scheme settles the signed value against this amount with
      // strict equality, so require an exact match here too.
      return BigInt(accepted.amount) === BigInt(o.amount);
    } catch {
      return false;
    }
  });
}

/** Call a facilitator endpoint (/verify or /settle). */
async function facilitator<T>(
  path: string,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (FACILITATOR_AUTH) headers["Authorization"] = FACILITATOR_AUTH;

  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `facilitator ${path} returned ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

/** Match a path prefix on segment boundaries so /health doesn't match /healthz. */
function pathHasPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  return pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function isFree(pathname: string): boolean {
  if (FREE_PATHS.some((p) => pathHasPrefix(pathname, p))) return true;
  // When PROTECT_PATHS is set, only those prefixes cost money.
  if (PROTECT_PATHS.length > 0) {
    return !PROTECT_PATHS.some((p) => pathHasPrefix(pathname, p));
  }
  return false;
}

/** Proxy the incoming request to the configured origin, stripping x402 hops. */
async function proxyToOrigin(req: Request, url: URL): Promise<Response> {
  if (!ORIGIN_URL) {
    return jsonResponse(
      {
        paid: true,
        message:
          "Payment settled, but no X402_ORIGIN_URL is configured on this gateway.",
        path: url.pathname,
      },
      200,
    );
  }

  const target = ORIGIN_URL.replace(/\/+$/, "") + url.pathname + url.search;
  const headers = new Headers(req.headers);
  headers.delete("payment-signature");
  headers.delete("x-payment");
  headers.delete("host");

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  return fetch(target, init);
}

// ----------------------------------------------------------------------------
// Request handler.
// ----------------------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // A small, free health/introspection endpoint.
  if (url.pathname === "/health") {
    return jsonResponse(
      {
        status: "ok",
        service: "x402-gateway",
        x402Version: X402_VERSION,
        facilitator: FACILITATOR_URL,
        origin: ORIGIN_URL ?? null,
        accepts: ACCEPTS,
      },
      200,
    );
  }

  if (isFree(url.pathname)) {
    return proxyToOrigin(req, url);
  }

  // v2 clients send PAYMENT-SIGNATURE; X-PAYMENT is a hedge for a v1 client.
  const paymentHeader =
    req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  if (!paymentHeader) {
    return challenge(url, "payment required");
  }

  // Decode the client's payment.
  let payment: PaymentPayload;
  try {
    payment = decodeHeader<PaymentPayload>(paymentHeader);
  } catch {
    return challenge(url, "invalid_payment_signature_header");
  }

  const accepted = payment.accepted;
  if (!accepted) {
    return challenge(url, "missing_accepted_requirement");
  }

  // Make sure the client picked one of the options we actually offered.
  const offered = matchOffered(accepted, ACCEPTS);
  if (!offered) {
    return challenge(url, "payment_requirements_mismatch");
  }

  // Step 1: verify the payment with the facilitator.
  let verify: VerifyResponse;
  try {
    // Settle against OUR canonical requirement, not the client-supplied copy.
    verify = await facilitator<VerifyResponse>("/verify", payment, offered);
  } catch (e) {
    return jsonResponse(
      { x402Version: X402_VERSION, error: `verify_error: ${String(e)}` },
      502,
    );
  }
  if (!verify.isValid) {
    return challenge(url, verify.invalidReason ?? "payment_invalid");
  }

  // Step 2: produce the resource by proxying to the origin.
  let originResponse: Response;
  try {
    originResponse = await proxyToOrigin(req, url);
  } catch (e) {
    return jsonResponse(
      { x402Version: X402_VERSION, error: `origin_error: ${String(e)}` },
      502,
    );
  }
  const originBody = await originResponse.arrayBuffer();

  // Don't charge for an origin failure.
  if (originResponse.status >= 400) {
    return proxiedResponse(originBody, originResponse);
  }

  // Step 3: settle the payment now that the resource exists.
  let settle: SettleResponse;
  try {
    settle = await facilitator<SettleResponse>("/settle", payment, offered);
  } catch (e) {
    return jsonResponse(
      { x402Version: X402_VERSION, error: `settle_error: ${String(e)}` },
      502,
    );
  }
  if (!settle.success) {
    return challenge(url, settle.errorReason ?? "settle_failed");
  }

  // Step 4: return the paid resource with a settlement receipt.
  const receipt = encodeHeader(settle);
  return proxiedResponse(originBody, originResponse, {
    "PAYMENT-RESPONSE": receipt,
    "X-PAYMENT-RESPONSE": receipt, // back-compat alias
    "X-Payment-Settled": settle.transaction,
  });
}

BunnySDK.net.http.serve(async (req: Request): Promise<Response> => {
  try {
    return await handle(req);
  } catch (e) {
    return jsonResponse(
      { x402Version: X402_VERSION, error: `gateway_error: ${String(e)}` },
      500,
    );
  }
});
