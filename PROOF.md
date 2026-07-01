# Proof: the x402 gateway settled a real payment on a test network

This is the end-to-end evidence that the whole thing works: a request that
BunnyCDN proxies to a real website, gated by x402, paid with a real stablecoin
transfer settled on-chain on Base Sepolia.

## The setup

| | |
| --- | --- |
| Gateway (Bunny Edge Script, paywall) | https://x402-gateway-l130t.bunny.run (script id 80691) |
| Origin (the real site it proxies) | https://example.com |
| Facilitator (verifies + settles) | https://x402.org/facilitator |
| Network | Base Sepolia — `eip155:84532` |
| Asset | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Price | 0.01 USDC (`10000` atomic units) |
| Payer wallet | `0x737EdDD30119F44F34c005cAaC773f63830F10a1` |
| Recipient (payTo) | `0x21E87B5EaB5c3F67D0B9b4013AB3b422cD0C1300` |

There is no demo origin service any more — the gateway reverse-proxies straight
to `https://example.com`, a live third-party site that knows nothing about
payments.

## What happened, step by step

1. **Unpaid request → 402.** `GET https://x402-gateway-l130t.bunny.run/`
   with no payment returned `HTTP/2 402` and a base64 `PAYMENT-REQUIRED` header
   describing the price (0.01 USDC to the recipient on Base Sepolia).

2. **The client paid.** The real `@x402/*` v2 client read that header, signed an
   EIP-3009 `TransferWithAuthorization`, and retried with a `PAYMENT-SIGNATURE`
   header.

3. **The gateway verified, proxied, and settled.** It asked the facilitator to
   `/verify`, proxied the request to `https://example.com`, then asked the
   facilitator to `/settle`. The response came back **HTTP 200** carrying the
   real example.com page and a `PAYMENT-RESPONSE` settlement receipt:

   ```json
   {
     "success": true,
     "transaction": "0x87477b43fe0d219161ea40b4f1ba6f2ca61d05f1f030b8f2543d92ba41b767e0",
     "network": "eip155:84532",
     "payer": "0x737EdDD30119F44F34c005cAaC773f63830F10a1"
   }
   ```

   The body was the genuine origin HTML — `<title>Example Domain</title>` —
   proving BunnyCDN proxied the real site once paid.

## The on-chain transaction

https://sepolia.basescan.org/tx/0x87477b43fe0d219161ea40b4f1ba6f2ca61d05f1f030b8f2543d92ba41b767e0

Independently confirmed via RPC:

```
status:       success
block:        43580724
from:         0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf   (the facilitator's relayer)
to (token):   0x036cbd53842c5426634e7929541ec2318f3dcf7e   (USDC)
gas used:     85708
```

The `from` address is the facilitator's own relayer — the exact
`facilitatorAddress` it advertises on `/supported`. That is the x402 "exact"
scheme working as designed: **the facilitator submitted the transfer and paid
the gas; the payer never needed any ETH** (its native balance stayed at 0).

## The money actually moved

| Wallet | Before | After |
| --- | --- | --- |
| Payer `0x737E…10a1` | 19.93 USDC | 19.92 USDC |
| Recipient `0x21E8…1300` | 0.07 USDC | 0.08 USDC |

0.01 USDC left the payer and arrived at the recipient for each paid request,
matching the gateway's advertised price — settled on Base Sepolia, proxied
through BunnyCDN in front of the real example.com.

## Reproduce it

```bash
cd tools
bun x402.ts pay https://x402-gateway-l130t.bunny.run/ --key payer
bun x402.ts receipt <txhash>
```
