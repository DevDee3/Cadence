import { encodeFunctionData, type Address } from "viem";
import { ABIS, ERC20_ABI } from "./abis.js";
import type { ActionName } from "./state.js";

export type PlannedCall = { target: Address; value: bigint; data: `0x${string}` };

/** Builds the LendingPool calldata for a given action + amount. Mirrors
 *  exactly the four selectors ConfigureAgent.s.sol allowlisted — nothing
 *  here can construct a call PolicyModule wasn't configured to accept. */
export function buildActionCall(action: ActionName, poolAddress: Address, amount: bigint): PlannedCall {
  const functionName =
    action === "supply"
      ? "supplyCollateral"
      : action === "borrow"
        ? "borrow"
        : action === "repay"
          ? "repay"
          : "withdrawCollateral";

  return {
    target: poolAddress,
    value: 0n,
    data: encodeFunctionData({ abi: ABIS.lendingPool, functionName, args: [amount] }),
  };
}

/** Builds an ERC20 approve() call for the pool to pull the given token —
 *  needed before supplyCollateral/repay, since both use transferFrom. */
export function buildApproveCall(tokenAddress: Address, spender: Address, amount: bigint): PlannedCall {
  return {
    target: tokenAddress,
    value: 0n,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }),
  };
}

/** Wraps a target/value/data call as AgentAccount.execute(...) calldata —
 *  the payload that goes inside a UserOperation's callData field. */
export function buildExecuteCalldata(call: PlannedCall): `0x${string}` {
  return encodeFunctionData({
    abi: ABIS.agentAccount,
    functionName: "execute",
    args: [call.target, call.value, call.data],
  });
}

/** Wraps multiple calls as AgentAccount.executeBatch(...) calldata —
 *  used for supply/repay, which need an approve() call immediately
 *  before the pool call, executed atomically in one UserOperation.
 *  PolicyModule still checks each call in the batch independently. */
export function buildExecuteBatchCalldata(calls: PlannedCall[]): `0x${string}` {
  return encodeFunctionData({
    abi: ABIS.agentAccount,
    functionName: "executeBatch",
    args: [calls.map((c) => c.target), calls.map((c) => c.value), calls.map((c) => c.data)],
  });
}
