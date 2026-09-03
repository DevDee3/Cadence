import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { arcTestnet } from "./chain";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
const metaMaskWalletId = "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96";

if (!projectId) {
  throw new Error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required to initialize the wallet modal.");
}

// AppKit provides the complete EVM wallet-selection flow: EIP-6963 detects
// installed desktop extensions, while WalletConnect provides mobile deep links
// and QR fallback for MetaMask and other compatible EVM wallets.
export const wagmiAdapter = new WagmiAdapter({
  networks: [arcTestnet],
  projectId,
  ssr: true,
});

createAppKit({
  adapters: [wagmiAdapter],
  networks: [arcTestnet],
  projectId,
  metadata: {
    name: "Cadence",
    description: "Autonomous position management on Arc Testnet.",
    url: appUrl,
    icons: [`${appUrl}/favicon.ico`],
  },
  // MetaMask is the EVM-first suggested wallet. Other compatible wallets and
  // detected desktop extensions remain available in the modal.
  featuredWalletIds: [metaMaskWalletId],
  allWallets: "SHOW",
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
