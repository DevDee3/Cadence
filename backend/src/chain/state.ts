import type { PublicClient } from "viem";
import { toFunctionSelector } from "viem";
import { ABIS } from "./abis.js";
import type { CadenceConfig } from "../config.js";

export const AGENT_ACTIONS = [
  { name: "supply", label: "Supply collateral", signature: "supplyCollateral(uint256)", asset: "collateral" as const },
  { name: "borrow", label: "Borrow", signature: "borrow(uint256)", asset: "debt" as const },
  { name: "repay", label: "Repay", signature: "repay(uint256)", asset: "debt" as const },
  { name: "withdraw", label: "Withdraw collateral", signature: "withdrawCollateral(uint256)", asset: "collateral" as const },
] as const;

export type ActionName = (typeof AGENT_ACTIONS)[number]["name"];

export function selectorFor(actionName: ActionName): `0x${string}` {
  const action = AGENT_ACTIONS.find((a) => a.name === actionName)!;
  return toFunctionSelector(action.signature);
}

export type PolicyLimit = {
  action: ActionName;
  allowed: boolean;
  maxAmountPerCall: bigint; // 0 == uncapped
};

export type PositionState = {
  collateralAmount: bigint;
  debtAmount: bigint;
  healthFactor: bigint; // 1e18 precision; type(uint256).max == no debt
  collateralPrice: bigint; // USDC terms, 1e18 precision
  poolLiquidity: bigint; // debt-asset balance available to borrow
  policy: PolicyLimit[];
  cooldownSeconds: bigint;
  cooldownReadyAt: bigint | null; // unix seconds the next action becomes allowed, or null if ready now
};

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * The agent's "perceive" step — a single bounded read pass gathering
 * exactly the state the reasoning loop needs to decide an action. No
 * writes happen here; this mirrors the read-only-tools discipline this
 * portfolio's AegisX project used for its Claude tool-use agent.
 */
export async function readPositionState(
  publicClient: PublicClient,
  cfg: CadenceConfig
): Promise<PositionState> {
  const [position, healthFactor, collateralPrice, poolLiquidity, cooldownSeconds, lastActionAt] =
    await Promise.all([
      publicClient.readContract({
        address: cfg.LENDING_POOL,
        abi: ABIS.lendingPool,
        functionName: "positions",
        args: [cfg.AGENT_ACCOUNT],
      }) as Promise<readonly [bigint, bigint]>,
      publicClient.readContract({
        address: cfg.LENDING_POOL,
        abi: ABIS.lendingPool,
        functionName: "healthFactor",
        args: [cfg.AGENT_ACCOUNT],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: cfg.PRICE_ORACLE,
        abi: ABIS.priceOracle,
        functionName: "getPrice",
        args: [cfg.COLLATERAL_TOKEN],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: cfg.DEBT_TOKEN,
        abi: [
          {
            type: "function",
            name: "balanceOf",
            inputs: [{ name: "account", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view",
          },
        ],
        functionName: "balanceOf",
        args: [cfg.LENDING_POOL],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: cfg.POLICY_MODULE,
        abi: ABIS.policyModule,
        functionName: "cooldownSeconds",
        args: [cfg.AGENT_ACCOUNT],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: cfg.POLICY_MODULE,
        abi: ABIS.policyModule,
        functionName: "lastActionAt",
        args: [cfg.AGENT_ACCOUNT],
      }) as Promise<bigint>,
    ]);

  const policy = await Promise.all(
    AGENT_ACTIONS.map(async (action) => {
      const rule = (await publicClient.readContract({
        address: cfg.POLICY_MODULE,
        abi: ABIS.policyModule,
        functionName: "rules",
        args: [cfg.AGENT_ACCOUNT, cfg.LENDING_POOL, selectorFor(action.name)],
      })) as readonly [boolean, bigint];

      return { action: action.name, allowed: rule[0], maxAmountPerCall: rule[1] } satisfies PolicyLimit;
    })
  );

  const cooldownReadyAt =
    cooldownSeconds === 0n || lastActionAt === 0n ? null : lastActionAt + cooldownSeconds;

  return {
    collateralAmount: position[0],
    debtAmount: position[1],
    healthFactor,
    collateralPrice,
    poolLiquidity,
    policy,
    cooldownSeconds,
    cooldownReadyAt,
  };
}

export function isInfiniteHealth(hf: bigint): boolean {
  return hf === UINT256_MAX;
}
