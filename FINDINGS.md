# x402 v2: the facts I built against

Notes I gathered while wiring this up, mostly by reading the real `@x402/core`
source rather than trusting docs, because the wire format changed between v1
and v2 and a lot of blog posts still show v1.

## Which version is live

The public testnet facilitator `https://x402.org/facilitator` now advertises
**only x402 v2** on `GET /supported` (kinds use CAIP-2 network ids like
`eip155:84532`, not the old `base-sepolia` strings). So this whole project
targets v2.

## v2 wire format (the "exact" EVM scheme)

Types come straight from `@x402/core` (`PaymentRequirements`, `PaymentRequired`,
`PaymentPayload`, `Verify/SettleRequest`, `SettleResponse`).

### The 402 challenge: `PaymentRequired`

The important gotcha: **v2 carries the challenge in a response HEADER, not the
body.** The client calls `getHeader("PAYMENT-REQUIRED")` first and only falls
back to the JSON body if `body.x402Version === 1`. So a v2 server MUST send:

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64(JSON(PaymentRequired))>
```

`PaymentRequired` shape:

```jsonc
{
  "x402Version": 2,
  "error": "payment required",
  "resource": {            // ResourceInfo, top-level (NOT per requirement)
    "url": "https://your-gateway/",
    "description": "…",
    "mimeType": "text/html"
  },
  "accepts": [             // one entry per accepted way to pay
    {
      "scheme": "exact",
      "network": "eip155:84532",   // CAIP-2
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "amount": "10000",            // atomic units, field is `amount`, not `maxAmountRequired`
      "payTo": "0x…",
      "maxTimeoutSeconds": 120,
      "extra": { "name": "USDC", "version": "2" }  // EIP-712 domain of the token
    }
  ]
}
```

### The paid request: `PaymentPayload`

Client re-sends with header **`PAYMENT-SIGNATURE`** = `base64(JSON(PaymentPayload))`
(v1 used `X-PAYMENT`). Decoded:

```jsonc
{
  "x402Version": 2,
  "resource": { … },          // optional echo
  "accepted": { …the chosen PaymentRequirements… },  // client echoes what it signed
  "payload": {                // scheme-specific; for exact/EVM:
    "signature": "0x…",
    "authorization": { "from","to","value","validAfter","validBefore","nonce" }
  }
}
```

The resource server passes `paymentPayload.accepted` as the `paymentRequirements`
to the facilitator. **Security: the server must check `accepted` really is one of
the options it offered** (same payTo/asset/network/amount), otherwise a client
could self-select a cheaper/attacker-controlled requirement.

### Facilitator calls (unchanged wrapper, keyless on testnet)

```
POST {facilitator}/verify   body: { x402Version, paymentPayload, paymentRequirements }
POST {facilitator}/settle   body: { x402Version, paymentPayload, paymentRequirements }
```

- `/verify` → `{ isValid, invalidReason?, payer? }`
- `/settle` → `{ success, transaction, network, payer?, errorReason?, amount? }`

### The receipt

On the paid 200 response the server sets header **`PAYMENT-RESPONSE`** =
`base64(JSON(SettleResponse))` (client also accepts `X-PAYMENT-RESPONSE`).

### Encoding

Plain base64 of `JSON.stringify(...)` (`safeBase64Encode`). No base64url, no
bigint quirks: amounts/timestamps are decimal strings already.

## EVM signing (facilitator's job, not ours)

Still EIP-3009 `TransferWithAuthorization`, EIP-712. Base Sepolia USDC domain
(verified on-chain): `name:"USDC"`, `version:"2"`, `chainId:84532`,
`verifyingContract:0x036CbD53842c5426634e7929541eC2318f3dCF7e`. chainId is parsed
from the CAIP-2 id (`eip155:84532` → 84532). In the exact scheme the **payer
needs only the token, never gas**; the facilitator submits the transfer.

## Runtime facts

- Bunny Edge Scripting is Deno; env via `Deno.env.get()` or `process.env` (from
  `node:process`). CLI uppercases env var names.
- Bundling: `deno run -A build.mjs` with esbuild + `@luca/esbuild-deno-loader`,
  needs `deno.json` with `"nodeModulesDir": "auto"`. Output is one ESM file
  deployed via `bunny scripts deploy dist/index.js`.
- `BunnySDK.net.http.serve(handler)` also runs a local listener on :8080, so the
  script can be tested locally before deploy.

## Client packages (v2)

`@x402/fetch` (`wrapFetchWithPayment(fetch, client)`), `@x402/core/client`
(`new x402Client()`, `client.createPaymentPayload(paymentRequired)`),
`@x402/evm/exact/client` (`registerExactEvmScheme(client, { signer: account })`
where `account` is a viem `LocalAccount`).
