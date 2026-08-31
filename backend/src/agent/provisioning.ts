import { createWalletClient, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Clients } from "../chain/client.js";
import type { CadenceConfig } from "../config.js";
import { ABIS } from "../chain/abis.js";
import { supabaseRequest } from "../supabase.js";
import { decryptSigner, encryptSigner } from "./signer-vault.js";

const APPROVE_SELECTOR = "0x095ea7b3" as Hex;

// Calculated once from canonical Solidity signatures to avoid depending on a
// separate ABI utility in the provisioning path.
async function selector(signature: string) {
  return (`0x${keccak256(toBytes(signature)).slice(2, 10)}`) as Hex;
}

export async function provisionAgentAccount(clients: Clients, cfg: CadenceConfig, owner: Address) {
  if (!cfg.AGENT_FACTORY || !cfg.ADMIN_PRIVATE_KEY || !cfg.AGENT_SIGNER_ENCRYPTION_KEY) {
    throw new Error("AgentAccount provisioning is not configured. Set AGENT_FACTORY, ADMIN_PRIVATE_KEY, and AGENT_SIGNER_ENCRYPTION_KEY.");
  }
  const admin = privateKeyToAccount(cfg.ADMIN_PRIVATE_KEY);
  const adminClient = createWalletClient({ account: admin, chain: clients.chain, transport: http(cfg.RPC_URL) });
  const signerKey = generatePrivateKey();
  const signer = privateKeyToAccount(signerKey);
  const salt = BigInt(keccak256(owner));
  const account = await clients.publicClient.readContract({ address: cfg.AGENT_FACTORY, abi: ABIS.agentAccountFactory, functionName: "getAddress", args: [owner, signer.address, cfg.POLICY_MODULE, salt] }) as Address;

  const createHash = await adminClient.writeContract({ address: cfg.AGENT_FACTORY, abi: ABIS.agentAccountFactory, functionName: "createAccount", args: [owner, signer.address, cfg.POLICY_MODULE, salt], account: admin, chain: clients.chain });
  await clients.publicClient.waitForTransactionReceipt({ hash: createHash });

  const tx = async (functionName: string, args: readonly unknown[]) => {
    const hash = await adminClient.writeContract({ address: cfg.POLICY_MODULE, abi: ABIS.policyModule, functionName: functionName as never, args: args as never, account: admin, chain: clients.chain });
    await clients.publicClient.waitForTransactionReceipt({ hash });
  };
  await tx("registerAccount", [account]);
  await tx("setRule", [account, cfg.COLLATERAL_TOKEN, APPROVE_SELECTOR, true, 0n]);
  await tx("setRule", [account, cfg.DEBT_TOKEN, APPROVE_SELECTOR, true, 0n]);
  await tx("setRule", [account, cfg.LENDING_POOL, await selector("supplyCollateral(uint256)"), true, 10n ** 19n]);
  await tx("setRule", [account, cfg.LENDING_POOL, await selector("borrow(uint256)"), true, 2500n * 10n ** 6n]);
  await tx("setRule", [account, cfg.LENDING_POOL, await selector("repay(uint256)"), true, 2500n * 10n ** 6n]);
  await tx("setRule", [account, cfg.LENDING_POOL, await selector("withdrawCollateral(uint256)"), true, 10n ** 19n]);
  await tx("setCooldown", [account, 900n]);

  const encrypted = encryptSigner(signerKey, cfg.AGENT_SIGNER_ENCRYPTION_KEY);
  await supabaseRequest(cfg, "agent_signers", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ wallet_address: owner.toLowerCase(), agent_account: account.toLowerCase(), signer_address: signer.address.toLowerCase(), encrypted_private_key: encrypted.encryptedPrivateKey, encryption_iv: encrypted.encryptionIv, encryption_auth_tag: encrypted.encryptionAuthTag }) });
  await supabaseRequest(cfg, "wallet_agents", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ wallet_address: owner.toLowerCase(), agent_account: account.toLowerCase(), active: true }) });
  return { agentAccount: account, signerAddress: signer.address };
}

export async function loadProvisionedSigner(cfg: CadenceConfig, owner: Address) {
  if (!cfg.AGENT_SIGNER_ENCRYPTION_KEY) return null;
  const rows = await supabaseRequest<Array<{ agent_account: string; signer_address: string; encrypted_private_key: string; encryption_iv: string; encryption_auth_tag: string }>>(
    cfg,
    `agent_signers?wallet_address=eq.${owner.toLowerCase()}&select=agent_account,signer_address,encrypted_private_key,encryption_iv,encryption_auth_tag&limit=1`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    agentAccount: row.agent_account as Address,
    signer: privateKeyToAccount(decryptSigner({ encryptedPrivateKey: row.encrypted_private_key, encryptionIv: row.encryption_iv, encryptionAuthTag: row.encryption_auth_tag }, cfg.AGENT_SIGNER_ENCRYPTION_KEY)),
  };
}
