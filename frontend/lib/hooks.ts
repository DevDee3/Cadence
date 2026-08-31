"use client";

import { useEffect, useState } from "react";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { ABIS, CONTRACTS, AGENT_ACTIONS } from "@/lib/contracts";
import { selectorFor } from "@/lib/format";
import type { FeedEntry } from "@/lib/useAgentFeed";
import type { VitalsSample } from "@/components/VitalsWaveform";
import { useResolvedAgentAccount } from "./useResolvedAgentAccount";

/** Live health factor + position size for the agent's LendingPool
 *  position. Real reads via wagmi's useReadContract — this is the same
 *  view function LendingPool.t.sol asserts against in Phase 1. */
export function usePositionVitals() {
  const { agentAccount } = useResolvedAgentAccount();
  const enabled = Boolean(CONTRACTS.lendingPool && agentAccount);

  const healthFactor = useReadContract({
    address: CONTRACTS.lendingPool,
    abi: ABIS.lendingPool,
    functionName: "healthFactor",
    args: enabled ? [agentAccount!] : undefined,
    query: { enabled, refetchInterval: 15_000 },
  });

  const position = useReadContract({
    address: CONTRACTS.lendingPool,
    abi: ABIS.lendingPool,
    functionName: "positions",
    args: enabled ? [agentAccount!] : undefined,
    query: { enabled, refetchInterval: 15_000 },
  });

  return {
    enabled,
    isLoading: healthFactor.isLoading || position.isLoading,
    healthFactor: healthFactor.data as bigint | undefined,
    // LendingPool.positions() returns (uint256 collateralAmount, uint256 debtAmount)
    collateralAmount: (position.data as [bigint, bigint] | undefined)?.[0],
    debtAmount: (position.data as [bigint, bigint] | undefined)?.[1],
    refetch: () => {
      healthFactor.refetch();
      position.refetch();
    },
  };
}

/** Live policy rules for the four actions ConfigureAgent.s.sol allowlists,
 *  plus the account's cooldown window — read directly from PolicyModule,
 *  not hardcoded, so the panel always reflects what's actually enforced
 *  on-chain rather than what the deploy script was told to set. */
export function usePolicyRules() {
  const { agentAccount } = useResolvedAgentAccount();
  const enabled = Boolean(CONTRACTS.policyModule && agentAccount && CONTRACTS.lendingPool);

  const ruleContracts = AGENT_ACTIONS.map((action) => ({
    address: CONTRACTS.policyModule,
    abi: ABIS.policyModule,
    functionName: "rules" as const,
    args: enabled ? [agentAccount!, CONTRACTS.lendingPool!, selectorFor(action.signature)] : undefined,
  }));

  const rules = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: (enabled ? ruleContracts : []) as any,
    query: { enabled, refetchInterval: 30_000 },
  });

  const cooldown = useReadContract({
    address: CONTRACTS.policyModule,
    abi: ABIS.policyModule,
    functionName: "cooldownSeconds",
    args: enabled ? [agentAccount!] : undefined,
    query: { enabled, refetchInterval: 30_000 },
  });

  return {
    enabled,
    isLoading: rules.isLoading || cooldown.isLoading,
    rules: AGENT_ACTIONS.map((action, i) => {
      const result = rules.data?.[i]?.result as [boolean, bigint] | undefined;
      return {
        ...action,
        allowed: result?.[0] ?? false,
        maxAmountPerCall: result?.[1],
      };
    }),
    cooldownSeconds: cooldown.data as bigint | undefined,
  };
}

/**
 * Reconstructs a real health-factor history by reading
 * LendingPool.healthFactor(agent) at the block of each of the agent's
 * last N on-chain actions, plus the current value. These are genuine
 * historical `eth_call`s at pinned block numbers — not interpolation or
 * synthetic data — which is what feeds the Vitals Line waveform.
 *
 * Capped to the most recent 12 actions to keep RPC load reasonable for a
 * dashboard that polls periodically.
 */
export function useHealthFactorHistory(feedEntries: FeedEntry[]) {
  const publicClient = usePublicClient();
  const { agentAccount } = useResolvedAgentAccount();
  const [samples, setSamples] = useState<VitalsSample[]>([]);
  const enabled = Boolean(CONTRACTS.lendingPool && agentAccount);

  const current = useReadContract({
    address: CONTRACTS.lendingPool,
    abi: ABIS.lendingPool,
    functionName: "healthFactor",
    args: enabled ? [agentAccount!] : undefined,
    query: { enabled, refetchInterval: 15_000 },
  });

  useEffect(() => {
    if (!publicClient || !enabled) return;
    let cancelled = false;

    async function run() {
      const recent = [...feedEntries]
        .sort((a, b) => Number(a.blockNumber - b.blockNumber))
        .slice(-12);

      const historical = await Promise.all(
        recent.map(async (entry) => {
          try {
            const hf = (await publicClient!.readContract({
              address: CONTRACTS.lendingPool!,
              abi: ABIS.lendingPool,
              functionName: "healthFactor",
              args: [agentAccount!],
              blockNumber: entry.blockNumber,
            })) as bigint;
            return {
              timestamp: entry.timestamp ?? Number(entry.blockNumber),
              healthFactor: hfToNumber(hf),
            } satisfies VitalsSample;
          } catch {
            return { timestamp: entry.timestamp ?? Number(entry.blockNumber), healthFactor: null };
          }
        })
      );

      if (!cancelled) {
        const withCurrent =
          current.data !== undefined
            ? [...historical, { timestamp: Date.now(), healthFactor: hfToNumber(current.data as bigint) }]
            : historical;
        setSamples(withCurrent);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, enabled, agentAccount, feedEntries.length, current.data]);

  return samples;
}

function hfToNumber(hf: bigint): number | null {
  const UINT256_MAX = (1n << 256n) - 1n;
  if (hf === UINT256_MAX) return 3; // "infinite" health — clamp to the chart's visual ceiling
  return Number(hf) / 1e18;
}
