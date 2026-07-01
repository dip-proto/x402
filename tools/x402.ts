#!/usr/bin/env bun
/**
 * x402 demo toolbox.
 *
 * A small CLI for working with the x402 payment gateway on a test network:
 * create throwaway wallets, check balances, inspect the protocol headers,
 * verify a payment against a facilitator without spending, and run the full
 * pay-and-settle flow end to end.
 *
 * Nothing here is tied to a specific chain, token, or facilitator; pass
 * --network / --token / --facilitator to point it anywhere.
 *
 *   bun x402.ts wallet new payer
 *   bun x402.ts balance payer
 *   bun x402.ts supported
 *   bun x402.ts verify https://gateway.example/ --key payer
 *   bun x402.ts pay    https://gateway.example/ --key payer
 *   bun x402.ts decode <base64-header>
 *   bun x402.ts fund   payer
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  DEFAULT_FACILITATOR,
  KEYSTORE,
  type NetworkInfo,
  resolveNetwork,
} from "./config.ts";

// ----------------------------------------------------------------------------
// Tiny arg parser: positionals + --flag [value] / --flag=value / boolean.
// ----------------------------------------------------------------------------

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Resolve the facilitator base URL (--facilitator, else default), no trailing slash. */
function facilitatorUrl(args: Args): string {
  return (flag(args, "facilitator") ?? DEFAULT_FACILITATOR).replace(/\/+$/, "");
}

// ----------------------------------------------------------------------------
// Keystore for throwaway test wallets.
// ----------------------------------------------------------------------------

type Hex = `0x${string}`;
interface StoredWallet {
  address: Hex;
  privateKey: Hex;
}
interface Store {
  wallets: Record<string, StoredWallet>;
}

function loadStore(): Store {
  if (!existsSync(KEYSTORE)) return { wallets: {} };
  return JSON.parse(readFileSync(KEYSTORE, "utf8")) as Store;
}

function saveStore(store: Store): void {
  mkdirSync(dirname(KEYSTORE), { recursive: true });
  writeFileSync(KEYSTORE, JSON.stringify(store, null, 2));
}

const PK_RE = /^0x[0-9a-fA-F]{64}$/;

/** Resolve a private key from a raw 0x key, a stored label, or env. */
function resolvePrivateKey(ref?: string): Hex {
  const value = ref ?? process.env.X402_PRIVATE_KEY;
  if (!value) {
    throw new Error("No wallet given. Pass --key <label|0xprivatekey>.");
  }
  if (PK_RE.test(value)) return value as Hex;
  const wallet = loadStore().wallets[value];
  if (!wallet) throw new Error(`No stored wallet named "${value}".`);
  return wallet.privateKey;
}

/** Resolve an address from a raw address, a private key, or a stored label. */
function resolveAddress(ref?: string): Hex {
  const value = ref ?? process.env.X402_PRIVATE_KEY;
  if (!value) throw new Error("No wallet/address given.");
  if (isAddress(value)) return value as Hex;
  if (PK_RE.test(value)) return privateKeyToAccount(value as Hex).address;
  const wallet = loadStore().wallets[value];
  if (!wallet) throw new Error(`No stored wallet named "${value}".`);
  return wallet.address;
}

// ----------------------------------------------------------------------------
// Commands.
// ----------------------------------------------------------------------------

function cmdWallet(args: Args): void {
  const sub = args._[0];
  const store = loadStore();

  if (sub === "new") {
    const label = args._[1] ?? `wallet-${Object.keys(store.wallets).length + 1}`;
    if (store.wallets[label] && !args.flags.force) {
      throw new Error(`Wallet "${label}" already exists (use --force).`);
    }
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    store.wallets[label] = { address, privateKey };
    saveStore(store);
    console.log(`Created test wallet "${label}"`);
    console.log(`  address:     ${address}`);
    console.log(`  private key: ${privateKey}`);
    console.log(`  keystore:    ${KEYSTORE}`);
    console.log("\nThis is a throwaway TESTNET key. Never send real funds.");
    return;
  }

  if (sub === "list" || sub === undefined) {
    const entries = Object.entries(store.wallets);
    if (entries.length === 0) {
      console.log("No wallets yet. Create one: x402 wallet new <label>");
      return;
    }
    for (const [label, w] of entries) console.log(`${label}\t${w.address}`);
    return;
  }

  if (sub === "show") {
    const label = args._[1];
    const w = store.wallets[label];
    if (!w) throw new Error(`No stored wallet named "${label}".`);
    console.log(`address:     ${w.address}`);
    if (args.flags.reveal) console.log(`private key: ${w.privateKey}`);
    return;
  }

  throw new Error(`Unknown "wallet" subcommand: ${sub}`);
}

function publicClientFor(net: NetworkInfo, rpc?: string) {
  return createPublicClient({ chain: net.chain, transport: http(rpc ?? net.rpc) });
}

async function cmdBalance(args: Args): Promise<void> {
  const net = resolveNetwork(flag(args, "network"));
  const address = resolveAddress(args._[0]);
  const client = publicClientFor(net, flag(args, "rpc"));

  const native = await client.getBalance({ address });
  console.log(`network:  ${net.id} (chainId ${net.chainId})`);
  console.log(`address:  ${address}`);
  console.log(
    `native:   ${formatUnits(native, 18)} ${net.chain.nativeCurrency.symbol}`,
  );

  // Which token(s) to report: --token <symbol|address>, else all known tokens.
  const tokenArg = flag(args, "token");
  const tokens: { label: string; address: Hex; decimals?: number }[] = [];
  if (tokenArg) {
    if (isAddress(tokenArg)) {
      tokens.push({ label: "token", address: tokenArg as Hex });
    } else {
      const t = net.tokens[tokenArg.toUpperCase()];
      if (!t) throw new Error(`Unknown token "${tokenArg}" on ${net.id}.`);
      tokens.push({ label: tokenArg.toUpperCase(), address: t.address, decimals: t.decimals });
    }
  } else {
    for (const [sym, t] of Object.entries(net.tokens)) {
      tokens.push({ label: sym, address: t.address, decimals: t.decimals });
    }
  }

  for (const tok of tokens) {
    const [raw, decimals, symbol] = await Promise.all([
      client.readContract({ address: tok.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      tok.decimals !== undefined
        ? Promise.resolve(tok.decimals)
        : client.readContract({ address: tok.address, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: tok.address, abi: erc20Abi, functionName: "symbol" }).catch(() => tok.label),
    ]);
    console.log(
      `token:    ${formatUnits(raw as bigint, decimals as number)} ${symbol} (${tok.address})`,
    );
  }
}

async function cmdSupported(args: Args): Promise<void> {
  const facilitator = facilitatorUrl(args);
  const res = await fetch(`${facilitator}/supported`);
  const body = await res.json();
  console.log(`facilitator: ${facilitator}`);
  console.log(JSON.stringify(body, null, 2));
}

function decodeHeader(header: string): unknown {
  const json = Buffer.from(header.trim(), "base64").toString("utf8");
  return JSON.parse(json);
}

function cmdDecode(args: Args): void {
  const header = args._[0];
  if (!header) throw new Error("Usage: x402 decode <base64-header>");
  console.log(JSON.stringify(decodeHeader(header), null, 2));
}

interface PaymentRequiredDoc {
  x402Version: number;
  error?: string;
  resource?: unknown;
  accepts: any[];
}

/** GET a protected URL and return the parsed v2 402 challenge (from the header). */
async function fetchChallenge(url: string): Promise<PaymentRequiredDoc> {
  const res = await fetch(url);
  if (res.status !== 402) {
    const text = await res.text();
    throw new Error(
      `Expected HTTP 402 from ${url}, got ${res.status}. Body: ${text.slice(0, 200)}`,
    );
  }
  // v2 carries the challenge in the PAYMENT-REQUIRED header; body is a courtesy copy.
  const header = res.headers.get("payment-required");
  if (header) return decodeHeader(header) as PaymentRequiredDoc;
  return (await res.json()) as PaymentRequiredDoc;
}

function newClient(account: ReturnType<typeof privateKeyToAccount>): x402Client {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  return client;
}

async function cmdVerify(args: Args): Promise<void> {
  const url = args._[0];
  if (!url) throw new Error("Usage: x402 verify <url> --key <wallet>");
  const facilitator = facilitatorUrl(args);
  const account = privateKeyToAccount(resolvePrivateKey(flag(args, "key")));
  const client = newClient(account);

  const paymentRequired = await fetchChallenge(url);
  const first = paymentRequired.accepts?.[0];
  console.log(`402 challenge from ${url}:`);
  console.log(`  options: ${paymentRequired.accepts?.length ?? 0}`);
  if (first) {
    console.log(`  price:   ${first.amount} (atomic) of ${first.asset}`);
    console.log(`  payTo:   ${first.payTo}`);
    console.log(`  network: ${first.network}`);
  }

  // Sign with the real v2 client, but stop at /verify: no settlement, no spend.
  const paymentPayload = await client.createPaymentPayload(paymentRequired as any);

  const res = await fetch(`${facilitator}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: (paymentPayload as any).x402Version,
      paymentPayload,
      paymentRequirements: (paymentPayload as any).accepted,
    }),
  });
  const verdict = await res.json();
  console.log(`\nfacilitator /verify (${facilitator}):`);
  console.log(JSON.stringify(verdict, null, 2));
  console.log(
    verdict.isValid
      ? `\nSignature VALID: payer ${verdict.payer} is authorized to pay. (No funds moved.)`
      : `\nNot valid: ${verdict.invalidReason ?? verdict.invalidMessage}`,
  );
}

async function cmdPay(args: Args): Promise<void> {
  const url = args._[0];
  if (!url) throw new Error("Usage: x402 pay <url> --key <wallet>");
  const net = resolveNetwork(flag(args, "network"));
  const account = privateKeyToAccount(resolvePrivateKey(flag(args, "key")));
  const client = newClient(account);

  const maxRaw = flag(args, "max");
  if (maxRaw) {
    const cap = BigInt(maxRaw);
    client.registerPolicy((_v: number, reqs: any[]) =>
      reqs.filter((r) => {
        try {
          return BigInt(r.amount) <= cap;
        } catch {
          return false;
        }
      }),
    );
  }

  console.log(`Paying for ${url}`);
  console.log(`  payer:   ${account.address}`);
  if (maxRaw) console.log(`  max:     ${maxRaw} atomic units`);

  const payFetch = wrapFetchWithPayment(fetch, client);
  const res = await payFetch(url);
  const body = await res.text();

  console.log(`\nHTTP ${res.status}`);
  const receiptHeader =
    res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (receiptHeader) {
    const receipt = decodeHeader(receiptHeader) as any;
    console.log("\nSettlement receipt (PAYMENT-RESPONSE):");
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt?.transaction) {
      console.log(`\nOn-chain tx: ${net.explorer}/tx/${receipt.transaction}`);
    }
  } else {
    console.log("\n(no PAYMENT-RESPONSE header; payment may not have settled)");
  }
  console.log("\nResponse body:");
  console.log(body.slice(0, 2000));
}

async function cmdReceipt(args: Args): Promise<void> {
  const hash = args._[0] as `0x${string}`;
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("Usage: x402 receipt <0x-txhash> [--network]");
  }
  const net = resolveNetwork(flag(args, "network"));
  const client = publicClientFor(net, flag(args, "rpc"));

  const receipt = await client.getTransactionReceipt({ hash });
  const tx = await client.getTransaction({ hash });
  console.log(`network:      ${net.id}`);
  console.log(`tx:           ${hash}`);
  console.log(`status:       ${receipt.status}`);
  console.log(`block:        ${receipt.blockNumber}`);
  console.log(`from:         ${tx.from}`);
  console.log(`to (token):   ${tx.to}`);
  console.log(`gas used:     ${receipt.gasUsed}`);
  console.log(`explorer:     ${net.explorer}/tx/${hash}`);
  console.log(
    receipt.status === "success"
      ? "\nConfirmed on-chain. The facilitator settled the transfer."
      : "\nTransaction reverted.",
  );
}

async function cmdFund(args: Args): Promise<void> {
  const net = resolveNetwork(flag(args, "network"));
  const address = resolveAddress(args._[0]);
  console.log(`Funding target: ${address} on ${net.id}`);

  // Circle faucet REST API (needs CIRCLE_API_KEY on an eligible account).
  if (process.env.CIRCLE_API_KEY) {
    const blockchain = net.id.toUpperCase(); // e.g. BASE-SEPOLIA
    console.log(`Requesting Circle faucet drip (${blockchain})...`);
    const res = await fetch("https://api.circle.com/v1/faucet/drips", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ address, blockchain, native: true, usdc: true }),
    });
    console.log(`Circle faucet: HTTP ${res.status} ${await res.text()}`);
    return;
  }

  // Generic faucet webhook (POST {address, network}) if configured.
  if (process.env.X402_FAUCET_URL) {
    const res = await fetch(process.env.X402_FAUCET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, network: net.id }),
    });
    console.log(`Faucet: HTTP ${res.status} ${await res.text()}`);
    return;
  }

  console.log(
    "\nNo faucet credentials configured (CIRCLE_API_KEY or X402_FAUCET_URL).",
  );
  console.log("Fund this address manually, then re-check with `x402 balance`:");
  if (net.id === "base-sepolia") {
    console.log("  USDC:  https://faucet.circle.com  (pick Base Sepolia)");
    console.log("  CDP:   https://portal.cdp.coinbase.com  (Faucets > Base Sepolia > USDC)");
  }
  console.log(`\n  address: ${address}`);
  console.log(
    "\nRemember: with the x402 'exact' scheme the payer needs only the TOKEN.\n" +
      "The facilitator pays gas, so no native coin is required to pay.",
  );
}

// ----------------------------------------------------------------------------
// Dispatch.
// ----------------------------------------------------------------------------

const HELP = `x402 demo toolbox

  wallet new <label>          create a throwaway test wallet
  wallet list                 list stored wallets
  wallet show <label>         show an address (--reveal for the key)
  balance <wallet|address>    native + token balances (--network --token)
  supported                   query a facilitator's /supported (--facilitator)
  verify <url>                sign a payment and check it (no spend) (--key)
  pay <url>                   full x402 pay + settle flow (--key --max)
  decode <base64>             decode any x402 protocol header (base64 JSON)
  receipt <txhash>            confirm a settlement tx on-chain (--network)
  fund <wallet|address>       faucet help / drip (--network)

Common flags: --network base-sepolia  --facilitator <url>  --key <label|0xpk>`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case "wallet": return cmdWallet(args);
    case "balance": return cmdBalance(args);
    case "supported": return cmdSupported(args);
    case "verify": return cmdVerify(args);
    case "pay": return cmdPay(args);
    case "decode": return cmdDecode(args);
    case "receipt": return cmdReceipt(args);
    case "fund": return cmdFund(args);
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
