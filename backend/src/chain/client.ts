import { createPublicClient, createWalletClient, fallback, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CadenceConfig } from "../config.js";

export function buildArcChain(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: "Arc Testnet",
    nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
    testnet: true,
  });
}

export function createClients(cfg: CadenceConfig) {
  const rpcUrls = [
    cfg.RPC_URL,
    "https://rpc.drpc.testnet.arc.network",
    "https://rpc.blockdaemon.testnet.arc.network",
  ].filter((url, index, all) => all.indexOf(url) === index);
  const transport = fallback(rpcUrls.map((url) => http(url)));
  const chain = buildArcChain(cfg.CHAIN_ID, rpcUrls[0]);

  const publicClient = createPublicClient({ chain, transport });

  const agentAccount = privateKeyToAccount(cfg.AGENT_SIGNER_PRIVATE_KEY);
  const agentSignerClient = createWalletClient({ account: agentAccount, chain, transport: http(cfg.RPC_URL) });

  const relayerClient =
    cfg.SUBMISSION_MODE === "relayer" && cfg.RELAYER_PRIVATE_KEY
      ? createWalletClient({
          account: privateKeyToAccount(cfg.RELAYER_PRIVATE_KEY),
          chain,
          transport,
        })
      : null;

  return { chain, publicClient, agentSignerClient, agentAccount, relayerClient };
}

export type Clients = ReturnType<typeof createClients>;
