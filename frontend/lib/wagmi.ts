import { createConfig, http } from "wagmi";
import { fallback } from "viem";
import { injected, walletConnect } from "wagmi/connectors";
import { arcTestnet } from "./chain";

const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
// This must be the URL users open Cadence at (not a WalletConnect or
// MetaMask deep link). WalletConnect passes it to wallets as Cadence's
// identity and return location after a mobile approval.
const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  // Do not auto-discover every injected wallet. That adds Phantom and other
  // providers to this EVM wallet list even when they were not configured.
  multiInjectedProviderDiscovery: false,
  connectors: [
    injected({ target: "metaMask", shimDisconnect: true }),
    ...(walletConnectProjectId
      ? [walletConnect({
          projectId: walletConnectProjectId,
          showQrModal: true,
          metadata: {
            name: "Cadence",
            description: "Autonomous position management on Arc Testnet.",
            url: appUrl,
            icons: [`${appUrl}/favicon.ico`],
            // Cadence is a website, so the canonical HTTPS URL is its return
            // target. Do not set a native app scheme here.
            redirect: { universal: appUrl },
          },
          qrModalOptions: {
            enableMobileFullScreen: true,
          },
        })]
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
