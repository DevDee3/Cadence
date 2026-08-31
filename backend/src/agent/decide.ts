import type { Clients } from "../chain/client.js";
import type { CadenceConfig } from "../config.js";
import { ABIS } from "../chain/abis.js";
import { selectorFor, type ActionName } from "../chain/state.js";
import { buildActionCall, buildApproveCall, buildExecuteCalldata, buildExecuteBatchCalldata } from "../chain/actions.js";
import { buildSignAndSubmit } from "../chain/userOp.js";
import { runReasoningLoop } from "./reasoning.js";
import type { LLMClient } from "./llm.js";
import type { Decision } from "./decision.js";

export type CycleOutcome =
  | { status: "held"; decision: Decision; rounds: number }
  | { status: "blocked"; decision: Decision; rounds: number; reason: string }
  | { status: "executed"; decision: Decision; rounds: number; txHashOrUserOpHash: `0x${string}` }
  | { status: "submitted"; decision: Decision; rounds: number; txHashOrUserOpHash: `0x${string}` }
  | { status: "failed"; decision: Decision; rounds: number; txHashOrUserOpHash: `0x${string}`; error: string }
  | { status: "reasoning_failed"; error: string; rounds: number };

const ACTIONS_NEEDING_APPROVAL: ReadonlySet<ActionName> = new Set(["supply", "repay"]);

/**
 * Runs one full cycle: perceive (inside the reasoning loop's tools) ->
 * reason (bounded rounds) -> independently re-check the decision against
 * PolicyModule server-side (defense in depth — the on-chain check in
 * AgentAccount.execute()/PolicyModule.checkAndConsume() is the real
 * security boundary regardless, but failing fast here avoids burning gas
 * on a doomed UserOperation) -> act (build, sign, submit).
 */
export async function runCycle(clients: Clients, cfg: CadenceConfig, llm: LLMClient, instruction?: string): Promise<CycleOutcome> {
  const outcome = await runReasoningLoop(llm, { publicClient: clients.publicClient, cfg }, cfg.MAX_REASONING_ROUNDS, instruction);

  if (!outcome.ok) {
    return { status: "reasoning_failed", error: outcome.error, rounds: outcome.rounds };
  }

  const { decision, rounds } = outcome;

  if (decision.action === "hold") {
    return { status: "held", decision, rounds };
  }

  const amount = BigInt(decision.amount);
  const action = decision.action as ActionName;

  const precheck = (await clients.publicClient.readContract({
    address: cfg.POLICY_MODULE,
    abi: ABIS.policyModule,
    functionName: "wouldAllow",
    args: [cfg.AGENT_ACCOUNT, cfg.LENDING_POOL, selectorFor(action), amount],
  })) as readonly [boolean, string];

  if (!precheck[0]) {
    return { status: "blocked", decision, rounds, reason: precheck[1] || "rejected by PolicyModule" };
  }

  const actionCall = buildActionCall(action, cfg.LENDING_POOL, amount);

  let callData: `0x${string}`;
  if (ACTIONS_NEEDING_APPROVAL.has(action)) {
    const tokenAddress = action === "supply" ? cfg.COLLATERAL_TOKEN : cfg.DEBT_TOKEN;
    const approveCall = buildApproveCall(tokenAddress, cfg.LENDING_POOL, amount);
    callData = buildExecuteBatchCalldata([approveCall, actionCall]);
  } else {
    callData = buildExecuteCalldata(actionCall);
  }

  const { txHashOrUserOpHash, confirmed } = await buildSignAndSubmit(
    cfg,
    clients.publicClient,
    clients.agentAccount,
    clients.relayerClient,
    callData
  );

  return { status: confirmed ? "executed" : "submitted", decision, rounds, txHashOrUserOpHash };
}
