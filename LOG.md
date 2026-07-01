# LOG

A running summary of what was asked and what I did.

## Goal

Add x402 payment support in front of a web service proxied by BunnyCDN, using
the bunny CLI and Bunny Edge Scripting. Prove the payment gateway works on a
test network. Later refinements from the user: use the most recent x402 version
(v2), don't tie it to Coinbase or any specific coin/currency, keep dependencies
current, add wallet/balance tooling, and review with `swival` regularly.

## Steps

1. **Explored the toolchain.** bunny CLI source in `~/src/bunny-cli` exposes a
   `scripts` namespace (Edge Scripting): `create`, `deploy`, `env`, `hostnames`,
   `deployments`. Auth already configured (`~/.config/bunnynet.json`). Edge
   runtime is Deno; scripts import `@bunny.net/edgescript-sdk` from esm.sh and
   bundle to a single file with esbuild + the deno loader.

2. **Researched x402.** Confirmed via the live facilitator and the `@x402/core`
   source that the ecosystem is now on **v2** (CAIP-2 networks, `amount` field,
   header-based challenge). Wrote it all down in `FINDINGS.md`.

3. **Built the gateway** (`gateway/`): a standalone Edge Script implementing the
   x402 v2 server flow. Fully config-driven (facilitator, accepted payments,
   origin, free/paid paths) so it's not tied to any chain, token, or facilitator.

4. **Built a demo origin** (`origin/`): a plain premium API with no knowledge of
   payments, to be proxied behind the gateway.

5. **Built the toolbox** (`tools/x402.ts`): create wallets, check balances,
   query a facilitator, decode protocol headers, verify a payment without
   spending, run the full pay+settle flow, and faucet help. viem + `@x402/*` v2.

6. **Local end-to-end test against the live facilitator.** Ran the gateway
   locally and drove it with the real v2 client. Result: the client read the
   `PAYMENT-REQUIRED` header, signed an EIP-3009 authorization, and the
   facilitator accepted the v2 payload, recovered the correct payer, and
   simulated the on-chain transfer — failing only on
   `invalid_exact_evm_insufficient_balance` (the throwaway wallet has no USDC).
   This proves the wire format, the signature, and the whole gateway pipeline.

7. **Deployed to BunnyCDN.** Created two Edge Scripts with linked pull zones via
   the bunny CLI: `x402-origin-demo` (id 80690, `x402-origin-demo-vx2ej.bunny.run`)
   and `x402-gateway` (id 80691, `x402-gateway-l130t.bunny.run`). Set the
   gateway's env (facilitator, origin, asset config) and deployed both bundles.
   The live gateway serves a proper 402 with the `PAYMENT-REQUIRED` header over
   HTTP/2 — BunnyCDN passes the protocol headers through untouched — and the real
   client + live facilitator reproduce the same valid-signature / insufficient-
   balance result against the CDN.

8. **swival review.** Ran `swival` on the changes. It flagged two real issues,
   both fixed: `matchOffered` compared the paid amount with `>=` where the exact
   scheme wants strict equality, and the free/protected path matching used a raw
   `startsWith` that would let `/health` also free `/healthz`. Tightened both,
   rebuilt, and redeployed the gateway.

9. **Real settlement.** The user funded the payer with 20 test USDC on Base
   Sepolia. Ran `x402 pay` against the live gateway: it returned HTTP 200 with
   the premium content and a `PAYMENT-RESPONSE` receipt for on-chain tx
   `0x7bcbf93b43869a1d0d17003d53017045dc15b1c0176478341e17cae5c4f92659`.
   Confirmed on-chain (status success, block 43578572, submitted by the
   facilitator's relayer `0xd407e409…`), and the balances moved: payer 20.00 →
   19.99 USDC, recipient 0.00 → 0.01 USDC. Full write-up in `PROOF.md`.

10. **Second swival pass + hardening.** A follow-up review flagged that
    `matchOffered` still ignored `maxTimeoutSeconds` and `extra`, and that the
    gateway forwarded the client-supplied `accepted` to the facilitator. Fixed
    both: the match now checks the timeout and the advertised `extra`, and
    verify/settle run against the server's own canonical requirement. Redeployed
    and re-proved with a second live settlement
    (`0xb94a0340038aec97559ac50e4c5de990d0373a8ff3cf315aff775341fe1aee51`),
    confirming the honest-client path is unaffected. Removed the throwaway
    `scan-funds.ts` debug helper.

11. **Simplified to a single real origin.** The user wanted the plainest possible
    setup pointed at a real site, `https://00f.net`, with the demo origin removed.
    Repointed the gateway's `X402_ORIGIN_URL` at `https://00f.net`, deleted the
    `x402-origin-demo` Edge Script (id 80690) and its orphaned pull zone, and
    dropped the `origin/` directory. Redeployed the gateway and re-proved the
    whole flow: an unpaid `GET /` returns a 402, and after paying, the gateway
    returns HTTP 200 with the genuine 00f.net page (`<title>Frank DENIS random
    thoughts.</title>`). Settled on-chain in
    `0x57319808bdd8766b72dcfe3d92984d13972a0787d96dea47de3e803eeee398f8`
    (block 43579533). The gateway is now the only moving part.

12. **Rewrote the README as a practical how-to.** The user wanted step-by-step
    "protect your existing website" instructions that actually work. Reoriented
    the whole README around: create the edge script (`bunny scripts create
    x402-gateway --type standalone`), set two variables (`X402_ORIGIN_URL`,
    `X402_PAY_TO`) plus the testnet-USDC defaults, build, deploy, and test with
    the client CLI. While checking the instructions I found `X402_NETWORK` was
    listed as a config knob but never read in the shorthand path (network was
    hardcoded to `eip155:84532`); wired `env("X402_NETWORK")` into
    `buildAccepts` so switching chains is a one-liner, rebuilt, and redeployed
    the gateway (id 80691). Behavior is unchanged for the live config — the var
    was already set to `eip155:84532` — verified by an unpaid `GET /` still
    returning a 402 with a valid `PAYMENT-REQUIRED` header.

13. **Switched the demo origin to `example.com`.** The user wanted the neutral,
    universally recognized `https://example.com` as the proxied site instead of
    a personal blog. Repointed `X402_ORIGIN_URL` and updated the resource
    description, redeployed, and re-proved: unpaid `GET /` returns a 402, and
    after paying the gateway returns HTTP 200 with the genuine example.com page
    (`<title>Example Domain</title>`). Settled on-chain in
    `0x87477b43fe0d219161ea40b4f1ba6f2ca61d05f1f030b8f2543d92ba41b767e0`
    (block 43580724); payer 19.93 → 19.92 USDC, recipient 0.07 → 0.08 USDC.

## Result

The x402 payment gateway works end to end on a test network, in front of a real
BunnyCDN-proxied service. See `PROOF.md` for the transaction and balances.
