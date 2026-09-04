"use client";

import { useEffect, useState } from "react";
import { useAgentFeed } from "@/lib/useAgentFeed";
import { formatAmount, shortTxHash } from "@/lib/format";

type Entry = {
  cycleId?: string;
  at: string;
  outcome: {
    status: string;
    error?: string;
    reason?: string;
    decision?: { action?: string; amount?: string; rationale?: string };
    txHashOrUserOpHash?: string;
  };
};

export function ActivityTimeline() {
  const [items, setItems] = useState<Entry[]>([]);
  const { entries: chainEntries } = useAgentFeed();

  async function load() {
    try {
      const response = await fetch("/api/agent/status", { cache: "no-store" });
      if (response.ok) setItems((await response.json()).history ?? []);
    } catch { /* status panel reports backend availability */ }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="rounded-xl border border-ink-650 bg-ink-850 p-5 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <div><h2 className="text-xs uppercase tracking-widest text-muted">Decision history</h2><p className="text-sm text-paper-dim mt-1">Every monitoring cycle, including safe holds and policy blocks.</p></div>
        <span className="text-xs text-muted">{items.length} recent</span>
      </div>
      {items.length === 0 ? <p className="text-sm text-muted">Cadence has not completed a monitoring cycle yet.</p> : (
        <ol className="space-y-3">
          {items.slice(0, 8).map((item, index) => {
            const outcome = item.outcome;
            const action = outcome.decision?.action;
            const tone = outcome.status === "executed" ? "text-jade" : outcome.status === "error" || outcome.status === "failed" || outcome.status === "blocked" ? "text-clay" : "text-brass";
            return <li key={`${item.at}-${index}`} className="flex gap-3 border-b border-ink-650 pb-3 last:border-0 last:pb-0">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${outcome.status === "executed" ? "bg-jade" : outcome.status === "error" || outcome.status === "blocked" ? "bg-clay" : "bg-brass"}`} />
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><span className={`text-xs uppercase tracking-widest break-words ${tone}`}>{outcome.status}{action && action !== "hold" ? ` · ${action}` : ""}</span><time className="text-xs text-muted" dateTime={item.at}>{new Date(item.at).toLocaleString()}</time></div>
                {outcome.decision?.rationale && <p className="reasoning-voice text-sm mt-1">{outcome.decision.rationale}</p>}
                {outcome.reason && <p className="text-xs text-clay mt-1">{outcome.reason}</p>}
                {outcome.error && <p className="text-xs text-clay mt-1 break-words">{outcome.error}</p>}
                {outcome.txHashOrUserOpHash && <a href={`https://testnet.arcscan.app/tx/${outcome.txHashOrUserOpHash}`} target="_blank" rel="noreferrer" className="inline-block font-mono text-xs text-jade mt-2 hover:underline">{outcome.status === "submitted" ? "View pending UserOperation" : "View confirmed transaction"} {shortTxHash(outcome.txHashOrUserOpHash)} ↗</a>}
              </div>
            </li>;
          })}
        </ol>
      )}
      {chainEntries.length > 0 && (
        <div className="mt-5 border-t border-ink-650 pt-4">
          <p className="text-xs uppercase tracking-widest text-jade mb-3">Verified on-chain actions</p>
          <ol className="space-y-3">
            {chainEntries.slice(0, 8).map((entry) => (
              <li key={entry.txHash} className="flex gap-3">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-jade" />
                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><span className="text-sm text-paper">Action confirmed</span><span className="text-xs text-muted">block {entry.blockNumber.toString()}</span></div><p className="text-xs text-paper-dim mt-1">{entry.amount > 0n ? formatAmount(entry.amount, 18) : "Contract call"}</p><a href={`https://testnet.arcscan.app/tx/${entry.txHash}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-jade hover:underline break-all">{shortTxHash(entry.txHash)}</a></div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
