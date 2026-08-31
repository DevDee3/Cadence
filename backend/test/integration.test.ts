import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import { createPublicClient, http, defineChain, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient } from "viem";
import {
  startAnvil,
  stopAnvil,
  deployStack,
  AGENT_SIGNER_PRIVATE_KEY,
  RELAYER_PRIVATE_KEY,
  type DeployedStack,
} from "./setup.js";
import type { CadenceConfig } from "../src/config.js";
import type { Clients } from "../src/chain/client.js";
import { runCycle } from "../src/agent/decide.js";
import { ScriptedMockClient, type ChatResponse } from "../src/agent/llm.js";
import { ABIS } from "../src/chain/abis.js";

const anvilChain = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

let anvilProc: ChildProcess;
let stack: DeployedStack;
let cfg: CadenceConfig;
let clients: Clients;

function toolCallResponse(name: string, args: Record<string, unknown>): ChatResponse {
  return {
    content: null,
    toolCalls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function decisionResponse(decision: { action: string; amount: string; rationale: string }): ChatResponse {
  return { content: JSON.stringify(decision), toolCalls: [] };
}

beforeAll(async () => {
  anvilProc = await startAnvil();
  stack = await deployStack();

  const publicClient = createPublicClient({ chain: anvilChain, transport: http() }) as PublicClient;
  const agentAccount = privateKeyToAccount(AGENT_SIGNER_PRIVATE_KEY);
  const agentSignerClient = createWalletClient({ account: agentAccount, chain: anvilChain, transport: http() });
  const relayerClient = createWalletClient({
    account: privateKeyToAccount(RELAYER_PRIVATE_KEY),
    chain: anvilChain,
    transport: http(),
  });

  cfg = {
    RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: 31337,
    ENTRY_POINT: stack.entryPoint,
    AGENT_ACCOUNT: stack.agentAccount,
    POLICY_MODULE: stack.policy,
    LENDING_POOL: stack.pool,
    PRICE_ORACLE: stack.oracle,
    COLLATERAL_TOKEN: stack.collateral,
    DEBT_TOKEN: stack.usdc,
    AGENT_SIGNER_PRIVATE_KEY,
    SUBMISSION_MODE: "relayer",
    BUNDLER_RPC_URL: undefined,
    RELAYER_PRIVATE_KEY,
    LLM_PROVIDER: "mock",
    GROQ_API_KEY: undefined,
    GROQ_MODEL: "llama-3.3-70b-versatile",
    CEREBRAS_API_KEY: undefined,
    CEREBRAS_BASE_URL: "https://api.cerebras.ai/v1",
    CEREBRAS_MODEL: "llama-3.3-70b",
    MAX_REASONING_ROUNDS: 6,
    POLL_INTERVAL_SECONDS: 900,
    PORT: 8787,
  };

  clients = { chain: anvilChain, publicClient, agentSignerClient, agentAccount, relayerClient };
}, 30_000);

afterAll(() => {
  stopAnvil(anvilProc);
});

describe("full perceive -> reason -> act cycle against a real chain", () => {
  it("executes a real supply UserOperation when the model decides to supply", async () => {
    const llm = new ScriptedMockClient([
      toolCallResponse("get_position_state", {}),
      toolCallResponse("get_policy_limits", {}),
      decisionResponse({ action: "supply", amount: (1n * 10n ** 18n).toString(), rationale: "Establish an initial collateral position." }),
    ]);

    const outcome = await runCycle(clients, cfg, llm);

    expect(outcome.status).toBe("executed");
    if (outcome.status !== "executed") throw new Error("expected executed");
    expect(outcome.txHashOrUserOpHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const position = (await clients.publicClient.readContract({
      address: cfg.LENDING_POOL,
      abi: ABIS.lendingPool,
      functionName: "positions",
      args: [cfg.AGENT_ACCOUNT],
    })) as readonly [bigint, bigint];

    expect(position[0]).toBe(1n * 10n ** 18n); // collateralAmount
  });

  it("borrows against the now-supplied collateral", async () => {
    const llm = new ScriptedMockClient([
      toolCallResponse("get_position_state", {}),
      decisionResponse({ action: "borrow", amount: (1000n * 10n ** 6n).toString(), rationale: "Borrow well within the 80% liquidation threshold for capital efficiency." }),
    ]);

    const outcome = await runCycle(clients, cfg, llm);
    expect(outcome.status).toBe("executed");

    const debt = (await clients.publicClient.readContract({
      address: cfg.LENDING_POOL,
      abi: ABIS.lendingPool,
      functionName: "positions",
      args: [cfg.AGENT_ACCOUNT],
    })) as readonly [bigint, bigint];
    expect(debt[1]).toBe(1000n * 10n ** 6n);
  });

  it("holds when the model decides no action is needed", async () => {
    const llm = new ScriptedMockClient([
      toolCallResponse("get_position_state", {}),
      decisionResponse({ action: "hold", amount: "0", rationale: "Health factor is comfortable; no action needed this cycle." }),
    ]);

    const before = (await clients.publicClient.readContract({
      address: cfg.LENDING_POOL,
      abi: ABIS.lendingPool,
      functionName: "positions",
      args: [cfg.AGENT_ACCOUNT],
    })) as readonly [bigint, bigint];

    const outcome = await runCycle(clients, cfg, llm);
    expect(outcome.status).toBe("held");

    const after = (await clients.publicClient.readContract({
      address: cfg.LENDING_POOL,
      abi: ABIS.lendingPool,
      functionName: "positions",
      args: [cfg.AGENT_ACCOUNT],
    })) as readonly [bigint, bigint];

    expect(after).toEqual(before);
  });

  it("blocks a decision that exceeds the policy cap before ever building a transaction", async () => {
    // Cap for borrow is 2500 USDC/call (see setup.ts); position could
    // technically support more, but the model proposing 10,000 USDC must
    // be blocked by the server-side precheck, not merely discouraged.
    const llm = new ScriptedMockClient([
      decisionResponse({ action: "borrow", amount: (10_000n * 10n ** 6n).toString(), rationale: "Testing an over-cap proposal." }),
    ]);

    const before = (await clients.publicClient.readContract({
      address: cfg.LENDING_POOL,
      abi: ABIS.lendingPool,
      functionName: "positions",
      args: [cfg.AGENT_ACCOUNT],
    })) as readonly [bigint, bigint];

    const outcome = await runCycle(clients, cfg, llm);
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") throw new Error("expected blocked");
    expect(outcome.reason.length).toBeGreaterThan(0);

    const after = (await clients.publicClient.readContract({
      address: cfg.LENDING_POOL,
      abi: ABIS.lendingPool,
      functionName: "positions",
      args: [cfg.AGENT_ACCOUNT],
    })) as readonly [bigint, bigint];

    expect(after[1]).toBe(before[1]); // debt unchanged — nothing was submitted
  });

  it("repays debt via an atomic approve+repay batch UserOperation", async () => {
    const llm = new ScriptedMockClient([
      decisionResponse({ action: "repay", amount: (400n * 10n ** 6n).toString(), rationale: "Reduce debt to improve health factor buffer." }),
    ]);

    // Fund the agent with USDC to repay from (it borrowed 1000 earlier).
    // The agent already holds the borrowed USDC from the earlier test.
    const outcome = await runCycle(clients, cfg, llm);
    expect(outcome.status).toBe("executed");

    const position = (await clients.publicClient.readContract({
      address: cfg.LENDING_POOL,
      abi: ABIS.lendingPool,
      functionName: "positions",
      args: [cfg.AGENT_ACCOUNT],
    })) as readonly [bigint, bigint];

    expect(position[1]).toBe(600n * 10n ** 6n); // 1000 - 400
  });

  it("exceeding MAX_REASONING_ROUNDS without a final decision surfaces as reasoning_failed, not a silent no-op", async () => {
    // A script that only ever calls a tool, never returns a final decision.
    const infiniteToolCalling = new ScriptedMockClient([toolCallResponse("get_position_state", {})]);
    const shortRoundCfg = { ...cfg, MAX_REASONING_ROUNDS: 2 };

    const outcome = await runCycle(clients, shortRoundCfg, infiniteToolCalling);
    expect(outcome.status).toBe("reasoning_failed");
  });
});
