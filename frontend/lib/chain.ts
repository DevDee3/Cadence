import { defineChain } from "viem";

/**
 * Arc Testnet (Circle) — Chain ID 5042002, USDC-native gas.
 *
 * RPC/explorer values per docs.arc.io/arc/references/rpc-endpoints as of
 * this build. Verify against Arc's current docs before a live deploy —
 * testnet infrastructure details can change while Arc is in public
 * testnet phase (mainnet targeted Sep 16 2026).
 */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    // Arc's native gas token is USDC itself — 18 decimals at the protocol
    // level, distinct from the 6-decimal ERC-20 USDC interface used for
    // token transfers/accounting elsewhere in this app. Don't conflate
    // the two when reading balances.
    name: "USD Coin",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});
