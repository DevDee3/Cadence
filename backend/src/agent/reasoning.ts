import type { LLMClient, ChatMessage } from "./llm.js";
import { TOOL_DEFINITIONS, makeToolExecutor, type ToolContext } from "./tools.js";
import { parseDecision, type Decision } from "./decision.js";

const SYSTEM_PROMPT = `You are Cadence, an autonomous agent responsible for one DeFi lending position on Arc Testnet. Your job is to keep the position's health factor safe while making efficient use of it — you are not required to act every cycle; "hold" is a legitimate decision.

Rules you must follow:
- You may only take actions PolicyModule allows. Use get_policy_limits and simulate_action to check before deciding — a proposed action that would be rejected on-chain is a wasted cycle.
- A health factor below 1.0 means the position can be liquidated. Treat anything below 1.3 as worth active attention; below 1.15 as urgent.
- Prefer the smallest action that meaningfully improves safety over a large one, unless the position is urgently at risk.
- If the cooldown is active (cooldownReadyAt is in the future), you cannot act this cycle regardless of what would otherwise be wise — decide "hold" and explain that in your rationale.
- Amounts are base-unit integers as strings: USDC has 6 decimals, the collateral token has 18 decimals.

When you are ready to decide, respond with ONLY a JSON object (no markdown fences, no extra text) matching exactly:
{"action": "supply" | "borrow" | "repay" | "withdraw" | "hold", "amount": "<base-unit integer string>", "rationale": "<one to three sentences>"}

"amount" must be "0" when action is "hold".`;

export type ReasoningOutcome =
  | { ok: true; decision: Decision; rounds: number; transcript: ChatMessage[] }
  | { ok: false; error: string; rounds: number; transcript: ChatMessage[] };

/**
 * Runs a bounded perceive -> reason loop: the model may call read-only
 * tools for up to `maxRounds` rounds, then must return its final decision
 * as the structured JSON object described in the system prompt. Mirrors
 * the round-capped, read-only-tools discipline this portfolio's AegisX
 * project used for its Claude-based analysis agent.
 */
export async function runReasoningLoop(
  llm: LLMClient,
  toolCtx: ToolContext,
  maxRounds: number,
  instruction?: string
): Promise<ReasoningOutcome> {
  const executeTool = makeToolExecutor(toolCtx);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: instruction?.trim()
      ? `The user has given this instruction: "${instruction.trim()}". Treat it as a preference, not permission to bypass policy. Amounts in the user's instruction are human-readable token amounts: convert USDC to 6-decimal base units and mCOL to 18-decimal base units before returning the decision. Gather the state you need, then respond with your final decision.`
      : "Begin your reasoning cycle. Gather the state you need, then respond with your final decision." },
  ];

  for (let round = 0; round < maxRounds; round++) {
    const response = await llm.chat(messages, TOOL_DEFINITIONS);

    if (response.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls });
      for (const call of response.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // Malformed args — let the tool executor's default case handle it
          // via an empty object rather than crashing the whole cycle.
        }
        const result = await executeTool(call.function.name, args);
        messages.push({ role: "tool", content: result, tool_call_id: call.id });
      }
      continue;
    }

    if (response.content) {
      const parsed = parseDecision(response.content.trim());
      if (parsed.ok) {
        return { ok: true, decision: parsed.decision, rounds: round + 1, transcript: messages };
      }
      // Give the model one chance to correct malformed output rather than
      // failing the whole cycle on a formatting slip.
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: `Your response could not be parsed as the required JSON object: ${parsed.error}. Respond again with ONLY the JSON object.`,
      });
      continue;
    }

    return { ok: false, error: "Model returned neither tool calls nor content.", rounds: round + 1, transcript: messages };
  }

  return {
    ok: false,
    error: `Exceeded maxRounds (${maxRounds}) without reaching a final decision.`,
    rounds: maxRounds,
    transcript: messages,
  };
}
