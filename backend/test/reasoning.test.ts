import { describe, it, expect } from "vitest";
import { runReasoningLoop } from "../src/agent/reasoning.js";
import { ScriptedMockClient, type ChatResponse } from "../src/agent/llm.js";
import type { ToolContext } from "../src/agent/tools.js";

// A minimal stub ToolContext — these tests exercise the loop's control
// flow (rounds, retry-on-malformed-output), not real chain reads, so the
// publicClient/cfg fields are never dereferenced by the scripted
// responses used here (none of them include a real tool call that would
// hit the chain).
const stubToolCtx = {} as ToolContext;

function decisionResponse(json: unknown): ChatResponse {
  return { content: JSON.stringify(json), toolCalls: [] };
}

describe("runReasoningLoop", () => {
  it("returns ok on a valid first-round decision", async () => {
    const llm = new ScriptedMockClient([decisionResponse({ action: "hold", amount: "0", rationale: "fine" })]);
    const outcome = await runReasoningLoop(llm, stubToolCtx, 6);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.decision.action).toBe("hold");
      expect(outcome.rounds).toBe(1);
    }
  });

  it("gives the model one retry after malformed JSON, then succeeds", async () => {
    const llm = new ScriptedMockClient([
      { content: "not valid json", toolCalls: [] },
      decisionResponse({ action: "hold", amount: "0", rationale: "corrected" }),
    ]);
    const outcome = await runReasoningLoop(llm, stubToolCtx, 6);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.decision.rationale).toBe("corrected");
      expect(outcome.rounds).toBe(2);
    }
  });

  it("fails with reasoning_failed-shaped result when maxRounds is exceeded", async () => {
    // Always returns malformed content — never a valid decision.
    const llm = new ScriptedMockClient([{ content: "still not json", toolCalls: [] }]);
    const outcome = await runReasoningLoop(llm, stubToolCtx, 3);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rounds).toBe(3);
      expect(outcome.error).toMatch(/maxRounds/);
    }
  });

  it("fails cleanly when the model returns neither tool calls nor content", async () => {
    const llm = new ScriptedMockClient([{ content: null, toolCalls: [] }]);
    const outcome = await runReasoningLoop(llm, stubToolCtx, 6);
    expect(outcome.ok).toBe(false);
  });
});
