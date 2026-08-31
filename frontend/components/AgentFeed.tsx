"use client";

import { useEffect, useState } from "react";
import { useAgentFeed } from "@/lib/useAgentFeed";
import type { FeedError } from "@/lib/useAgentFeed";
import { formatAmount, shortAddress, shortTxHash, selectorFor } from "@/lib/format";
import { AGENT_ACTIONS } from "@/lib/contracts";
import { EmptyState } from "./PositionVitals";

// Selector -> display label lookup, derived from the same AGENT_ACTIONS
// list the rest of the app uses, so labels can't drift out of sync with
// a second hardcoded copy.
const SELECTOR_LABELS: Record<string, { label: string; unit: string; decimals: number }> = Object.fromEntries(
  AGENT_ACTIONS.map((action) => [
    selectorFor(action.signature),
    { label: action.label, unit: action.unit, decimals: action.unit === "USDC" ? 6 : 18 },
  ])
);

export function AgentFeed() {
  const { entries, isLoading, error, reload, enabled } = useAgentFeed();

  useEffect(() => {
    const refresh = () => void reload();
    window.addEventListener("cadence:cycle-complete", refresh);
    return () => window.removeEventListener("cadence:cycle-complete", refresh);
  }, [reload]);

  return (
    <section className="rounded-lg border border-ink-650 bg-ink-850 p-5 flex-1 min-w-0">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xs uppercase tracking-widest text-muted">Live Agent Feed</h2>
        {enabled && (
          <button
            onClick={reload}
            disabled={isLoading}
            className="text-xs text-muted hover:text-jade transition-colors disabled:opacity-50"
          >
            {isLoading ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>
      <p className="text-xs text-muted mb-5">
        Every entry is a settled on-chain transaction — not a prediction.
      </p>

      {!enabled ? (
        <EmptyState message="Set NEXT_PUBLIC_AGENT_ACCOUNT to load the agent's on-chain action history." />
      ) : error ? (
        <ErrorState error={error} />
      ) : entries.length === 0 ? (
        <EmptyState message={isLoading ? "Loading on-chain history…" : "No actions recorded yet. Once the agent executes its first UserOperation, it appears here."} />
      ) : (
        <ol className="space-y-0">
          {entries.map((entry, i) => {
            const info = SELECTOR_LABELS[entry.selector];
            return (
              <li
                key={`${entry.txHash}-${i}`}
                className="py-4 border-b border-ink-650 last:border-b-0"
              >
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <span className="text-sm text-paper font-medium">
                    {info?.label ?? "Contract call"}
                    {info && entry.amount > 0n ? (
                      <span className="font-mono tabular text-brass">
                        {" "}
                        {formatAmount(entry.amount, info.decimals)} {info.unit}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted font-mono tabular whitespace-nowrap">
                    {entry.timestamp ? (
                      <time dateTime={new Date(entry.timestamp).toISOString()} suppressHydrationWarning>
                        {new Date(entry.timestamp).toLocaleString()}
                      </time>
                    ) : `block ${entry.blockNumber}`}
                  </span>
                </div>

                <p className="reasoning-voice text-sm mb-2">
                  Reasoning trace connects here once Phase 3&apos;s agent backend is wired in — this entry
                  currently reflects the verified on-chain outcome only.
                </p>

                <div className="flex items-center gap-3 text-xs font-mono tabular">
                  <span className="text-muted">target {shortAddress(entry.target)}</span>
                  <a
                    href={`${arcExplorerBase()}/tx/${entry.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-jade hover:underline"
                  >
                    {shortTxHash(entry.txHash)} ↗
                  </a>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function arcExplorerBase(): string {
  return "https://testnet.arcscan.app";
}

function ErrorState({ error }: { error: FeedError }) {
  const [showTechnical, setShowTechnical] = useState(false);

  return (
    <div className="rounded-md border border-clay/30 bg-clay-dim p-4">
      <p className="text-sm text-clay">{error.message}</p>
      <button
        onClick={() => setShowTechnical((v) => !v)}
        className="text-xs text-muted hover:text-paper-dim mt-2 underline decoration-dotted"
      >
        {showTechnical ? "Hide" : "Show"} technical details
      </button>
      {showTechnical && (
        <pre className="text-xs text-muted mt-2 whitespace-pre-wrap break-all font-mono bg-ink-950/60 rounded p-2">
          {error.technical}
        </pre>
      )}
    </div>
  );
}
