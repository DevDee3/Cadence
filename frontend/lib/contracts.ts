import type { Address, Abi } from "viem";
import AgentAccountAbiJson from "./abis/AgentAccount.json";
import AgentAccountFactoryAbiJson from "./abis/AgentAccountFactory.json";
import PolicyModuleAbiJson from "./abis/PolicyModule.json";
import LendingPoolAbiJson from "./abis/LendingPool.json";
import PriceOracleAbiJson from "./abis/PriceOracle.json";

/**
 * Contract wiring for the deployed Cadence system.
 *
 * ABIs here are pulled directly from Phase 1's `forge build` output
 * (`Cadence-contracts/out/*.sol/*.json`) — not hand-typed — so this file
 * goes stale automatically (in a loud, type-checked way) if the contracts
 * change shape without the ABIs being re-synced.
 *
 * Addresses are supplied via env vars, set after running Phase 1's
 * `Deploy.s.sol` + `ConfigureAgent.s.sol` against Arc testnet. Until then,
 * every value below is `undefined` and the UI renders its "not configured"
 * state rather than crashing — see `isConfigured` below.
 */

export const CONTRACTS = {
  agentAccount: process.env.NEXT_PUBLIC_AGENT_ACCOUNT as Address | undefined,
  agentAccountFactory: process.env.NEXT_PUBLIC_AGENT_FACTORY as Address | undefined,
  policyModule: process.env.NEXT_PUBLIC_POLICY_MODULE as Address | undefined,
  lendingPool: process.env.NEXT_PUBLIC_LENDING_POOL as Address | undefined,
  priceOracle: process.env.NEXT_PUBLIC_PRICE_ORACLE as Address | undefined,
  collateralToken: process.env.NEXT_PUBLIC_COLLATERAL_TOKEN as Address | undefined,
  debtToken: process.env.NEXT_PUBLIC_DEBT_TOKEN as Address | undefined,
  // Block Deploy.s.sol was broadcast at — used as the lower bound when
  // scanning for ActionExecuted logs, so the feed doesn't try to scan
  // from genesis on every load. Defaults to 0 (scan everything) if unset,
  // which is fine on a fresh testnet but slow on an older one.
  deployBlock: process.env.NEXT_PUBLIC_DEPLOY_BLOCK
    ? BigInt(process.env.NEXT_PUBLIC_DEPLOY_BLOCK)
    : 0n,
} as const;

export const isConfigured = Boolean(
  CONTRACTS.agentAccount && CONTRACTS.policyModule && CONTRACTS.lendingPool
);

export const ABIS = {
  agentAccount: AgentAccountAbiJson as Abi,
  agentAccountFactory: AgentAccountFactoryAbiJson as Abi,
  policyModule: PolicyModuleAbiJson as Abi,
  lendingPool: LendingPoolAbiJson as Abi,
  priceOracle: PriceOracleAbiJson as Abi,
} as const;

/**
 * The four pool actions ConfigureAgent.s.sol allowlists for this agent —
 * mirrored here (selector computed the same way Solidity does:
 * keccak256 of the canonical signature) so the Policy Panel can query
 * PolicyModule.rules(...) for exactly the actions the agent is actually
 * scoped to, rather than guessing from ABI shape alone.
 */
export const AGENT_ACTIONS = [
  { label: "Supply collateral", signature: "supplyCollateral(uint256)", unit: "mCOL" },
  { label: "Borrow", signature: "borrow(uint256)", unit: "USDC" },
  { label: "Repay", signature: "repay(uint256)", unit: "USDC" },
  { label: "Withdraw collateral", signature: "withdrawCollateral(uint256)", unit: "mCOL" },
] as const;
