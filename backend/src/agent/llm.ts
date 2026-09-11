import Groq from "groq-sdk";
import type { CadenceConfig } from "../config.js";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatResponse = {
  content: string | null;
  toolCalls: ToolCall[];
};

export interface LLMClient {
  chat(messages: ChatMessage[], tools: readonly unknown[]): Promise<ChatResponse>;
}

function qwenNonThinkingOptions(model: string) {
  // Qwen 3.6 can spend the whole completion budget on hidden reasoning.
  // Cadence already performs its own bounded tool/reasoning loop, so use the
  // model's instruction mode and reserve the response for tools or JSON.
  return model === "qwen/qwen3.6-27b"
    ? { reasoning_effort: "none" as const, reasoning_format: "hidden" as const }
    : {};
}

/** Groq — the default provider. Free tier, OpenAI-compatible tool
 *  calling, and fast enough (LPU hardware) that a multi-round tool-use
 *  loop doesn't feel sluggish. Requires network access to api.groq.com,
 *  which this sandbox cannot reach — see README for the corresponding
 *  test/verification limitation. */
export class GroqClient implements LLMClient {
  private client: Groq;
  constructor(private cfg: CadenceConfig) {
    this.client = new Groq({ apiKey: cfg.GROQ_API_KEY });
  }

  async chat(messages: ChatMessage[], tools: readonly unknown[]): Promise<ChatResponse> {
    const res = await this.client.chat.completions.create({
      model: this.cfg.GROQ_MODEL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      max_completion_tokens: this.cfg.LLM_MAX_OUTPUT_TOKENS,
      ...qwenNonThinkingOptions(this.cfg.GROQ_MODEL),
    });
    const choice = res.choices[0];
    return {
      content: choice.message.content ?? null,
      toolCalls: (choice.message.tool_calls ?? []) as ToolCall[],
    };
  }
}

/** Cerebras — fallback provider for when Groq's free-tier rate limits
 *  (30 RPM / 1,000 RPD on llama-3.3-70b-versatile) are exhausted mid-run.
 *  Also OpenAI-compatible, so it's a drop-in swap via base URL — uses the
 *  same groq-sdk client pointed elsewhere, since both APIs speak the
 *  OpenAI chat-completions shape. */
export class CerebrasClient implements LLMClient {
  private client: Groq;
  constructor(private cfg: CadenceConfig) {
    this.client = new Groq({ apiKey: cfg.CEREBRAS_API_KEY, baseURL: cfg.CEREBRAS_BASE_URL });
  }

  async chat(messages: ChatMessage[], tools: readonly unknown[]): Promise<ChatResponse> {
    const res = await this.client.chat.completions.create({
      model: this.cfg.CEREBRAS_MODEL,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      max_completion_tokens: this.cfg.LLM_MAX_OUTPUT_TOKENS,
      ...qwenNonThinkingOptions(this.cfg.CEREBRAS_MODEL),
    });
    const choice = res.choices[0];
    return {
      content: choice.message.content ?? null,
      toolCalls: (choice.message.tool_calls ?? []) as ToolCall[],
    };
  }
}

/** Deterministic stand-in used by the test suite so the orchestration
 *  logic (bounded rounds, tool execution, decision validation, policy
 *  precheck, UserOp build/sign/submit) can be proven correct against a
 *  real local chain without needing network access to a real LLM
 *  provider — the same "prove what's provable" split Phase 1 and 2 used
 *  for their own network-restricted pieces. */
export class ScriptedMockClient implements LLMClient {
  private step = 0;
  constructor(private script: ChatResponse[]) {}

  async chat(): Promise<ChatResponse> {
    const response = this.script[Math.min(this.step, this.script.length - 1)];
    this.step += 1;
    return response;
  }
}

export function createLLMClient(cfg: CadenceConfig): LLMClient {
  if (cfg.LLM_PROVIDER === "groq") return new GroqClient(cfg);
  if (cfg.LLM_PROVIDER === "cerebras") return new CerebrasClient(cfg);
  throw new Error('LLM_PROVIDER=mock has no default client — pass a ScriptedMockClient explicitly in tests.');
}
