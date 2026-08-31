import express from "express";
import type { Clients } from "./chain/client.js";
import type { CadenceConfig } from "./config.js";
import type { LLMClient } from "./agent/llm.js";
import { CycleHistory, runCycleLogged } from "./agent/loop.js";
import { loadSettings, saveSettings } from "./agent/settings.js";
import { createChallenge, verifyChallenge, authenticatedAddress, revokeSession, ensureAgentAssignment, getAgentAssignment } from "./auth.js";
import { provisionAgentAccount } from "./agent/provisioning.js";
import { loadProvisionedSigner } from "./agent/provisioning.js";
import type { Address, Hex } from "viem";
import { getMetrics } from "./monitoring.js";

export function createServer(clients: Clients, cfg: CadenceConfig, llm: LLMClient, history: CycleHistory, control: { enabled: boolean; minHealthFactor: number }) {
  const app = express();
  const lastManualCycle = new Map<string, number>();
  const authRateLimits = new Map<string, { count: number; resetAt: number }>();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  function allowAuthAttempt(req: express.Request, res: express.Response) {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const current = authRateLimits.get(key);
    if (!current || current.resetAt <= now) {
      authRateLimits.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (current.count >= 20) {
      res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
      res.status(429).json({ error: "Too many wallet verification attempts. Try again shortly." });
      return false;
    }
    current.count += 1;
    return true;
  }

  app.post("/api/auth/challenge", (req, res) => {
    if (!allowAuthAttempt(req, res)) return;
    const address = req.body?.address as Address;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address ?? "")) { res.status(400).json({ error: "Invalid wallet address." }); return; }
    res.json(createChallenge(address, cfg.CHAIN_ID));
  });

  app.post("/api/auth/verify", async (req, res) => {
    if (!allowAuthAttempt(req, res)) return;
    try { res.json({ token: await verifyChallenge(req.body.address as Address, req.body.signature as Hex, cfg) }); }
    catch (e) { res.status(401).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.get("/api/auth/session", async (req, res) => {
    try {
      const address = await authenticatedAddress(req.header("x-wallet-token"), cfg);
      if (!address) { res.status(401).json({ error: "Wallet verification required." }); return; }
      res.json({ address });
    } catch (e) { res.status(503).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  app.post("/api/auth/logout", async (req, res) => {
    try { await revokeSession(req.header("x-wallet-token"), cfg); res.json({ ok: true }); }
    catch (e) { res.status(503).json({ error: e instanceof Error ? e.message : String(e) }); }
  });

  // In production, protect transaction-triggering endpoints from public
  // abuse. Leaving the key unset preserves local development behavior.
  app.use("/api/agent", async (req, res, next) => {
    if (cfg.AGENT_API_KEY && req.header("x-agent-api-key") !== cfg.AGENT_API_KEY) {
      res.status(401).json({ error: "Unauthorized agent request." });
      return;
    }
    if (req.method === "POST" && req.path !== "/provision") {
      const walletAddress = await authenticatedAddress(req.header("x-wallet-token"), cfg);
      if (!walletAddress) {
        res.status(401).json({ error: "Wallet verification required." });
        return;
      }
      try { await ensureAgentAssignment(walletAddress, cfg); }
      catch (error) {
        res.status(403).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, agentAccount: cfg.AGENT_ACCOUNT, chainId: cfg.CHAIN_ID });
  });

  app.get("/metrics", (_req, res) => {
    res.json({ ok: true, ...getMetrics() });
  });

  app.get("/ready", async (_req, res) => {
    try {
      const chainId = await clients.publicClient.getChainId();
      const entryPointCode = await clients.publicClient.getBytecode({ address: cfg.ENTRY_POINT });
      if (chainId !== cfg.CHAIN_ID || !entryPointCode) {
        res.status(503).json({ ok: false, chainId, expectedChainId: cfg.CHAIN_ID, entryPoint: Boolean(entryPointCode) });
        return;
      }
      res.json({ ok: true, chainId, entryPoint: cfg.ENTRY_POINT });
    } catch (error) {
      res.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/agent/status", async (req, res) => {
    let selectedHistory = history;
    let selectedControl = control;
    try {
      const walletAddress = await authenticatedAddress(req.header("x-wallet-token"), cfg);
      const assignedAccount = walletAddress ? await getAgentAssignment(walletAddress, cfg) : null;
      if (assignedAccount && assignedAccount.toLowerCase() !== cfg.AGENT_ACCOUNT.toLowerCase()) {
        selectedHistory = new CycleHistory(50, assignedAccount, cfg);
        await selectedHistory.ready();
      }
      if (assignedAccount) selectedControl = await loadSettings(cfg, assignedAccount, control);
    } catch { /* compatibility account remains available if the lookup is unavailable */ }
    res.json({ enabled: selectedControl.enabled, minHealthFactor: selectedControl.minHealthFactor, latest: selectedHistory.latest(), history: selectedHistory.list() });
  });

  app.get("/api/agent/account", async (req, res) => {
    const walletAddress = await authenticatedAddress(req.header("x-wallet-token"), cfg);
    if (!walletAddress) { res.status(401).json({ error: "Wallet verification required." }); return; }
    try {
      const agentAccount = await getAgentAssignment(walletAddress, cfg);
      res.json({ walletAddress, agentAccount, provisioningAvailable: Boolean(cfg.AGENT_FACTORY && cfg.ADMIN_PRIVATE_KEY && cfg.AGENT_SIGNER_ENCRYPTION_KEY) });
    } catch (e) {
      res.status(403).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/agent/provision", async (req, res) => {
    const walletAddress = await authenticatedAddress(req.header("x-wallet-token"), cfg);
    if (!walletAddress) { res.status(401).json({ error: "Wallet verification required." }); return; }
    try {
      const existing = await getAgentAssignment(walletAddress, cfg);
      if (existing) { res.json({ agentAccount: existing, alreadyProvisioned: true }); return; }
      const result = await provisionAgentAccount(clients, cfg, walletAddress);
      res.json({ ...result, alreadyProvisioned: false });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/agent/settings", (req, res) => {
    const value = Number(req.body?.minHealthFactor);
    if (!Number.isFinite(value) || value < 1 || value > 10) {
      res.status(400).json({ error: "minHealthFactor must be between 1 and 10" });
      return;
    }
    void (async () => {
      const walletAddress = await authenticatedAddress(req.header("x-wallet-token"), cfg);
      const account = walletAddress ? await getAgentAssignment(walletAddress, cfg) : null;
      if (!account) { res.status(403).json({ error: "No AgentAccount is assigned to this wallet." }); return; }
      const current = await loadSettings(cfg, account, control);
      await saveSettings(cfg, account, { ...current, minHealthFactor: value });
      if (account.toLowerCase() === cfg.AGENT_ACCOUNT.toLowerCase()) control.minHealthFactor = value;
      res.json({ minHealthFactor: value });
    })().catch((error) => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }));
  });

  app.post("/api/agent/control", async (req, res) => {
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    try {
      const walletAddress = await authenticatedAddress(req.header("x-wallet-token"), cfg);
      const account = walletAddress ? await getAgentAssignment(walletAddress, cfg) : null;
      if (!account) { res.status(403).json({ error: "No AgentAccount is assigned to this wallet." }); return; }
      const current = await loadSettings(cfg, account, control);
      await saveSettings(cfg, account, { ...current, enabled: req.body.enabled });
      if (account.toLowerCase() === cfg.AGENT_ACCOUNT.toLowerCase()) control.enabled = req.body.enabled;
      res.json({ enabled: req.body.enabled });
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  // Manual trigger — used for demos and by the frontend's "run a cycle
  // now" affordance, distinct from the background POLL_INTERVAL_SECONDS
  // scheduler. Serializes behind the same runCycleLogged path, so a
  // manual trigger and a scheduled tick can never race each other's
  // policy-precheck/submit steps.
  app.post("/api/agent/run-cycle", async (req, res) => {
    try {
      const walletAddress = await authenticatedAddress(req.header("x-wallet-token"), cfg);
      if (!walletAddress) { res.status(401).json({ error: "Wallet verification required." }); return; }
      const walletKey = walletAddress.toLowerCase();
      const now = Date.now();
      const lastRun = lastManualCycle.get(walletKey) ?? 0;
      const retryAfter = 30_000 - (now - lastRun);
      if (retryAfter > 0) {
        res.setHeader("Retry-After", Math.ceil(retryAfter / 1000));
        res.status(429).json({ error: "Cadence is already processing a recent manual request. Please wait before trying again." });
        return;
      }
      lastManualCycle.set(walletKey, now);
      const assignedAccount = walletAddress ? await getAgentAssignment(walletAddress, cfg) : null;
      const provisioned = walletAddress ? await loadProvisionedSigner(cfg, walletAddress) : null;
      const runtimeClients = provisioned ? { ...clients, agentAccount: provisioned.signer } : clients;
      const runtimeConfig = assignedAccount && provisioned ? { ...cfg, AGENT_ACCOUNT: assignedAccount } : cfg;
      const runtimeHistory = assignedAccount && assignedAccount.toLowerCase() !== cfg.AGENT_ACCOUNT.toLowerCase()
        ? new CycleHistory(50, assignedAccount, cfg)
        : history;
      if (runtimeHistory !== history) await runtimeHistory.ready();
      const instruction = typeof req.body?.instruction === "string" && req.body.instruction.trim()
        ? req.body.instruction.slice(0, 500)
        : `Keep the health factor above ${control.minHealthFactor}.`;
      const logged = await runCycleLogged(runtimeClients, runtimeConfig, llm, runtimeHistory, instruction);
      res.json(logged);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return app;
}
