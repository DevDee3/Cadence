import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  toFunctionSelector,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Artifact = { abi: unknown[]; bytecode: string };
type Artifacts = Record<
  "EntryPoint" | "AgentAccountFactory" | "PolicyModule" | "PriceOracle" | "LendingPool" | "MockUSDC" | "MockCollateralToken",
  Artifact
>;

const artifacts: Artifacts = JSON.parse(readFileSync(path.join(__dirname, "fixtures/deployArtifacts.json"), "utf-8"));

// Anvil's well-known default account #0 — funded with 10,000 ETH by default.
export const ADMIN_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
// Account #1 — used as the agent's signer key.
export const AGENT_SIGNER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
// Account #2 — used as the relayer key.
export const RELAYER_PRIVATE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const anvilChain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export async function startAnvil(): Promise<ChildProcess> {
  const proc = spawn("anvil", ["--silent", "--port", "8545"], { stdio: "ignore" });
  // Give anvil a moment to bind its port.
  await new Promise((r) => setTimeout(r, 800));
  return proc;
}

export function stopAnvil(proc: ChildProcess) {
  proc.kill();
}

export type DeployedStack = {
  entryPoint: Address;
  factory: Address;
  policy: Address;
  oracle: Address;
  pool: Address;
  usdc: Address;
  collateral: Address;
  agentAccount: Address;
  publicClient: PublicClient;
  adminClient: WalletClient;
};

/** Deploys the full stack (EntryPoint + Cadence contracts + mocks),
 *  wires policy rules exactly as ConfigureAgent.s.sol would, and funds
 *  the pool + agent — all using the real bytecode/ABI Phase 1's
 *  `forge build` produced, via viem's deployContract, mirroring what the
 *  actual Foundry scripts do but from TypeScript so this test suite can
 *  run the real backend orchestration against it in-process. */
export async function deployStack(): Promise<DeployedStack> {
  const admin = privateKeyToAccount(ADMIN_PRIVATE_KEY);
  const agentSigner = privateKeyToAccount(AGENT_SIGNER_PRIVATE_KEY);

  const publicClient = createPublicClient({ chain: anvilChain, transport: http() }) as PublicClient;
  const adminClient = createWalletClient({ account: admin, chain: anvilChain, transport: http() });

  async function deploy(name: keyof Artifacts, args: unknown[] = []): Promise<Address> {
    const { abi, bytecode } = artifacts[name];
    const hash = await adminClient.deployContract({
      abi,
      bytecode: bytecode as `0x${string}`,
      args,
      account: admin,
      chain: anvilChain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deployment produced no contract address`);
    return receipt.contractAddress;
  }

  async function write(address: Address, abi: unknown[], functionName: string, args: unknown[]) {
    const hash = await adminClient.writeContract({
      address,
      abi,
      functionName,
      args,
      account: admin,
      chain: anvilChain,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const entryPoint = await deploy("EntryPoint");
  const policy = await deploy("PolicyModule", [admin.address]);
  const oracle = await deploy("PriceOracle", [admin.address]);
  const usdc = await deploy("MockUSDC", [admin.address]);
  const collateral = await deploy("MockCollateralToken", [admin.address]);
  const pool = await deploy("LendingPool", [admin.address, collateral, usdc, oracle]);
  const factory = await deploy("AgentAccountFactory", [entryPoint]);

  // Price: 1 collateral = 3000 USDC
  await write(oracle, artifacts.PriceOracle.abi, "setPrice", [collateral, 3000n * 10n ** 18n]);

  // Pool liquidity
  await write(usdc, artifacts.MockUSDC.abi, "mint", [admin.address, 1_000_000n * 10n ** 6n]);
  await write(usdc, artifacts.MockUSDC.abi, "approve", [pool, 1_000_000n * 10n ** 6n]);
  await write(pool, artifacts.LendingPool.abi, "fundPoolLiquidity", [1_000_000n * 10n ** 6n]);

  // Deploy the agent account
  const factoryAbi = artifacts.AgentAccountFactory.abi;
  const salt = 0n;
  const createHash = await adminClient.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "createAccount",
    args: [admin.address, agentSigner.address, policy, salt],
    account: admin,
    chain: anvilChain,
  });
  await publicClient.waitForTransactionReceipt({ hash: createHash });
  const agentAccount = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getAddress",
    args: [admin.address, agentSigner.address, policy, salt],
  })) as Address;

  // Register + allowlist, mirroring ConfigureAgent.s.sol exactly
  await write(policy, artifacts.PolicyModule.abi, "registerAccount", [agentAccount]);

  const approveSelector = toFunctionSelector("approve(address,uint256)");
  const supplySelector = toFunctionSelector("supplyCollateral(uint256)");
  const borrowSelector = toFunctionSelector("borrow(uint256)");
  const repaySelector = toFunctionSelector("repay(uint256)");
  const withdrawSelector = toFunctionSelector("withdrawCollateral(uint256)");

  await write(policy, artifacts.PolicyModule.abi, "setRule", [agentAccount, collateral, approveSelector, true, 0n]);
  await write(policy, artifacts.PolicyModule.abi, "setRule", [agentAccount, usdc, approveSelector, true, 0n]);
  await write(policy, artifacts.PolicyModule.abi, "setRule", [agentAccount, pool, supplySelector, true, 10n * 10n ** 18n]);
  await write(policy, artifacts.PolicyModule.abi, "setRule", [agentAccount, pool, borrowSelector, true, 2500n * 10n ** 6n]);
  await write(policy, artifacts.PolicyModule.abi, "setRule", [agentAccount, pool, repaySelector, true, 2500n * 10n ** 6n]);
  await write(policy, artifacts.PolicyModule.abi, "setRule", [agentAccount, pool, withdrawSelector, true, 10n * 10n ** 18n]);
  await write(policy, artifacts.PolicyModule.abi, "setCooldown", [agentAccount, 0n]); // no cooldown by default in tests

  // Fund the agent with collateral to supply, and with native currency so
  // it can pay the ERC-4337 prefund on each UserOperation (BaseAccount's
  // default _payPrefund sends `missingAccountFunds` from the account's
  // own balance to EntryPoint — same mechanism Arc's native USDC gas
  // would use in production, ETH here since this runs on local anvil).
  await write(collateral, artifacts.MockCollateralToken.abi, "mint", [agentAccount, 10n * 10n ** 18n]);
  const fundHash = await adminClient.sendTransaction({
    account: admin,
    chain: anvilChain,
    to: agentAccount,
    value: 10n * 10n ** 18n,
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });

  return { entryPoint, factory, policy, oracle, pool, usdc, collateral, agentAccount, publicClient, adminClient };
}
