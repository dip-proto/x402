# Put your website behind an x402 paywall on BunnyCDN

This turns any website into a pay-per-request resource. You point a small
BunnyCDN edge script at your existing site; anyone who calls it without paying
gets an HTTP `402 Payment Required` back. They sign a small stablecoin payment,
retry, and — once the payment settles on-chain — BunnyCDN proxies your real page
straight through. Your website itself never changes and never learns about
payments.

It speaks [x402](https://x402.org) **protocol v2** (the version the public
facilitator serves today) and it isn't tied to Coinbase, USDC, or any one chain
— the token, network, price, and payment facilitator are all configuration. The
edge script holds **no private keys**; it delegates signature checking and
on-chain settlement to a facilitator.

## See it live first

There's a working gateway in front of `https://example.com`. Ask it for a page
without paying and you get the challenge:

```bash
curl -i https://x402-gateway-l130t.bunny.run/
# HTTP/2 402
# payment-required: eyJ4NDAyVmVyc2lvbiI6Mi…   (base64 of the price + how to pay)
```

`GET /health` is free and prints the live config. Every other path costs 0.01
test USDC and, once paid, comes straight from example.com. It's been proven end
to end with a real on-chain settlement — receipt, transaction, and before/after
balances are in [`PROOF.md`](./PROOF.md).

---

## Protect your own site — step by step

### What you need

- **[Bun](https://bun.sh)** — runs the `bunny` CLI and the test client.
- **[Deno](https://deno.com)** — bundles the edge script (`deno run -A build.mjs`).
- A **BunnyCDN account**. The commands below use the `bunny` CLI in
  `~/src/bunny-cli`; run it as `bun ~/src/bunny-cli/packages/cli/src/index.ts …`,
  or alias it once:
  ```bash
  alias bunny='bun ~/src/bunny-cli/packages/cli/src/index.ts'
  bunny login          # browser sign-in; stores a profile. `bunny whoami` to check.
  ```
  (Or skip the login and pass `--api-key <key>` on every command.)
- A **wallet address** to receive payments. That's all you need on the receiving
  end; you never put a private key on the edge.

Everything below runs from a clone of this repo.

### 1. Create the edge script

```bash
cd gateway
bunny scripts create x402-gateway --type standalone
```

This creates a standalone Edge Script, gives it a public `*.bunny.run` hostname,
and links this directory to it — so the deploy and config commands below don't
need to repeat the script id. Note the **script id** and **hostname** it prints
(`bunny scripts list` shows them again later).

### 2. Set the configuration

The gateway is entirely config-driven. Paste this block, **changing only the
first two lines** — your site and your wallet. The rest are the Base Sepolia test
USDC defaults and work as-is:

```bash
bunny scripts env set X402_ORIGIN_URL   https://your-site.example          # ← your website
bunny scripts env set X402_PAY_TO       0xYourWalletAddress                # ← where the money goes

bunny scripts env set X402_NETWORK       eip155:84532                              # Base Sepolia testnet
bunny scripts env set X402_ASSET         0x036CbD53842c5426634e7929541eC2318f3dCF7e # test USDC
bunny scripts env set X402_ASSET_NAME    USDC
bunny scripts env set X402_ASSET_VERSION 2
bunny scripts env set X402_AMOUNT        10000                                     # price in atomic units = 0.01 USDC
bunny scripts env set X402_RESOURCE_MIME "text/html; charset=utf-8"               # your site serves HTML
```

One rule to avoid a proxy loop: **the gateway's hostname must differ from your
origin's hostname.** The simplest choice is the `*.bunny.run` name Bunny just
gave you. To use your own name like `pay.your-site.example`, add it with
`bunny scripts domains add pay.your-site.example`, then create the CNAME record
Bunny asks for and wait for the domain and its TLS certificate to go active
before testing it.

### 3. Build and deploy

```bash
deno run -A build.mjs                 # bundles src/main.ts → dist/index.js (~14 KB)
bunny scripts deploy dist/index.js    # uploads and publishes to the linked script
```

That's it. Your gateway hostname is now a paywall in front of your site. Confirm
the config took — this endpoint is free, so it needs no wallet:

```bash
curl https://YOUR-gateway.bunny.run/health   # echoes the live origin, price, and accepted payment
```

An unpaid request to any other path gets a `402`; a paid one gets your real page.

### 4. Confirm a real payment works

Point a payer at your gateway hostname. From the `tools/` directory (run
`bun install` once):

```bash
cd ../tools

# 1. See the raw 402 challenge.
curl -i https://YOUR-gateway.bunny.run/

# 2. Make a throwaway payer wallet. Prints a testnet private key and stores it
#    in ../tmp/wallets.json — fine for test funds, never real ones.
bun x402.ts wallet new payer

# 3. Fund THAT payer address with test USDC on Base Sepolia (faucet.circle.com),
#    then check the balance landed.
bun x402.ts balance payer

# 4. Prove the signature is accepted — without spending anything.
bun x402.ts verify https://YOUR-gateway.bunny.run/ --key payer

# 5. Pay for real: settle on-chain and read the paid page.
bun x402.ts pay https://YOUR-gateway.bunny.run/ --key payer
```

A successful `pay` prints the settlement receipt (with the on-chain transaction
hash and a block-explorer link), then your site's actual response body.

If you configured a chain other than Base Sepolia, tell the client which one with
`--network` (it knows `base-sepolia`, `base`, `avalanche-fuji`, `avalanche`; for
anything else add `--rpc <url>`), e.g. `bun x402.ts pay <url> --key payer --network base`.

Note that x402 is machine-to-machine. A person in a browser just sees the `402`,
because they have no wallet to sign the payment header. It fits APIs and agent
traffic — clients that run the `@x402/*` library, like `tools/x402.ts`.

---

## Use a different chain, token, or price

The `X402_*` variables above describe one accepted payment. Change the price by
editing `X402_AMOUNT`; switch chains by editing `X402_NETWORK` and the asset
variables. For example, to charge USDC on Base **mainnet**, set `X402_NETWORK` to
`eip155:8453` and `X402_ASSET` to the mainnet USDC contract, and point
`X402_FACILITATOR_URL` at a facilitator that settles there.

To accept **several** options at once — say USDC on two chains, and let the payer
pick — set the single variable `X402_ACCEPTS` to a JSON array instead. This is
schematic: replace every `0x…` with a full address before using it.

```bash
bunny scripts env set X402_ACCEPTS '[
  {"scheme":"exact","network":"eip155:84532","asset":"0xTOKEN_ON_BASE_SEPOLIA","amount":"10000",
   "payTo":"0xYourWallet","extra":{"name":"USDC","version":"2"}},
  {"scheme":"exact","network":"eip155:8453","asset":"0xTOKEN_ON_BASE_MAINNET","amount":"10000",
   "payTo":"0xYourWallet","extra":{"name":"USD Coin","version":"2"}}
]'
```

When `X402_ACCEPTS` is set it wins; the shorthand variables are ignored.

## All configuration variables

Set each with `bunny scripts env set NAME VALUE` (add `--id <script-id>` if the
directory isn't linked to the script).

| Variable | Meaning |
| --- | --- |
| `X402_ORIGIN_URL` | The website to proxy once payment settles. |
| `X402_PAY_TO` | Address that receives payment. |
| `X402_NETWORK` | Chain to charge on, as a CAIP-2 id. Default `eip155:84532` (Base Sepolia). |
| `X402_ASSET` | Token contract address. |
| `X402_ASSET_NAME`, `X402_ASSET_VERSION` | The token's EIP-712 domain (e.g. `USDC` / `2`). |
| `X402_AMOUNT` | Price in the token's atomic units. Default `10000`. Alias: `X402_PRICE`. |
| `X402_MAX_TIMEOUT` | Seconds a signed payment stays valid. Default `120`. |
| `X402_FACILITATOR_URL` | Who verifies and settles. Default `https://x402.org/facilitator`. |
| `X402_FACILITATOR_AUTH` | Optional `Authorization` header for facilitators that need one. |
| `X402_RESOURCE_DESCRIPTION`, `X402_RESOURCE_MIME` | How the resource is described in the challenge. |
| `X402_FREE_PATHS` | Comma-separated path prefixes served for free. `/health` is always free. |
| `X402_PROTECT_PATHS` | If set, **only** these prefixes cost money; everything else is free. |
| `X402_ACCEPTS` | JSON array of accepted payments — overrides all the shorthand above. |

---

## How it works

```
        ┌──────────────┐   PAYMENT-SIGNATURE    ┌─────────────────────┐
client  │  x402-gateway│ ─────────────────────► │  facilitator        │
(pays)  │  (edge script│    /verify  /settle    │  x402.org (testnet) │
  │     │   on Bunny)  │ ◄───────────────────── │  settles on-chain   │
  │     └──────┬───────┘   settlement receipt   └─────────────────────┘
  │            │ proxies once paid
  ▼            ▼
 402       https://your-site.example   ← your real site, payment-unaware
 challenge
```

The gateway fetches the whole origin response, then settles, then returns it —
so it verifies payment before anything leaves the origin, but it buffers the body
in memory. That's a fine fit for ordinary pages and API responses; very large
downloads or streaming endpoints would need the gateway changed to stream.

The whole project is two directories:

- **`gateway/`** — the standalone Edge Script that enforces x402 and reverse-
  proxies to `X402_ORIGIN_URL`. Config-driven, no crypto libraries, ~14 KB
  bundled. This is the only thing that runs in production.
- **`tools/`** — a small CLI (`x402`) built on viem and the `@x402/*` v2 packages
  for testing: make wallets, check balances, decode the protocol headers, verify
  a payment without spending, and run the full pay-and-settle flow.

The wire-level protocol details (why the challenge rides in a header, the v2
field names, the exact facilitator request shapes) are in
[`FINDINGS.md`](./FINDINGS.md). The build-and-proof narrative is in
[`LOG.md`](./LOG.md), and the end-to-end evidence is in [`PROOF.md`](./PROOF.md).
