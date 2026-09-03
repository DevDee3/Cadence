"use client";

import { usePolicyRules } from "@/lib/hooks";
import { formatAmount } from "@/lib/format";
import { EmptyState } from "./PositionVitals";
import { useAccount } from "wagmi";

export function PolicyPanel() {
  const { enabled, isLoading, rules, cooldownSeconds } = usePolicyRules();
  const { isConnected } = useAccount();

  return (
    <section className="rounded-lg border border-ink-650 bg-ink-850 p-5">
      <h2 className="text-xs uppercase tracking-widest text-muted mb-1">Policy Limits</h2>
      <p className="text-xs text-muted mb-4">
        Enforced on-chain by PolicyModule — not a prompt instruction the agent could ignore.
      </p>

      {!enabled ? (
        <EmptyState message={isConnected
          ? "Verify your wallet and create an AgentAccount to view policy limits."
          : "Connect your wallet to view your policy limits."} />
      ) : (
        <ul className="space-y-2.5">
          {rules.map((rule) => (
            <li key={rule.signature} className="flex items-center justify-between text-sm">
              <span className="text-paper-dim">{rule.label}</span>
              <span className="font-mono tabular text-xs">
                {isLoading ? (
                  <span className="text-muted">—</span>
                ) : !rule.allowed ? (
                  <span className="text-clay">not allowed</span>
                ) : rule.maxAmountPerCall === 0n ? (
                  <span className="text-paper">uncapped</span>
                ) : (
                  <span className="text-paper">
                    ≤ {formatAmount(rule.maxAmountPerCall ?? 0n, rule.unit === "USDC" ? 6 : 18)} {rule.unit}
                  </span>
                )}
              </span>
            </li>
          ))}

          <li className="flex items-center justify-between text-sm pt-2.5 mt-1 border-t border-ink-650">
            <span className="text-paper-dim">Cooldown between actions</span>
            <span className="font-mono tabular text-xs text-paper">
              {isLoading || cooldownSeconds === undefined
                ? "—"
                : cooldownSeconds === 0n
                  ? "none"
                  : formatCooldown(cooldownSeconds)}
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}

function formatCooldown(seconds: bigint): string {
  const s = Number(seconds);
  if (s % 3600 === 0) return `${s / 3600} hr`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} sec`;
}
