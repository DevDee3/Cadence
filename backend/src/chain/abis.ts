import type { Abi } from "viem";
import AgentAccountAbiJson from "../abis/AgentAccount.json" with { type: "json" };
import AgentAccountFactoryAbiJson from "../abis/AgentAccountFactory.json" with { type: "json" };
import PolicyModuleAbiJson from "../abis/PolicyModule.json" with { type: "json" };
import LendingPoolAbiJson from "../abis/LendingPool.json" with { type: "json" };
import PriceOracleAbiJson from "../abis/PriceOracle.json" with { type: "json" };
import EntryPointAbiJson from "../abis/EntryPoint.json" with { type: "json" };

export const ABIS = {
  agentAccount: AgentAccountAbiJson as Abi,
  agentAccountFactory: AgentAccountFactoryAbiJson as Abi,
  policyModule: PolicyModuleAbiJson as Abi,
  lendingPool: LendingPoolAbiJson as Abi,
  priceOracle: PriceOracleAbiJson as Abi,
  entryPoint: EntryPointAbiJson as Abi,
} as const;

// Minimal ERC20 ABI (approve/allowance/balanceOf/decimals) for
// approving the LendingPool to pull collateral/debt tokens — the
// mock/faucet tokens don't need the full ABI for this backend's purposes.
export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
] as const satisfies Abi;
