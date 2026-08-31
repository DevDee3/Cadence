import { getConfig } from "./config.js";
import { createClients } from "./chain/client.js";
import { createLLMClient } from "./agent/llm.js";
import { CycleHistory, loadScheduledRuntimes, startScheduler } from "./agent/loop.js";
import { createServer } from "./server.js";
import { loadSettings } from "./agent/settings.js";

async function main() {
  const cfg = getConfig();
  const clients = createClients(cfg);
  const llm = createLLMClient(cfg);
  const history = new CycleHistory(50, cfg.AGENT_ACCOUNT, cfg);
  await history.ready();
  const control = await loadSettings(cfg, cfg.AGENT_ACCOUNT, { enabled: true, minHealthFactor: 1.5 });

  console.log(`Cadence agent starting`);
  console.log(`  Chain: ${cfg.CHAIN_ID} via ${cfg.RPC_URL}`);
  console.log(`  Agent account: ${cfg.AGENT_ACCOUNT}`);
  console.log(`  Submission mode: ${cfg.SUBMISSION_MODE}`);
  console.log(`  LLM provider: ${cfg.LLM_PROVIDER} (${cfg.LLM_PROVIDER === "groq" ? cfg.GROQ_MODEL : cfg.CEREBRAS_MODEL})`);
  console.log(`  Poll interval: ${cfg.POLL_INTERVAL_SECONDS}s`);

  const stopScheduler = startScheduler(clients, cfg, llm, history, () => control.enabled, () => `Keep the health factor above ${control.minHealthFactor}.`, () => loadScheduledRuntimes(clients, cfg, history, control));

  const app = createServer(clients, cfg, llm, history, control);
  const server = app.listen(cfg.PORT, () => {
    console.log(`  HTTP server listening on :${cfg.PORT}`);
  });

  const shutdown = () => {
    console.log("Shutting down…");
    stopScheduler();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("Fatal startup error:", e);
  process.exit(1);
});
