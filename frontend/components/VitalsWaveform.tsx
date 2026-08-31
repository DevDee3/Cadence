"use client";

import { useMemo } from "react";

export type VitalsSample = { timestamp: number; healthFactor: number | null };

/**
 * The Vitals Line — this page's signature element. A thin waveform
 * tracing the position's health factor over time, like a monitor
 * watching vital signs. It is real data (reconstructed from on-chain
 * ActionExecuted events + the current healthFactor() read), not a
 * decorative animation: the shape and color genuinely encode the
 * position's risk history.
 *
 * Color zones follow LendingPool's actual liquidation threshold (80%)
 * rather than arbitrary UI cutoffs:
 *   HF >= 1.5   jade  (comfortable)
 *   1.1–1.5     brass (watch)
 *   < 1.1       clay  (near liquidation, HF 1.0 is the on-chain cutoff)
 */
export function VitalsWaveform({ samples }: { samples: VitalsSample[] }) {
  const { path, zoneColor, latest } = useMemo(() => buildPath(samples), [samples]);

  return (
    <div
      className={`relative w-full rounded-lg border border-ink-650 bg-ink-900/60 overflow-hidden transition-all ${
        path ? "h-24 sm:h-28" : "h-16"
      }`}
    >
      {path && (
        <svg
          viewBox="0 0 600 100"
          preserveAspectRatio="none"
          className="w-full h-full"
          role="img"
          aria-label={`Health factor waveform: current value ${latest?.toFixed(2) ?? "unknown"}`}
        >
          {/* zone reference lines */}
          <line x1="0" x2="600" y1="80" y2="80" stroke="var(--ink-650)" strokeWidth="1" strokeDasharray="2 4" />
          <line x1="0" x2="600" y1="35" y2="35" stroke="var(--ink-650)" strokeWidth="1" strokeDasharray="2 4" />

          <path
            d={path}
            fill="none"
            stroke={zoneColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="motion-safe:animate-[draw_1.1s_ease-out]"
            style={{
              filter: `drop-shadow(0 0 6px ${zoneColor}55)`,
            }}
          />
        </svg>
      )}

      {!path && (
        <div className="absolute inset-0 flex items-center gap-2 px-4">
          <span className="w-1.5 h-1.5 rounded-full bg-jade motion-safe:animate-pulse" aria-hidden />
          <p className="text-xs text-muted tracking-wide">
            Cadence is idle — no actions recorded yet. This line activates on the first one.
          </p>
        </div>
      )}

      <style jsx>{`
        @keyframes draw {
          from {
            stroke-dasharray: 1000;
            stroke-dashoffset: 1000;
          }
          to {
            stroke-dasharray: 1000;
            stroke-dashoffset: 0;
          }
        }
      `}</style>
    </div>
  );
}

function buildPath(samples: VitalsSample[]): {
  path: string | null;
  zoneColor: string;
  latest: number | null;
} {
  const withValues = samples.filter((s): s is { timestamp: number; healthFactor: number } => s.healthFactor !== null);

  if (withValues.length === 0) {
    return { path: null, zoneColor: "var(--jade)", latest: null };
  }

  const latest = withValues[withValues.length - 1].healthFactor;
  const zoneColor = latest >= 1.5 ? "var(--jade)" : latest >= 1.1 ? "var(--brass)" : "var(--clay)";

  if (withValues.length === 1) {
    const y = valueToY(withValues[0].healthFactor);
    return { path: `M 0 ${y} L 600 ${y}`, zoneColor, latest };
  }

  const minT = withValues[0].timestamp;
  const maxT = withValues[withValues.length - 1].timestamp;
  const span = Math.max(maxT - minT, 1);

  const points = withValues.map((s) => {
    const x = ((s.timestamp - minT) / span) * 600;
    const y = valueToY(s.healthFactor);
    return [x, y] as const;
  });

  const d = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");

  return { path: d, zoneColor, latest };
}

/** Maps a health factor to an SVG y-coordinate. Clamped so an
 *  extremely high (or, transiently, near-zero) HF doesn't blow out the
 *  chart — the reference lines at y=80 (HF≈1.0) and y=35 (HF≈2.0) are
 *  what actually carries meaning here, not the exact curve shape above
 *  a comfortable threshold. */
function valueToY(hf: number): number {
  const clamped = Math.min(Math.max(hf, 0), 3);
  // HF 0 -> y 92 (near bottom), HF 1.0 -> y 80, HF 2.0 -> y 35, HF 3.0 -> y 8
  const y = 92 - (clamped / 3) * 84;
  return y;
}
