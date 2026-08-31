"use client";

import { useEffect, useState } from "react";

type AgentResult = {
  cycleId?: string;
  enabled?: boolean;
  at?: string;
  outcome?: {
    status: string;
    error?: string;
    decision?: { action?: string; amount?: string; rationale?: string };
    txHashOrUserOpHash?: string;
  };
  error?: string;
};

export function AgentControls() {
  const [result, setResult] = useState<AgentResult | null>(null);
  const [running, setRunning] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [requestedAction, setRequestedAction] = useState("review");
  const [requestedAmount, setRequestedAmount] = useState("");

  function walletHeaders() {
    return {
      "content-type": "application/json",
      "x-wallet-token": window.localStorage.getItem("cadence_wallet_token") ?? "",
    };
  }

  async function refreshStatus() {
    try {
      const response = await fetch("/api/agent/status", { cache: "no-store" });
      if (response.ok) {
        const body = await response.json();
        setResult(body.latest ?? body);
        if (typeof body.enabled === "boolean") setEnabled(body.enabled);
      }
    } catch {
      // The run button provides the visible error state when the backend is unavailable.
    }
  }

  async function toggleAutonomy() {
    const next = !enabled;
    setEnabled(next);
    const response = await fetch("/api/agent/control", {
      method: "POST",
      headers: walletHeaders(),
      body: JSON.stringify({ enabled: next }),
    });
    if (!response.ok) setEnabled(!next);
  }

  // refreshStatus is intentionally stable for this client-only polling loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  async function runCycle(request = instruction) {
    setRunning(true);
    try {
      const response = await fetch("/api/agent/run-cycle", {
        method: "POST",
        headers: walletHeaders(),
        body: JSON.stringify({ instruction: request }),
      });
      const body = await response.json();
      setResult(body);
      window.dispatchEvent(new CustomEvent("cadence:cycle-complete"));
    } catch {
      setResult({ error: "Could not reach the agent backend." });
    } finally {
      setRunning(false);
    }
  }

  const outcome = result?.outcome;
  const status = outcome?.status ?? (result?.error ? "offline" : "unknown");
  const statusColor = status === "executed" ? "text-jade" : status === "offline" || status === "error" || status === "failed" ? "text-clay" : "text-brass";

  const quickCommands = [
    "Keep my position safe",
    "Review my position",
    "Repay debt if it improves safety",
  ];

  function runRequestedAction() {
    const labels: Record<string, string> = { review: "Review my position", supply: "Supply my deposited collateral", borrow: "Borrow", repay: "Repay debt", withdraw: "Withdraw collateral" };
    const asset = requestedAction === "borrow" || requestedAction === "repay" ? "USDC" : "mCOL";
    const suffix = requestedAmount.trim() ? ` ${requestedAmount.trim()} ${asset}` : "";
    const command = `${labels[requestedAction]}${suffix}. Only proceed if it is safe and allowed by my on-chain policy.`;
    setInstruction(command);
    void runCycle(command);
  }

  return (
    <section className="rounded-xl border border-jade/25 bg-gradient-to-br from-ink-850 to-ink-900 p-5 sm:p-6 shadow-lg shadow-black/10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${enabled ? "bg-jade shadow-[0_0_10px_var(--jade)]" : "bg-muted"}`} />
            <h2 className={`text-xs uppercase tracking-widest ${enabled ? "text-jade" : "text-muted"}`}>{enabled ? "Cadence is monitoring" : "Cadence is paused"}</h2>
          </div>
          <h3 className="text-xl text-paper mt-2">What should I watch for?</h3>
          <p className="text-sm text-muted mt-1 max-w-xl">Give Cadence a goal. It will inspect your position, explain its decision, and act only within your on-chain limits.</p>
        </div>
        <button onClick={toggleAutonomy} className="text-xs text-muted border border-ink-650 rounded-full px-2.5 py-1 hover:border-jade/50 hover:text-jade">{enabled ? "Pause autonomy" : "Resume autonomy"}</button>
      </div>

      <div className="mt-5 flex flex-col sm:flex-row gap-2">
        <input
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && instruction.trim()) void runCycle(); }}
          placeholder="e.g. Keep my health factor above 1.5"
          className="min-w-0 flex-1 rounded-md border border-ink-650 bg-ink-950/60 px-3 py-2.5 text-sm text-paper placeholder:text-muted focus:border-jade/60 focus:outline-none"
          maxLength={500}
        />
        <button
          onClick={() => runCycle()}
          disabled={running || !instruction.trim()}
          className="rounded-md bg-jade px-4 py-2.5 text-sm font-medium text-ink-950 hover:brightness-110 disabled:opacity-40"
        >
          {running ? "Thinking…" : "Ask Cadence"}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        {quickCommands.map((command) => (
          <button key={command} onClick={() => { setInstruction(command); void runCycle(command); }} disabled={running} className="rounded-full border border-ink-650 px-3 py-1.5 text-xs text-paper-dim hover:border-jade/50 hover:text-jade disabled:opacity-40">
            {command}
          </button>
        ))}
      </div>
      <div className="mt-5 border-t border-ink-650 pt-4">
        <p className="text-xs uppercase tracking-widest text-muted mb-2">Structured request</p>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_9rem_auto] gap-2">
          <select value={requestedAction} onChange={(event) => setRequestedAction(event.target.value)} className="rounded-md border border-ink-650 bg-ink-950/60 px-3 py-2.5 text-sm text-paper focus:border-jade/60 focus:outline-none">
            <option value="review">Review position</option><option value="supply">Supply collateral</option><option value="borrow">Borrow</option><option value="repay">Repay debt</option><option value="withdraw">Withdraw collateral</option>
          </select>
          <input value={requestedAmount} onChange={(event) => setRequestedAmount(event.target.value)} type="number" min="0" step="any" placeholder={requestedAction === "borrow" || requestedAction === "repay" ? "USDC amount" : "mCOL amount"} className="rounded-md border border-ink-650 bg-ink-950/60 px-3 py-2.5 text-sm text-paper placeholder:text-muted focus:border-jade/60 focus:outline-none" />
          <button onClick={runRequestedAction} disabled={running} className="rounded-md border border-ink-650 bg-ink-750 px-4 py-2.5 text-sm text-paper-dim hover:border-jade/50 hover:text-jade disabled:opacity-40">Request action</button>
        </div>
        <p className="text-xs text-muted mt-2">The amount is a request, not authorization. Cadence checks balances, cooldowns, limits, and health impact before submitting.</p>
      </div>
      {result && (
        <div className="mt-4 border-t border-ink-650 pt-3 text-xs">
          <div className="flex items-center justify-between gap-3"><p className={`uppercase tracking-widest ${statusColor}`}>{status}</p><span className="text-muted">{outcome?.decision?.action ?? ""}</span></div>
          {outcome?.decision?.rationale && <p className="reasoning-voice text-sm mt-2">{outcome.decision.rationale}</p>}
          {outcome?.txHashOrUserOpHash && <p className="font-mono text-muted mt-2 break-all">{status === "submitted" ? "UserOperation pending" : "Transaction"}: {outcome.txHashOrUserOpHash}</p>}
          {(outcome?.error || result.error) && <p className="text-clay mt-2">{outcome?.error ?? result.error}</p>}
        </div>
      )}
    </section>
  );
}
