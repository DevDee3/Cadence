import type { Clients } from "../chain/client.js";
import type { CadenceConfig } from "../config.js";
import type { LLMClient } from "./llm.js";
import { runCycle, type CycleOutcome } from "./decide.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { supabaseEnabled, supabaseRequest } from "../supabase.js";
import { listAgentAssignments } from "../auth.js";
import { loadProvisionedSigner } from "./provisioning.js";
import { loadSettings } from "./settings.js";
import { getUserOperationStatus } from "../chain/userOp.js";
import { persistServiceEvent, recordCycleCompleted, recordCycleFailed, recordCycleStarted, recordSchedulerTick, sendAlert } from "../monitoring.js";

export type LoggedCycle = { cycleId?: string; at: string; outcome: CycleOutcome | { status: "error"; error: string } };

// A single process-wide queue prevents a scheduler tick and a manual request
// from reading the same nonce or submitting overlapping actions.
let cycleQueue: Promise<unknown> = Promise.resolve();

/**
 * Keeps recent cycle outcomes in memory and persists them per AgentAccount for the status endpoint. Bounded
 * polling, not a persistent listener — same reasoning as this portfolio's
 * AegisX project used for its monitoring passes: simpler to reason about,
 * and doesn't assume a long-lived process survives restarts intact.
 */
export class CycleHistory {
  private entries: LoggedCycle[];
  private readonly file = join(process.cwd(), "data", "cycle-history.json");
  constructor(private maxEntries = 50, private account?: string, private cfg?: CadenceConfig) {
    this.entries = this.load();
  }

  async ready() {
    if (!this.cfg || !this.account || !supabaseEnabled(this.cfg)) return;
    try {
      let rows: Array<{ cycle_id?: string | null; occurred_at: string; status: string; action: string | null; amount: string | null; rationale: string | null; reason: string | null; error: string | null; transaction_hash: string | null }>;
      try {
        rows = await supabaseRequest(this.cfg, `agent_cycles?agent_account=eq.${this.account}&select=cycle_id,occurred_at,status,action,amount,rationale,reason,error,transaction_hash&order=occurred_at.desc&limit=${this.maxEntries}`);
      } catch {
        rows = await supabaseRequest(this.cfg, `agent_cycles?agent_account=eq.${this.account}&select=occurred_at,status,action,amount,rationale,reason,error,transaction_hash&order=occurred_at.desc&limit=${this.maxEntries}`);
      }
      this.entries = rows.map((row) => ({ cycleId: row.cycle_id ?? undefined, at: row.occurred_at, outcome: { status: row.status, ...(row.action ? { decision: { action: row.action, amount: row.amount ?? "0", rationale: row.rationale ?? "" } } : {}), ...(row.reason ? { reason: row.reason } : {}), ...(row.error ? { error: row.error } : {}), ...(row.transaction_hash ? { txHashOrUserOpHash: row.transaction_hash as `0x${string}` } : {}) } })) as LoggedCycle[];
    } catch { /* local history remains available if Supabase is unavailable */ }
  }

  push(entry: LoggedCycle) {
    this.entries.unshift(entry);
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
    this.persist();
    if (this.cfg && this.account && supabaseEnabled(this.cfg)) void this.persistSupabase(entry);
  }

  list(): LoggedCycle[] {
    return this.entries;
  }

  latest(): LoggedCycle | null {
    return this.entries[0] ?? null;
  }

  async reconcileSubmitted(bundlerRpcUrl: string) {
    for (const entry of this.entries) {
      const outcome = entry.outcome;
      if (outcome.status !== "submitted" || !entry.cycleId || !outcome.txHashOrUserOpHash) continue;
      try {
        const status = await getUserOperationStatus(bundlerRpcUrl, outcome.txHashOrUserOpHash);
        if (!status) continue;
        entry.outcome = status === "confirmed"
          ? { ...outcome, status: "executed" }
          : { ...outcome, status: "failed", error: "UserOperation was rejected by the bundler or reverted on-chain." };
        this.persist();
        if (this.cfg && this.account && supabaseEnabled(this.cfg)) {
          await supabaseRequest(this.cfg, `agent_cycles?cycle_id=eq.${entry.cycleId}`, { method: "PATCH", body: JSON.stringify({ status: entry.outcome.status, error: "error" in entry.outcome ? entry.outcome.error : null }) });
        }
        console.log(JSON.stringify({ event: "cadence.user_operation.reconciled", cycleId: entry.cycleId, status: entry.outcome.status, agentAccount: this.account }));
      } catch (error) {
        console.error(JSON.stringify({ event: "cadence.user_operation.reconcile_failed", cycleId: entry.cycleId, error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }

  private load(): LoggedCycle[] {
    if (!this.account) return [];
    try {
      const store = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, LoggedCycle[]>;
      return store[this.account.toLowerCase()] ?? [];
    } catch { return []; }
  }

  private persist() {
    if (!this.account) return;
    let store: Record<string, LoggedCycle[]> = {};
    try { store = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, LoggedCycle[]>; } catch { /* first write */ }
    store[this.account.toLowerCase()] = this.entries;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(store, null, 2), "utf8");
  }

  private async persistSupabase(entry: LoggedCycle) {
    if (!this.cfg || !this.account) return;
    const outcome = entry.outcome;
    const decision = "decision" in outcome ? outcome.decision : undefined;
    const payload = { agent_account: this.account.toLowerCase(), occurred_at: entry.at, status: outcome.status, action: decision?.action ?? null, amount: decision?.amount ?? null, rationale: decision?.rationale ?? null, reason: "reason" in outcome ? outcome.reason : null, error: "error" in outcome ? outcome.error : null, transaction_hash: "txHashOrUserOpHash" in outcome ? outcome.txHashOrUserOpHash : null };
    try {
      await supabaseRequest(this.cfg, "agent_cycles", { method: "POST", body: JSON.stringify({ cycle_id: entry.cycleId ?? null, ...payload }) });
    } catch (error) {
      // Older deployments may not have run the cycle_id migration yet.
      if (error instanceof Error && error.message.includes("cycle_id")) {
        await supabaseRequest(this.cfg, "agent_cycles", { method: "POST", body: JSON.stringify(payload) });
      } else {
        console.error(JSON.stringify({ event: "cadence.history.persist_failed", agentAccount: this.account, error: error instanceof Error ? error.message : String(error) }));
      }
    }
  }
}

export async function runCycleLogged(
  clients: Clients,
  cfg: CadenceConfig,
  llm: LLMClient,
  history: CycleHistory,
  instruction?: string
): Promise<LoggedCycle> {
  const execute = async () => {
    const at = new Date().toISOString();
    const cycleId = randomUUID();
    recordCycleStarted();
    void persistServiceEvent(cfg, { type: "cycle.started", agentAccount: cfg.AGENT_ACCOUNT, cycleId });
    console.log(JSON.stringify({ event: "cadence.cycle.started", cycleId, at, agentAccount: cfg.AGENT_ACCOUNT }));
    try {
      const outcome = await runCycle(clients, cfg, llm, instruction);
      const logged: LoggedCycle = { cycleId, at, outcome };
      history.push(logged);
      recordCycleCompleted();
      void persistServiceEvent(cfg, { type: "cycle.completed", agentAccount: cfg.AGENT_ACCOUNT, cycleId, metadata: { status: outcome.status, transaction: "txHashOrUserOpHash" in outcome ? outcome.txHashOrUserOpHash : null } });
      console.log(JSON.stringify({ event: "cadence.cycle.completed", cycleId, agentAccount: cfg.AGENT_ACCOUNT, status: outcome.status, transaction: "txHashOrUserOpHash" in outcome ? outcome.txHashOrUserOpHash : null }));
      return logged;
    } catch (e) {
      const logged: LoggedCycle = { cycleId, at, outcome: { status: "error", error: e instanceof Error ? e.message : String(e) } };
      history.push(logged);
      recordCycleFailed("error" in logged.outcome ? logged.outcome.error : "cycle failed");
      void persistServiceEvent(cfg, { type: "cycle.failed", severity: "error", agentAccount: cfg.AGENT_ACCOUNT, cycleId, message: "error" in logged.outcome ? logged.outcome.error : "cycle failed" });
      void sendAlert(cfg, { type: "cycle.failed", agentAccount: cfg.AGENT_ACCOUNT, cycleId, message: "error" in logged.outcome ? logged.outcome.error : "cycle failed" });
      console.error(JSON.stringify({ event: "cadence.cycle.failed", cycleId, agentAccount: cfg.AGENT_ACCOUNT, error: "error" in logged.outcome ? logged.outcome.error : "cycle failed" }));
      return logged;
    }
  };
  const result = cycleQueue.then(execute, execute);
  cycleQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Starts an interval-based scheduler. Returns a stop function. Each
 *  tick awaits the previous cycle fully before scheduling the next —
 *  never runs cycles concurrently. */
export function startScheduler(
  clients: Clients,
  cfg: CadenceConfig,
  llm: LLMClient,
  history: CycleHistory,
  isEnabled: () => boolean = () => true,
  getInstruction: () => string | undefined = () => undefined,
  loadRuntimes?: () => Promise<Array<{ clients: Clients; cfg: CadenceConfig; history: CycleHistory; enabled: boolean; instruction?: string }>>
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick() {
    if (stopped) return;
    recordSchedulerTick();
    void persistServiceEvent(cfg, { type: "scheduler.tick", agentAccount: cfg.AGENT_ACCOUNT });
    try {
      if (loadRuntimes) {
        const runtimes = await loadRuntimes();
        for (const runtime of runtimes) {
          if (runtime.cfg.BUNDLER_RPC_URL) await runtime.history.reconcileSubmitted(runtime.cfg.BUNDLER_RPC_URL);
          if (runtime.enabled) await runCycleLogged(runtime.clients, runtime.cfg, llm, runtime.history, runtime.instruction);
        }
      } else if (isEnabled()) {
        await runCycleLogged(clients, cfg, llm, history, getInstruction());
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "cadence.scheduler.failed", agentAccount: cfg.AGENT_ACCOUNT, error: error instanceof Error ? error.message : String(error) }));
      void sendAlert(cfg, { type: "scheduler.failed", agentAccount: cfg.AGENT_ACCOUNT, message: error instanceof Error ? error.message : String(error) });
    }
    if (!stopped) timer = setTimeout(tick, cfg.POLL_INTERVAL_SECONDS * 1000);
  }

  timer = setTimeout(tick, 0);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export async function loadScheduledRuntimes(clients: Clients, cfg: CadenceConfig, history: CycleHistory, control: { enabled: boolean; minHealthFactor: number }) {
  const accounts = await listAgentAssignments(cfg);
  const runtimes: Array<{ clients: Clients; cfg: CadenceConfig; history: CycleHistory; enabled: boolean; instruction?: string }> = [];
  for (const assignment of accounts) {
    const account = assignment.agentAccount;
    const isDefault = account.toLowerCase() === cfg.AGENT_ACCOUNT.toLowerCase();
    const provisioned = isDefault || !assignment.walletAddress ? null : await loadProvisionedSigner(cfg, assignment.walletAddress);
    if (!isDefault && !provisioned) continue;
    const runtimeClients = provisioned ? { ...clients, agentAccount: provisioned.signer } : clients;
    const runtimeCfg = isDefault ? cfg : { ...cfg, AGENT_ACCOUNT: account };
    const runtimeHistory = isDefault ? history : new CycleHistory(50, account, cfg);
    if (!isDefault) await runtimeHistory.ready();
    const settings = isDefault ? control : await loadSettings(cfg, account, { enabled: true, minHealthFactor: 1.5 });
    runtimes.push({ clients: runtimeClients, cfg: runtimeCfg, history: runtimeHistory, enabled: settings.enabled, instruction: `Keep the health factor above ${settings.minHealthFactor}.` });
  }
  return runtimes;
}
