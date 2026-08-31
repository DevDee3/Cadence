"use client";

import { StatusHeader } from "@/components/StatusHeader";
import { VitalsWaveform } from "@/components/VitalsWaveform";
import { PositionVitals } from "@/components/PositionVitals";
import { PolicyPanel } from "@/components/PolicyPanel";
import { useAgentFeed } from "@/lib/useAgentFeed";
import { useHealthFactorHistory } from "@/lib/hooks";
import { isConfigured } from "@/lib/contracts";
import { AgentControls } from "@/components/AgentControls";
import { PositionSetup } from "@/components/PositionSetup";
import { StrategySettings } from "@/components/StrategySettings";
import { ActivityTimeline } from "@/components/ActivityTimeline";

export default function Home() {
  const { entries } = useAgentFeed();
  const vitalsSamples = useHealthFactorHistory(entries);

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <StatusHeader />

      <div className="mt-6">
        <VitalsWaveform samples={vitalsSamples} />
      </div>

      <div className="mt-6">
        <AgentControls />
      </div>

      <div className="mt-6">
        <PositionSetup />
      </div>

      <div className="mt-6">
        <StrategySettings />
      </div>

      {!isConfigured && (
        <p className="text-xs text-muted mt-3 leading-relaxed">
          Running unconfigured — copy <code className="text-brass">.env.example</code> to{" "}
          <code className="text-brass">.env.local</code> and fill in addresses from Phase 1&apos;s
          Deploy.s.sol + ConfigureAgent.s.sol output to see live data.
        </p>
      )}

      <div className="mt-8 flex flex-col lg:flex-row gap-6 items-start">
        <ActivityTimeline />

        <div className="w-full lg:w-80 shrink-0 flex flex-col gap-6">
          <PositionVitals />
          <PolicyPanel />
        </div>
      </div>

      <footer className="mt-10 pt-6 border-t border-ink-650 text-xs text-muted">
        Cadence — Autonomous DeFi position management on Arc Testnet.
      </footer>
    </div>
  );
}
