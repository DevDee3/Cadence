import type { Address, PublicClient, WalletClient, Account } from "viem";
import { ABIS } from "./abis.js";
import type { CadenceConfig } from "../config.js";

/** Mirrors Solidity's PackedUserOperation struct exactly — see
 *  account-abstraction/interfaces/PackedUserOperation.sol, the same type
 *  Phase 1's TestBase.sol builds for its ERC-4337 integration tests. */
export type PackedUserOperation = {
  sender: Address;
  nonce: bigint;
  initCode: `0x${string}`;
  callData: `0x${string}`;
  accountGasLimits: `0x${string}`; // bytes32: verificationGasLimit (hi 128) | callGasLimit (lo 128)
  preVerificationGas: bigint;
  gasFees: `0x${string}`; // bytes32: maxPriorityFeePerGas (hi 128) | maxFeePerGas (lo 128)
  paymasterAndData: `0x${string}`;
  signature: `0x${string}`;
};

function packUint128Pair(hi: bigint, lo: bigint): `0x${string}` {
  const packed = (hi << 128n) | lo;
  return `0x${packed.toString(16).padStart(64, "0")}`;
}

export async function buildUnsignedUserOp(
  publicClient: PublicClient,
  entryPoint: Address,
  sender: Address,
  callData: `0x${string}`,
  gas: { verificationGasLimit: bigint; callGasLimit: bigint; preVerificationGas: bigint; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint } = {
    verificationGasLimit: 500_000n,
    callGasLimit: 500_000n,
    preVerificationGas: 100_000n,
    maxPriorityFeePerGas: 1_000_000_000n, // 1 gwei
    maxFeePerGas: 10_000_000_000n, // 10 gwei
  }
): Promise<PackedUserOperation> {
  const nonce = (await publicClient.readContract({
    address: entryPoint,
    abi: ABIS.entryPoint,
    functionName: "getNonce",
    args: [sender, 0n],
  })) as bigint;

  return {
    sender,
    nonce,
    initCode: "0x",
    callData,
    accountGasLimits: packUint128Pair(gas.verificationGasLimit, gas.callGasLimit),
    preVerificationGas: gas.preVerificationGas,
    gasFees: packUint128Pair(gas.maxPriorityFeePerGas, gas.maxFeePerGas),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

export async function signUserOp(
  publicClient: PublicClient,
  entryPoint: Address,
  op: PackedUserOperation,
  account: Account
): Promise<PackedUserOperation> {
  const userOpHash = (await publicClient.readContract({
    address: entryPoint,
    abi: ABIS.entryPoint,
    functionName: "getUserOpHash",
    args: [op],
  })) as `0x${string}`;

  if (!account.signMessage) {
    throw new Error("Account does not support signMessage — cannot sign UserOperation.");
  }

  // AgentAccount._validateSignature() checks against the EIP-191
  // eth-signed-message hash of userOpHash (see AgentAccount.sol), so we
  // sign it the same way here rather than signing the raw hash.
  const signature = await account.signMessage({ message: { raw: userOpHash } });

  return { ...op, signature };
}

/** Direct-relayer submission: a funded relayer key calls
 *  EntryPoint.handleOps directly. Not gasless (the relayer pays gas
 *  itself, out of band from a real bundler market), but exercises
 *  exactly the same on-chain validation + PolicyModule enforcement path
 *  a real bundler submission would — useful for demos/dev before a
 *  confirmed Arc bundler endpoint is wired in.
 *
 *  Waits for the transaction to be mined before returning — callers
 *  (and anything reading position state right after) should be able to
 *  trust that "executed" means "confirmed on-chain", not merely
 *  "broadcast". */
export async function submitViaRelayer(
  publicClient: PublicClient,
  relayerClient: WalletClient,
  entryPoint: Address,
  op: PackedUserOperation
): Promise<`0x${string}`> {
  if (!relayerClient.account) throw new Error("Relayer wallet client has no account configured.");

  const hash = await relayerClient.writeContract({
    address: entryPoint,
    abi: ABIS.entryPoint,
    functionName: "handleOps",
    args: [[op], relayerClient.account.address],
    account: relayerClient.account,
    chain: relayerClient.chain,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Bundler submission via the standard ERC-4337 `eth_sendUserOperation`
 *  JSON-RPC method — works against any spec-compliant bundler (Pimlico,
 *  Alchemy, etc.) once Arc's bundler endpoint is confirmed, without
 *  pulling in a bundler-client SDK as a hard dependency. */
export async function submitViaBundler(
  bundlerRpcUrl: string,
  entryPoint: Address,
  op: PackedUserOperation
): Promise<{ hash: `0x${string}`; confirmed: boolean }> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendUserOperation",
    params: [serializeUserOpForRpc(op), entryPoint],
  };

  const res = await fetch(bundlerRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as { result?: `0x${string}`; error?: { message: string } };
  if (json.error) throw new Error(`Bundler error: ${json.error.message}`);
  if (!json.result) throw new Error("Bundler returned no result for eth_sendUserOperation.");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    try {
      const receiptResponse = await fetch(bundlerRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getUserOperationReceipt", params: [json.result] }),
      });
      const receipt = await receiptResponse.json() as { result?: unknown };
      if (receipt.result) return { hash: json.result, confirmed: true };
    } catch {
      // A temporary receipt lookup failure should not discard the submitted hash.
    }
  }
  return { hash: json.result, confirmed: false };
}

export async function getUserOperationStatus(bundlerRpcUrl: string, userOpHash: `0x${string}`): Promise<"confirmed" | "failed" | null> {
  const response = await fetch(bundlerRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_getUserOperationReceipt", params: [userOpHash] }),
  });
  const body = await response.json() as { result?: { success?: boolean } | null };
  if (!body.result) return null;
  return body.result.success === false ? "failed" : "confirmed";
}

function serializeUserOpForRpc(op: PackedUserOperation) {
  return {
    sender: op.sender,
    nonce: `0x${op.nonce.toString(16)}`,
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: `0x${op.preVerificationGas.toString(16)}`,
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

export async function buildSignAndSubmit(
  cfg: CadenceConfig,
  publicClient: PublicClient,
  agentAccount: Account,
  relayerClient: WalletClient | null,
  callData: `0x${string}`
): Promise<{ txHashOrUserOpHash: `0x${string}`; op: PackedUserOperation; confirmed: boolean }> {
  const unsigned = await buildUnsignedUserOp(publicClient, cfg.ENTRY_POINT, cfg.AGENT_ACCOUNT, callData);
  const signed = await signUserOp(publicClient, cfg.ENTRY_POINT, unsigned, agentAccount);

  if (cfg.SUBMISSION_MODE === "relayer") {
    if (!relayerClient) throw new Error("Relayer client not configured for SUBMISSION_MODE=relayer.");
    const txHash = await submitViaRelayer(publicClient, relayerClient, cfg.ENTRY_POINT, signed);
    return { txHashOrUserOpHash: txHash, op: signed, confirmed: true };
  }

  if (!cfg.BUNDLER_RPC_URL) throw new Error("BUNDLER_RPC_URL not configured for SUBMISSION_MODE=bundler.");
  const submission = await submitViaBundler(cfg.BUNDLER_RPC_URL, cfg.ENTRY_POINT, signed);
  return { txHashOrUserOpHash: submission.hash, op: signed, confirmed: submission.confirmed };
}
