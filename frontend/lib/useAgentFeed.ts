"use client";

import { useEffect, useState, useCallback } from "react";
import { usePublicClient } from "wagmi";
import { getAbiItem, decodeEventLog, type Log, type AbiEvent, type PublicClient } from "viem";
import { ABIS, CONTRACTS } from "@/lib/contracts";
import { useResolvedAgentAccount } from "@/lib/useResolvedAgentAccount";

export type FeedEntry = {
  blockNumber: bigint;
  timestamp: number | null;
  txHash: string;
  target: string;
  selector: string;
  amount: bigint;
  value: bigint;
};

export type FeedError = { message: string; technical: string };

const actionExecutedEvent = getAbiItem({
  abi: ABIS.agentAccount,
  name: "ActionExecuted",
}) as AbiEvent | undefined;

// Conservative under most RPC providers' per-call block-range cap (Arc's
// testnet RPC currently enforces 100,000 — this stays comfortably under
// that so a single provider quirk doesn't force a full rewrite). Logs are
// fetched in chunks of this size rather than one unbounded
// deployBlock->latest call, which is what actually broke on a chain a
// meaningful number of blocks old with NEXT_PUBLIC_DEPLOY_BLOCK unset.
const LOG_CHUNK_SIZE = 90_000n;
// Hard ceiling on how many chunks a single load() will walk, so a
// misconfigured deployBlock (e.g. left at 0 on a long-lived chain) fails
// fast with a clear message instead of hammering the RPC indefinitely.
const MAX_CHUNKS = 50;

async function getLogsChunked(
  publicClient: PublicClient,
  address: `0x${string}`,
  event: AbiEvent,
  fromBlock: bigint
): Promise<Log[]> {
  const latest = await publicClient.getBlockNumber();
  const allLogs: Log[] = [];

  let start = fromBlock;
  let chunks = 0;
  while (start <= latest) {
    if (chunks >= MAX_CHUNKS) {
      throw new Error(
        `Scanned ${MAX_CHUNKS * Number(LOG_CHUNK_SIZE)} blocks without reaching the chain tip — set NEXT_PUBLIC_DEPLOY_BLOCK to the block AgentAccount was actually deployed at to narrow this.`
      );
    }
    const end = start + LOG_CHUNK_SIZE > latest ? latest : start + LOG_CHUNK_SIZE;
    const logs = await publicClient.getLogs({ address, event, fromBlock: start, toBlock: end });
    allLogs.push(...logs);
    start = end + 1n;
    chunks += 1;
  }

  return allLogs;
}

/**
 * Reads real ActionExecuted events emitted by the deployed AgentAccount —
 * this is the on-chain half of the "perceive -> reason -> act" loop made
 * visible: every entry here is a verified, already-settled transaction,
 * not a prediction or a mocked feed.
 *
 * The reasoning trace that led to each action (Phase 3: the LLM's
 * chain-of-thought) is intentionally NOT synthesized here — it isn't
 * on-chain data, and inventing placeholder text would blur the line this
 * whole UI exists to keep sharp: italic reasoning-voice text is reserved
 * for the model's actual words once Phase 3 wires them in.
 */
export function useAgentFeed() {
  const publicClient = usePublicClient();
  const { agentAccount } = useResolvedAgentAccount();
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<FeedError | null>(null);

  const load = useCallback(async () => {
    if (!publicClient || !agentAccount || !actionExecutedEvent) return;
    setIsLoading(true);
    setError(null);
    try {
      const logs = await getLogsChunked(
        publicClient,
        agentAccount,
        actionExecutedEvent,
        CONTRACTS.deployBlock
      );

      const decoded = await Promise.all(
        logs.map(async (log: Log) => {
          const parsed = decodeEventLog({
            abi: ABIS.agentAccount,
            data: log.data,
            topics: log.topics,
          });
          const args = parsed.args as unknown as { target: string; selector: string; amount: bigint; value: bigint };

          let timestamp: number | null = null;
          try {
            const block = await publicClient.getBlock({ blockNumber: log.blockNumber! });
            timestamp = Number(block.timestamp) * 1000;
          } catch {
            // Non-fatal — block pruned or RPC limitation; entry still
            // renders, just without a resolved timestamp.
          }

          return {
            blockNumber: log.blockNumber!,
            timestamp,
            txHash: log.transactionHash!,
            target: args.target,
            selector: args.selector,
            amount: args.amount,
            value: args.value,
          } satisfies FeedEntry;
        })
      );

      decoded.sort((a, b) => Number(b.blockNumber - a.blockNumber));
      setEntries(decoded);
    } catch (e) {
      const technical = e instanceof Error ? e.message : String(e);
      setError({ message: friendlyMessage(technical), technical });
    } finally {
      setIsLoading(false);
    }
  }, [publicClient, agentAccount]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount pattern: load() is async and its setState calls happen after the first await (RPC round-trip), not synchronously within this effect body.
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return { entries, isLoading, error, reload: load, enabled: Boolean(agentAccount) };
}

function friendlyMessage(technical: string): string {
  if (technical.includes("max block range") || technical.includes("MAX_CHUNKS")) {
    return "Couldn't load history — the block range scanned was too large for this RPC. Set NEXT_PUBLIC_DEPLOY_BLOCK in .env.local to narrow it.";
  }
  if (technical.includes("fetch") || technical.includes("network") || technical.includes("Failed to fetch")) {
    return "Couldn't reach the RPC endpoint. Check NEXT_PUBLIC_RPC_URL and your network connection.";
  }
  return `Couldn't load the agent's on-chain history: ${technical.slice(0, 180)}`;
}
