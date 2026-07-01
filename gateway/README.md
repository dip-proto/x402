# bunny-x402

An x402 paywall for [Bunny.net Edge Scripting](https://bunny.net/edge-scripting/).

It's a standalone Edge Script that sits in front of an origin website and enforces the HTTP `402 Payment Required` flow before proxying a request through.

Callers who don't pay get a `402` with the price and how to settle it; callers who sign a stablecoin payment and retry get your real page once the payment clears on-chain.

Your origin never changes and never learns about payments.

Everything is driven by environment variables: the accepted token, network, price, and settlement facilitator are all config, so nothing here is tied to a single blockchain, currency, or facilitator.

The script holds no private keys; it delegates signature checking and on-chain settlement to a facilitator. It speaks x402 protocol
v2 and bundles to about 14 KB.

## Install

```sh
deno add npm:bunny-x402
```

The prebuilt edge script ships as `dist/index.js`; the source is in `src/main.ts`.

Building from source needs [Deno](https://deno.com):

```sh
deno run -A build.mjs        # bundles src/main.ts -> dist/index.js
```

## Deploy

Point a Bunny standalone Edge Script at the bundle, set at minimum your origin and
your receiving wallet, and deploy:

```bash
bunny scripts env set X402_ORIGIN_URL https://your-site.example
bunny scripts env set X402_PAY_TO     0xYourWalletAddress
bunny scripts deploy dist/index.js
```

`GET /health` is free and echoes the live config; every other path is paywalled.

The full step-by-step (config variables, multi-chain setup, a live demo, and an end-to-end on-chain proof) is in the [project README](https://github.com/dip-proto/x402#readme).
