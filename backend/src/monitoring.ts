import type { CadenceConfig } from "./config.js";
import { supabaseEnabled, supabaseRequest } from "./supabase.js";

const startedAt = Date.now();

const metrics = {
  schedulerTicks: 0,
  cyclesStarted: 0,
  cyclesCompleted: 0,
  cyclesFailed: 0,
  lastSchedulerTick: null as string | null,
  lastCycleAt: null as string | null,
  lastFailure: null as { at: string; error: string } | null,
};

export function recordSchedulerTick() {
  metrics.schedulerTicks += 1;
  metrics.lastSchedulerTick = new Date().toISOString();
}

export function recordCycleStarted() {
  metrics.cyclesStarted += 1;
  metrics.lastCycleAt = new Date().toISOString();
}

export function recordCycleCompleted() {
  metrics.cyclesCompleted += 1;
}

export function recordCycleFailed(error: string) {
  metrics.cyclesFailed += 1;
  metrics.lastFailure = { at: new Date().toISOString(), error };
}

export async function persistServiceEvent(cfg: CadenceConfig, event: { type: string; severity?: "info" | "warning" | "error"; agentAccount?: string; cycleId?: string; message?: string; metadata?: Record<string, unknown> }) {
  if (!supabaseEnabled(cfg)) return;
  try {
    await supabaseRequest(cfg, "service_events", { method: "POST", body: JSON.stringify({ event_type: event.type, severity: event.severity ?? "info", agent_account: event.agentAccount ?? null, cycle_id: event.cycleId ?? null, message: event.message ?? null, metadata: event.metadata ?? null }) });
  } catch (error) {
    console.error(JSON.stringify({ event: "cadence.monitoring.persist_failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

export async function sendAlert(cfg: CadenceConfig, event: { type: string; message: string; agentAccount?: string; cycleId?: string }) {
  if (!cfg.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(cfg.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "cadence", severity: "error", ...event, at: new Date().toISOString() }),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "cadence.alert.delivery_failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

export function getMetrics() {
  return { uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000), ...metrics };
}
