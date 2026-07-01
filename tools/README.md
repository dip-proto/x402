# bunny-x402-cli

A command-line x402 client for testing payment gateways.

It creates throwaway wallets, checks balances, decodes the protocol headers, verifies a signature against a facilitator without spending anything, and runs the full pay-and-settle flow end to end. It's the companion tester for [`bunny-x402`](https://www.npmjs.com/package/bunny-x402), but it works against any x402 gateway.

Nothing is tied to a specific chain, token, or facilitator; pass `--network`, `--token`, or `--facilitator` to point it anywhere. It ships knowing Base, Base Sepolia, Avalanche, and Avalanche Fuji; add others with `--rpc`.

## Requirements

Runs on [Deno](https://deno.com).

## Install

```sh
deno install -gA npm:bunny-x402-cli
# or run without installing:
deno run -A npm:bunny-x402-cli help
```

## Use

```sh
x402 wallet new payer                     # make a throwaway testnet wallet
x402 balance payer                        # check its token balance
x402 verify https://gateway.example/ --key payer   # prove a signature is accepted, spend nothing
x402 pay    https://gateway.example/ --key payer   # settle on-chain and read the paid response
x402 decode <base64-header>               # inspect a raw 402 challenge
```

Test wallets are written to `../tmp/wallets.json` relative to the CLI by default.

When you install globally, set `X402_KEYSTORE` to a writable path of your own:

```bash
export X402_KEYSTORE="$HOME/.x402/wallets.json"
```

These are testnet keys only: never store real funds here.
