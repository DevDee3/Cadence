import { describe, it, expect } from "vitest";
import { parseDecision } from "../src/agent/decision.js";

describe("parseDecision", () => {
  it("accepts a well-formed hold decision", () => {
    const result = parseDecision(JSON.stringify({ action: "hold", amount: "0", rationale: "All good." }));
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed action decision", () => {
    const result = parseDecision(JSON.stringify({ action: "repay", amount: "1000000", rationale: "Reduce debt." }));
    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    const result = parseDecision("not json at all");
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown action", () => {
    const result = parseDecision(JSON.stringify({ action: "yolo", amount: "0", rationale: "test" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer amount string", () => {
    const result = parseDecision(JSON.stringify({ action: "repay", amount: "1.5", rationale: "test" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing rationale", () => {
    const result = parseDecision(JSON.stringify({ action: "hold", amount: "0" }));
    expect(result.ok).toBe(false);
  });

  it("rejects markdown-fenced JSON (model must return raw JSON only)", () => {
    const result = parseDecision('```json\n{"action":"hold","amount":"0","rationale":"test"}\n```');
    expect(result.ok).toBe(false);
  });
});
