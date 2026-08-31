import { createConfig, http } from "wagmi";
import { fallback } from "viem";
import { injected, walletConnect } from "wagmi/connectors";
import { arcTestnet } from "./chain";

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  // Do not auto-discover every injected wallet. That adds Phantom and other
  // providers to this EVM wallet list even when they were not configured.
  multiInjectedProviderDiscovery: false,
  connectors: [
    injected({ target: "metaMask", shimDisconnect: true }),
    ...(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
      ? [walletConnect({ projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, showQrModal: true })]
      : []),
  ],
  // Restore an already-authorized wallet on reload. The explicit MetaMask
  // connector uses eth_accounts here, which is silent and does not request
  // a new wallet approval popup.
  transports: {
    [arcTestnet.id]: fallback([
      http(process.env.NEXT_PUBLIC_RPC_URL || arcTestnet.rpcUrls.default.http[0]),
      http("https://rpc.drpc.testnet.arc.network"),
      http("https://rpc.blockdaemon.testnet.arc.network"),
    ]),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
