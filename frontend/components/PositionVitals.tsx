"use client";

import { usePositionVitals } from "@/lib/hooks";
import { formatAmount, formatHealthFactor } from "@/lib/format";
import { useAccount } from "wagmi";

export function PositionVitals() {
  const { enabled, isLoading, healthFactor, collateralAmount, debtAmount } = usePositionVitals();
  const { isConnected } = useAccount();

  const hfNumber = healthFactor !== undefined ? Number(healthFactor) / 1e18 : null;
  const zone =
    hfNumber === null ? "muted" : hfNumber >= 1.5 ? "jade" : hfNumber >= 1.1 ? "brass" : "clay";

  return (
    <section className="rounded-lg border border-ink-650 bg-ink-850 p-5">
      <h2 className="text-xs uppercase tracking-widest text-muted mb-4">Position Vitals</h2>

      {!enabled ? (
        <EmptyState message={isConnected
          ? "Verify your wallet and create an AgentAccount to view position data."
          : "Connect your wallet to view your position data."} />
      ) : (
        <dl className="space-y-4">
          <div>
            <dt className="text-xs text-muted mb-1">Health Factor</dt>
            <dd
              className={`font-mono tabular text-3xl ${
                zone === "jade" ? "text-jade" : zone === "brass" ? "text-brass" : zone === "clay" ? "text-clay" : "text-muted"
              }`}
            >
              {isLoading ? "—" : healthFactor !== undefined ? formatHealthFactor(healthFactor) : "—"}
            </dd>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-ink-650">
            <div>
              <dt className="text-xs text-muted mb-1">Collateral</dt>
              <dd className="font-mono tabular text-paper">
                {collateralAmount !== undefined ? formatAmount(collateralAmount, 18) : "—"}{" "}
                <span className="text-muted text-xs">mCOL</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted mb-1">Debt</dt>
              <dd className="font-mono tabular text-brass">
                {debtAmount !== undefined ? formatAmount(debtAmount, 6) : "—"}{" "}
                <span className="text-muted text-xs">USDC</span>
              </dd>
            </div>
          </div>
        </dl>
      )}
    </section>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="text-sm text-muted leading-relaxed">{message}</p>;
}
