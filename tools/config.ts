import { avalanche, avalancheFuji, base, baseSepolia } from "viem/chains";
import type { Chain } from "viem";

export interface TokenInfo {
  address: `0x${string}`;
  decimals: number;
  /** EIP-712 domain name used by the token's transferWithAuthorization. */
  name: string;
  /** EIP-712 domain version. */
  version: string;
}

export interface NetworkInfo {
  /** x402 network id (v1 string form). */
  id: string;
  chainId: number;
  chain: Chain;
  rpc: string;
  explorer: string;
  tokens: Record<string, TokenInfo>;
}

/**
 * A small registry of networks. The tooling is not tied to any single one —
 * pass --network to target another, and --token to use a different asset.
 * The x402 protocol itself is currency-agnostic; this just gives friendly
 * defaults for the testnets people actually demo on.
 */
export const NETWORKS: Record<string, NetworkInfo> = {
  "base-sepolia": {
    id: "base-sepolia",
    chainId: 84532,
    chain: baseSepolia,
    rpc: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    tokens: {
      USDC: {
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
        name: "USDC",
        version: "2",
      },
    },
  },
  base: {
    id: "base",
    chainId: 8453,
    chain: base,
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    tokens: {
      USDC: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
        name: "USD Coin",
        version: "2",
      },
    },
  },
  "avalanche-fuji": {
    id: "avalanche-fuji",
    chainId: 43113,
    chain: avalancheFuji,
    rpc: "https://api.avax-test.network/ext/bc/C/rpc",
    explorer: "https://testnet.snowtrace.io",
    tokens: {
      USDC: {
        address: "0x5425890298aed601595a70AB815c96711a31Bc65",
        decimals: 6,
        name: "USD Coin",
        version: "2",
      },
    },
  },
  avalanche: {
    id: "avalanche",
    chainId: 43114,
    chain: avalanche,
    rpc: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
    tokens: {
      USDC: {
        address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        decimals: 6,
        name: "USDC",
        version: "2",
      },
    },
  },
};

export function resolveNetwork(name?: string): NetworkInfo {
  const key = name ?? "base-sepolia";
  const net = NETWORKS[key];
  if (!net) {
    throw new Error(
      `Unknown network "${key}". Known: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  return net;
}

export const DEFAULT_FACILITATOR =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";

/** Where test wallets are stored. Testnet keys only — never real funds. */
export const KEYSTORE =
  process.env.X402_KEYSTORE ?? new URL("../tmp/wallets.json", import.meta.url).pathname;
