import { createHash, randomBytes } from "node:crypto";
import { verifyMessage, type Address, type Hex } from "viem";
import type { CadenceConfig } from "./config.js";
import { supabaseEnabled, supabaseRequest } from "./supabase.js";

const challenges = new Map<string, { message: string; expiresAt: number }>();
const sessions = new Map<string, { address: Address; expiresAt: number }>();

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createChallenge(address: Address, chainId: number) {
  const expiresAt = Date.now() + 5 * 60_000;
  const nonce = randomBytes(16).toString("hex");
  const message = `Cadence wants to verify wallet ownership.\n\nWallet: ${address}\nNetwork: Arc Testnet (Chain ID ${chainId})\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}`;
  challenges.set(address.toLowerCase(), { message, expiresAt });
  return { message, expiresAt };
}

export async function verifyChallenge(address: Address, signature: Hex, cfg: CadenceConfig) {
  const challenge = challenges.get(address.toLowerCase());
  if (!challenge || challenge.expiresAt < Date.now()) throw new Error("Challenge expired or not found.");
  if (!(await verifyMessage({ address, message: challenge.message, signature }))) throw new Error("Wallet signature is invalid.");
  challenges.delete(address.toLowerCase());
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 86_400_000;
  sessions.set(token, { address, expiresAt });
  if (supabaseEnabled(cfg)) {
    try {
      await supabaseRequest(cfg, "wallet_sessions", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ token_hash: tokenHash(token), wallet_address: address.toLowerCase(), expires_at: new Date(expiresAt).toISOString() }),
      });
    } catch (error) {
      console.warn("Could not persist wallet session; using temporary in-memory session:", error instanceof Error ? error.message : String(error));
    }
  }
  return token;
}

/**
 * Register the first verified wallet against the configured AgentAccount.
 * The unique agent_account constraint prevents another wallet from claiming
 * the same account. This is the ownership boundary used by agent POST APIs.
 */
export async function ensureAgentAssignment(address: Address, cfg: CadenceConfig) {
  if (!supabaseEnabled(cfg)) return cfg.AGENT_ACCOUNT;
  try {
    const rows = await supabaseRequest<Array<{ wallet_address: string; agent_account: string; active: boolean }>>(
      cfg,
      `wallet_agents?wallet_address=eq.${address.toLowerCase()}&select=wallet_address,agent_account,active&limit=1`,
    );
    const existing = rows[0];
    if (existing) {
      if (!existing.active || existing.agent_account.toLowerCase() !== cfg.AGENT_ACCOUNT.toLowerCase()) throw new Error("This wallet is not assigned to the configured AgentAccount.");
      return existing.agent_account as Address;
    }
    await supabaseRequest(cfg, "wallet_agents", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ wallet_address: address.toLowerCase(), agent_account: cfg.AGENT_ACCOUNT.toLowerCase(), active: true }),
    });
    return cfg.AGENT_ACCOUNT;
  } catch (error) {
    if (error instanceof Error && error.message.includes("not assigned")) throw error;
    // Keep development usable before the new table is created. Do not hide
    // conflicts or permission errors once Supabase knows about the table.
    if (error instanceof Error && error.message.includes("(404)")) {
      console.warn("wallet_agents table is not available; using configured account temporarily.");
      return cfg.AGENT_ACCOUNT;
    }
    throw error;
  }
}

export async function getAgentAssignment(address: Address, cfg: CadenceConfig) {
  if (!supabaseEnabled(cfg)) return null;
  const rows = await supabaseRequest<Array<{ agent_account: string; active: boolean }>>(
    cfg,
    `wallet_agents?wallet_address=eq.${address.toLowerCase()}&select=agent_account,active&limit=1`,
  );
  const row = rows[0];
  return row?.active ? row.agent_account as Address : null;
}

export async function listAgentAssignments(cfg: CadenceConfig): Promise<Array<{ walletAddress?: Address; agentAccount: Address }>> {
  if (!supabaseEnabled(cfg)) return [{ agentAccount: cfg.AGENT_ACCOUNT }];
  const rows = await supabaseRequest<Array<{ wallet_address: string; agent_account: string; active: boolean }>>(
    cfg,
    "wallet_agents?active=eq.true&select=wallet_address,agent_account",
  );
  const assignments: Array<{ walletAddress?: Address; agentAccount: Address }> = rows.map((row) => ({ walletAddress: row.wallet_address as Address, agentAccount: row.agent_account as Address }));
  if (!assignments.some(({ agentAccount }) => agentAccount.toLowerCase() === cfg.AGENT_ACCOUNT.toLowerCase())) assignments.push({ agentAccount: cfg.AGENT_ACCOUNT });
  return [...new Map(assignments.map((assignment) => [assignment.agentAccount.toLowerCase(), assignment])).values()];
}

export async function authenticatedAddress(token: string | undefined, cfg: CadenceConfig) {
  const session = token ? sessions.get(token) : undefined;
  if (session) {
    if (session.expiresAt < Date.now()) { sessions.delete(token!); return null; }
    return session.address;
  }
  if (!token || !supabaseEnabled(cfg)) return null;
  let rows: Array<{ wallet_address: string; expires_at: string; revoked_at: string | null }>;
  try {
    rows = await supabaseRequest(cfg, `wallet_sessions?token_hash=eq.${tokenHash(token)}&select=wallet_address,expires_at,revoked_at&limit=1`);
  } catch (error) {
    console.warn("Could not validate wallet session in Supabase:", error instanceof Error ? error.message : String(error));
    return null;
  }
  const row = rows[0];
  if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.wallet_address as Address;
}

export async function revokeSession(token: string | undefined, cfg: CadenceConfig) {
  if (!token) return;
  sessions.delete(token);
  if (supabaseEnabled(cfg)) {
    await supabaseRequest(cfg, `wallet_sessions?token_hash=eq.${tokenHash(token)}`, {
      method: "PATCH",
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });
  }
}
