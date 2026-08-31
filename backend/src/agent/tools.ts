import type { PublicClient } from "viem";
import type { CadenceConfig } from "../config.js";
import { readPositionState, selectorFor, type PositionState, type ActionName } from "../chain/state.js";
import { ABIS } from "../chain/abis.js";

/** Tool schemas in the shape both Groq and Cerebras expect (OpenAI-style
 *  function-calling / tools API). Every tool here is read-only — the
 *  reasoning loop can look, but the only way it can act is by returning
 *  its final structured decision (see decision.ts), which the
 *  orchestration layer (decide.ts) independently validates against
 *  PolicyModule before anything is ever signed. */
export const TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "get_position_state",
      description:
        "Returns the agent's current LendingPool position: collateral amount, debt amount, health factor, current collateral price in USDC, and the pool's available USDC liquidity to borrow against.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_policy_limits",
      description:
        "Returns the on-chain PolicyModule rules that bound every action this agent may take: which actions are allowed, the max amount per call for each, and the cooldown window between actions (plus when the cooldown next clears, if currently active).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "simulate_action",
      description:
        "Checks (without executing) whether a specific action would currently be allowed by PolicyModule — use this before finalizing a decision to avoid proposing an action that will be rejected on-chain.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["supply", "borrow", "repay", "withdraw"] },
          amount: {
            type: "string",
            description:
              'Base-unit integer amount as a string, e.g. "1000000" for 1 USDC (6 decimals) or "1000000000000000000" for 1 collateral token (18 decimals).',
          },
        },
        required: ["action", "amount"],
      },
    },
  },
] as const;

export type ToolContext = { publicClient: PublicClient; cfg: CadenceConfig };

/** Cache the perceive-step read within a single reasoning cycle so
 *  multiple tool calls in the same round don't each re-hit the chain —
 *  still a fresh read per cycle (not stale across cycles). */
export function makeToolExecutor(ctx: ToolContext) {
  let cachedState: PositionState | null = null;

  async function getState(): Promise<PositionState> {
    if (!cachedState) cachedState = await readPositionState(ctx.publicClient, ctx.cfg);
    return cachedState;
  }

  return async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "get_position_state": {
        const s = await getState();
        return JSON.stringify({
          collateralAmount: s.collateralAmount.toString(),
          debtAmount: s.debtAmount.toString(),
          healthFactor:
            s.healthFactor === (1n << 256n) - 1n ? "infinite (no debt)" : (Number(s.healthFactor) / 1e18).toFixed(4),
          collateralPriceUsdc: (Number(s.collateralPrice) / 1e18).toFixed(2),
          poolLiquidityUsdc: (Number(s.poolLiquidity) / 1e6).toFixed(2),
        });
      }
      case "get_policy_limits": {
        const s = await getState();
        return JSON.stringify({
          rules: s.policy.map((p) => ({
            action: p.action,
            allowed: p.allowed,
            maxAmountPerCall: p.maxAmountPerCall === 0n ? "uncapped" : p.maxAmountPerCall.toString(),
          })),
          cooldownSeconds: s.cooldownSeconds.toString(),
          cooldownReadyAt: s.cooldownReadyAt ? new Date(Number(s.cooldownReadyAt) * 1000).toISOString() : "ready now",
        });
      }
      case "simulate_action": {
        const action = args.action as ActionName;
        const amount = BigInt((args.amount as string) ?? "0");
        const allowed = (await ctx.publicClient.readContract({
          address: ctx.cfg.POLICY_MODULE,
          abi: ABIS.policyModule,
          functionName: "wouldAllow",
          args: [ctx.cfg.AGENT_ACCOUNT, ctx.cfg.LENDING_POOL, selectorFor(action), amount],
        })) as readonly [boolean, string];
        return JSON.stringify({ allowed: allowed[0], reason: allowed[1] || null });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  };
}
