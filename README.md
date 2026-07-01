# x402 gateway (BunnyCDN edition)

This turns any website into a pay-per-request resource.

You point a small BunnyCDN edge script at your existing site; anyone who calls it without paying gets an HTTP `402 Payment Required` back. They sign a small stablecoin payment, retry, and once the payment settles on-chain, BunnyCDN proxies your real page straight through.

Your website itself never changes and never learns about payments.

It uses [x402](https://x402.org) v2.

## See it live first

There's a working gateway in front of `https://example.com`. Ask it for a page without paying and you get the challenge:

```bash
curl -i https://x402-gateway-l130t.bunny.run/
# HTTP/2 402
# payment-required: eyJ4NDAyVmVyc2lvbiI6Mi…   (base64 of the price + how to pay)
```

`GET /health` is free and prints the live config.

Every other path costs 0.01 test USDC and, once paid, comes straight from example.com.

## Protect your own site, step by step

### Dependencies

- [Deno](https://deno.com): bundles the edge script (`deno run -A build.mjs`) and runs the test client in `tools/` (also on npm as [`bunny-x402-cli`](https://www.npmjs.com/package/bunny-x402-cli), so `deno run -A npm:bunny-x402-cli` runs it without a clone).
- A BunnyCDN account and the `bunny` CLI, signed in:
  ```sh
  deno install -gA -n bunny npm:@bunny.net/cli   # gives you the `bunny` command
  bunny login                                    # browser sign-in; `bunny whoami` to check
  ```
  (No global install? `alias bunny='deno run -A npm:@bunny.net/cli'` works too. Or skip  `login` and pass `--api-key <key>` on every command.)
- A wallet address to receive payments. That's all you need on the receiving end; you never put a private key on the edge.

Everything below runs from a clone of this repo.

### 1. Create the edge script

```bash
cd gateway
bunny scripts create x402-gateway --type standalone
```

This creates a standalone Edge Script, gives it a public `*.bunny.run` hostname, and links this directory to it, so the deploy and config commands below don't need to repeat the script id.

Note the `script id` and `hostname` it prints (`bunny scripts list` shows them again later).

### 2. Set the configuration

The gateway is entirely config-driven

For this default, your whole site, served as HTML, paid in Base Sepolia test USDC, paste this block and **change only the first two lines** (your site and your wallet); the rest work as-is.

Other setups (a JSON API, a different price, only some paths) also reach for the variables in the table further down.

```sh
bunny scripts env set X402_ORIGIN_URL   https://your-site.example          # ← your website
bunny scripts env set X402_PAY_TO       0xYourWalletAddress                # ← where the money goes

bunny scripts env set X402_NETWORK       eip155:84532                               # Base Sepolia testnet
bunny scripts env set X402_ASSET         0x036CbD53842c5426634e7929541eC2318f3dCF7e # test USDC
bunny scripts env set X402_ASSET_NAME    USDC
bunny scripts env set X402_ASSET_VERSION 2
bunny scripts env set X402_AMOUNT        10000                                     # price in atomic units = 0.01 USDC
bunny scripts env set X402_RESOURCE_MIME "text/html; charset=utf-8"               # your site serves HTML
```

One rule to avoid a proxy loop: **the gateway's hostname must differ from your origin's hostname.**

The simplest choice is the `*.bunny.run` name Bunny just gave you.

To use your own name like `pay.your-site.example`:

```sh
bunny scripts domains add pay.your-site.example   # reserve it; Bunny prints the CNAME target
# create that CNAME at your DNS provider, then issue the certificate:
bunny scripts domains ssl pay.your-site.example
```

(Or run the first line with `--wait`, which waits for DNS and issues the certificate for you.) Give the domain and its TLS cert a moment to go active before testing it.

### 3. Build and deploy

```sh
deno run -A build.mjs                 # bundles src/main.ts → dist/index.js (~14 KB)
bunny scripts deploy dist/index.js    # uploads and publishes to the linked script
```

That's it. Your gateway hostname is now a paywall in front of your site. Confirm
the config took; this endpoint is free, so it needs no wallet:

```sh
curl https://YOUR-gateway.bunny.run/health   # echoes the live origin, price, and accepted payment
```

An unpaid request to any other path gets a `402`; a paid one gets your real page.

### 4. Confirm a real payment works

Point a payer at your gateway hostname. From the `tools/` directory (run `deno install` once):

```bash
cd ../tools

# See the raw 402 challenge.
curl -i https://YOUR-gateway.bunny.run/

# Make a throwaway payer wallet. Prints a testnet private key and stores it
# in ../tmp/wallets.json, fine for test funds, never real ones.
deno x402.ts wallet new payer

# Fund THAT payer address with test USDC on Base Sepolia (faucet.circle.com),
# then check the balance landed.
deno x402.ts balance payer

# Prove the signature is accepted, without spending anything.
deno x402.ts verify https://YOUR-gateway.bunny.run/ --key payer

# Pay for real: settle on-chain and read the paid page.
deno x402.ts pay https://YOUR-gateway.bunny.run/ --key payer
```

A successful `pay` prints the settlement receipt (with the on-chain transaction hash and a block-explorer link), then your site's actual response body.

If you configured a chain other than Base Sepolia, tell the client which one with `--network`.

`--rpc <url>` overrides the endpoint for one of those known chains; a brand-new chain needs a few lines added to `tools/config.ts` first. To see a non-default token's balance, pass `--token 0xTokenAddress`.

Note that x402 is machine-to-machine.

A person in a browser just sees the `402`, because they have no wallet to sign the payment header.

It's designed for APIs and agent traffic supporting the `x402` protocol. Web browsers would just see an ugly JSON response.

## Use a different chain, token, or price

The `X402_*` variables above describe one accepted payment.

Change the price by editing `X402_AMOUNT`; switch chains by editing `X402_NETWORK` and the asset variables.

For example, to charge USDC on Base mainnet, set `X402_NETWORK` to `eip155:8453` and `X402_ASSET` to the mainnet USDC contract, and point `X402_FACILITATOR_URL` at a facilitator that settles there.

To accept several options at once, say USDC on two chains, and let the payer pick, set the single variable `X402_ACCEPTS` to a JSON array instead.

```sh
bunny scripts env set X402_ACCEPTS '[
  {"scheme":"exact","network":"eip155:84532","asset":"0xTOKEN_ON_BASE_SEPOLIA","amount":"10000",
   "payTo":"0xYourWallet","extra":{"name":"USDC","version":"2"}},
  {"scheme":"exact","network":"eip155:8453","asset":"0xTOKEN_ON_BASE_MAINNET","amount":"10000",
   "payTo":"0xYourWallet","extra":{"name":"USD Coin","version":"2"}}
]'
```

When `X402_ACCEPTS` is set it wins; the shorthand variables are ignored.

## All configuration variables

Set each with `bunny scripts env set NAME VALUE` (add `--id <script-id>` if the directory isn't linked to the script).

| Variable                                          | Meaning                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `X402_ORIGIN_URL`                                 | The website to proxy once payment settles.                                 |
| `X402_PAY_TO`                                     | Address that receives payment.                                             |
| `X402_NETWORK`                                    | Chain to charge on, as a CAIP-2 id. Default `eip155:84532` (Base Sepolia). |
| `X402_ASSET`                                      | Token contract address.                                                    |
| `X402_ASSET_NAME`, `X402_ASSET_VERSION`           | The token's EIP-712 domain (e.g. `USDC` / `2`).                            |
| `X402_AMOUNT`                                     | Price in the token's atomic units. Default `10000`. Alias: `X402_PRICE`.   |
| `X402_MAX_TIMEOUT`                                | Seconds a signed payment stays valid. Default `120`.                       |
| `X402_FACILITATOR_URL`                            | Who verifies and settles. Default `https://x402.org/facilitator`.          |
| `X402_FACILITATOR_AUTH`                           | Optional `Authorization` header for facilitators that need one.            |
| `X402_RESOURCE_DESCRIPTION`, `X402_RESOURCE_MIME` | How the resource is described in the challenge.                            |
| `X402_FREE_PATHS`                                 | Comma-separated path prefixes served for free. `/health` is always free.   |
| `X402_PROTECT_PATHS`                              | If set, **only** these prefixes cost money; everything else is free.       |
| `X402_ACCEPTS`                                    | JSON array of accepted payments; overrides all the shorthand above.        |


## What's in here

The whole project is two directories. The packages are also available on `npm`:

### `gateway/`

This is the [`bunny-x402`](https://www.npmjs.com/package/bunny-x402) package: the standalone Edge Script that enforces x402 and reverse-proxies to `X402_ORIGIN_URL`. Config-driven, no crypto libraries. This is the only thing that runs in production. The package ships the prebuilt `dist/index.js` you deploy:

```sh
deno add npm:bunny-x402
```

### `tools/`

This is the [`bunny-x402-cli`](https://www.npmjs.com/package/bunny-x402-cli) package: a small CLI (`x402`) built on `viem` and the `@x402/*` v2 packages for testing: make wallets, check balances, decode the protocol headers, verify a payment without spending, and run the full pay-and-settle flow.

```sh
deno install -gA npm:bunny-x402-cli   # or run it without installing: deno run -A npm:bunny-x402-cli help
```