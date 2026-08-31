import { z } from "zod";

/** The reasoning loop's final output — validated before anything is ever
 *  built into a transaction. "hold" is always a legitimate decision; the
 *  agent is not required to act every cycle. */
export const decisionSchema = z.object({
  action: z.enum(["supply", "borrow", "repay", "withdraw", "hold"]),
  amount: z
    .string()
    .regex(/^[0-9]+$/, "amount must be a base-unit integer string, e.g. \"1000000\" for 1 USDC")
    .default("0"),
  rationale: z.string().min(1).max(500),
});

export type Decision = z.infer<typeof decisionSchema>;

export function parseDecision(raw: string): { ok: true; decision: Decision } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Model output was not valid JSON." };
  }

  const result = decisionSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, decision: result.data };
}
