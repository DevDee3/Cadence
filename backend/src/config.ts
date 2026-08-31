import { z } from "zod";
import "dotenv/config";
import type { Address, Hex } from "viem";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed 20-byte address")
  .transform((v) => v as Address);
const privateKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "must be a 0x-prefixed 32-byte private key")
  .transform((v) => v as Hex);

const envSchema = z.object({
  // Chain
  RPC_URL: z.string().url().default("https://rpc.testnet.arc.network"),
  CHAIN_ID: z.coerce.number().default(5042002),
  ENTRY_POINT: addressSchema.default("0x0000000071727De22E5E9d8BAf0edAc6f37da032"),

  // Deployed Cadence contracts (Phase 1 output)
  AGENT_ACCOUNT: addressSchema,
  // Used only when automatic per-wallet account provisioning is enabled.
  AGENT_FACTORY: addressSchema.optional(),
  POLICY_MODULE: addressSchema,
  LENDING_POOL: addressSchema,
  PRICE_ORACLE: addressSchema,
  COLLATERAL_TOKEN: addressSchema,
  DEBT_TOKEN: addressSchema,

  // Agent's signing key — the hot key this backend holds. Its authority is
  // bounded entirely by PolicyModule on-chain; compromise of this key
  // alone cannot move funds outside the allowlisted actions.
  AGENT_SIGNER_PRIVATE_KEY: privateKeySchema,
  ADMIN_PRIVATE_KEY: privateKeySchema.optional(),
  // Master secret used to encrypt per-wallet agent signer keys at rest.
  AGENT_SIGNER_ENCRYPTION_KEY: z.string().min(16).optional(),

  // Submission mode: "bundler" uses a real ERC-4337 bundler RPC (production
  // path); "relayer" submits directly via EntryPoint.handleOps using a
  // separate funded relayer key (dev/demo path — not gasless, but exercises
  // the exact same on-chain validation + policy enforcement path).
  SUBMISSION_MODE: z.enum(["bundler", "relayer"]).default("relayer"),
  // dotenv loads `BUNDLER_RPC_URL=` as an empty string. Treat that the same
  // as omitted when using the default relayer submission mode.
  BUNDLER_RPC_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional()
  ),
  RELAYER_PRIVATE_KEY: privateKeySchema.optional(),

  // LLM provider
  LLM_PROVIDER: z.enum(["groq", "cerebras", "mock"]).default("groq"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("qwen/qwen3-32b"),
  CEREBRAS_API_KEY: z.string().optional(),
  CEREBRAS_BASE_URL: z.string().url().default("https://api.cerebras.ai/v1"),
  CEREBRAS_MODEL: z.string().default("llama-3.3-70b"),

  // Loop behavior
  MAX_REASONING_ROUNDS: z.coerce.number().int().min(1).max(12).default(6),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900), // 15 min default, matches PolicyModule's typical cooldown
  PORT: z.coerce.number().default(8787),
  AGENT_API_KEY: z.string().min(16).optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
});

export type CadenceConfig = z.infer<typeof envSchema>;

function loadConfig(): CadenceConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    throw new Error("Fix the environment variables above (see .env.example) before starting the agent.");
  }

  const cfg = parsed.data;
  if (cfg.SUBMISSION_MODE === "bundler" && !cfg.BUNDLER_RPC_URL) {
    throw new Error("SUBMISSION_MODE=bundler requires BUNDLER_RPC_URL to be set.");
  }
  if (cfg.SUBMISSION_MODE === "relayer" && !cfg.RELAYER_PRIVATE_KEY) {
    throw new Error("SUBMISSION_MODE=relayer requires RELAYER_PRIVATE_KEY to be set.");
  }
  if (cfg.LLM_PROVIDER === "groq" && !cfg.GROQ_API_KEY) {
    throw new Error("LLM_PROVIDER=groq requires GROQ_API_KEY to be set.");
  }
  if (cfg.LLM_PROVIDER === "cerebras" && !cfg.CEREBRAS_API_KEY) {
    throw new Error("LLM_PROVIDER=cerebras requires CEREBRAS_API_KEY to be set.");
  }

  return cfg;
}

/** Lazily loaded so tests can construct their own config without a real .env file. */
let cached: CadenceConfig | null = null;
export function getConfig(): CadenceConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
