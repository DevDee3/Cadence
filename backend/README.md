# Cadence — Backend Agent (Phase 3 of 3)

The perceive → reason → act loop. This is the piece that actually makes
Cadence is agentic: it reads the live LendingPool position (Phase 1),
hands that state to an LLM through a bounded tool-calling loop, validates
the model's decision, and — if the decision passes an independent
server-side policy check — signs and submits a real ERC-4337
UserOperation against the deployed AgentAccount.

## Architecture: the AI reasons, the contracts still enforce

This backend adds a *second* layer of defense, but it does not replace
the first. The real security boundary is still on-chain — Phase 1's
`PolicyModule.checkAndConsume()`, called from inside
`AgentAccount.execute()`, which reverts within the transaction itself
if the action is out of scope. Nothing this backend does can bypass
that; a bug or a hallucinated decision here fails safe against the same
contract-level guardrails a human operator would.

What this backend adds is a **server-side precheck** (`PolicyModule.wouldAllow()`,
a view call) before ever building and signing a transaction — not because
the on-chain check needs help, but because failing fast avoids burning
gas and cluttering the on-chain history with doomed UserOperations. See
`src/agent/decide.ts`'s `runCycle()` for exactly where this happens.

## The loop, concretely

1. **Perceive** — `src/chain/state.ts` reads the agent's collateral,
   debt, health factor, the collateral price, pool liquidity, and every
   PolicyModule rule that applies to this account, in one bounded pass.
2. **Reason** — `src/agent/reasoning.ts` runs a capped tool-calling loop
   (`MAX_REASONING_ROUNDS`, default 6 — same round-capping discipline
   this portfolio's AegisX project used for its Claude-based analysis
   agent). The model can call `get_position_state`, `get_policy_limits`,
   and `simulate_action` — all read-only; see `src/agent/tools.ts`. It
   must end the cycle by returning a structured decision object, which
   `src/agent/decision.ts` validates with Zod before anything downstream
   trusts it.
3. **Act** — if the decision isn't `"hold"`, `src/agent/decide.ts`
   re-checks the proposed action against `PolicyModule.wouldAllow()`,
   builds the LendingPool calldata (`src/chain/actions.ts`), wraps it as
   `AgentAccount.execute()`/`executeBatch()` calldata (supply/repay need
   an atomic approve-then-act batch), and `src/chain/userOp.ts` builds,
   signs, and submits the UserOperation.

## Submission modes

- **`relayer`** (default, for dev/demo): a separately funded relayer key
  calls `EntryPoint.handleOps()` directly. Not gasless — the relayer pays
  gas out of pocket rather than through a bundler's fee market — but it
  exercises exactly the same on-chain validation and policy-enforcement
  path a real bundler submission would. Useful before Arc's bundler
  endpoint is confirmed.
- **`bundler`**: submits via the standard ERC-4337 `eth_sendUserOperation`
  JSON-RPC method against any spec-compliant bundler (Pimlico, Alchemy,
  etc.), once Arc's bundler endpoint is confirmed. No bundler-client SDK
  dependency — just the raw JSON-RPC call (`src/chain/userOp.ts`).

Switch via `SUBMISSION_MODE` in `.env`.

## LLM provider: Groq (free), Cerebras (fallback)

Groq's free tier (`llama-3.3-70b-versatile`) is the default — fast
enough on its LPU hardware that a multi-round tool-calling loop doesn't
feel sluggish, and OpenAI-compatible tool calling out of the box. The
free tier's rate limits (30 RPM / 1,000 RPD on this model) are tight for
a busy demo, so `LLM_PROVIDER=cerebras` is wired as a same-shape fallback
(also OpenAI-compatible, swapped via base URL — see `src/agent/llm.ts`).
Both share the same `LLMClient` interface, so switching providers is a
one-line env change, not a code change.

## Testing strategy — and a real limitation

This sandbox cannot reach `api.groq.com` or `api.cerebras.ai` (outside
its network allowlist), so the actual LLM call is untested from here —
same category of limitation as Phase 1/2's inability to reach Arc's live
RPC. What *is* fully tested, against a **real chain**, is everything
around that call:

- `test/setup.ts` deploys the entire Phase 1 stack (EntryPoint,
  AgentAccountFactory, PolicyModule, PriceOracle, LendingPool, mock
  tokens) to a local Anvil node using the real bytecode/ABI from Phase 1's
  `forge build` output — not reimplemented contracts, the actual ones —
  and wires policy rules exactly as `ConfigureAgent.s.sol` would.
- `test/integration.test.ts` runs the real `runCycle()` orchestration
  against that live local chain, using a `ScriptedMockClient` in place of
  Groq so the *orchestration logic* (tool loop, decision validation,
  policy precheck, UserOp build/sign/submit) is proven correct end-to-end
  with real signed transactions and real on-chain state assertions —
  supply, borrow, an over-cap decision correctly blocked before any
  transaction is built, an atomic approve+repay batch, and a
  bounded-rounds failure path.
- `test/reasoning.test.ts` and `test/decision.test.ts` unit-test the loop's
  control flow (round capping, one retry on malformed model output) and
  decision-schema validation in isolation.

17/17 tests passing, run repeatedly to confirm no flakiness (see the
note below about a real race condition this caught).

**A real bug this testing found:** the relayer submission path originally
returned a transaction hash without waiting for it to be mined, which
surfaced as a flaky test — a subsequent state read could race the
transaction's inclusion. Fixed in `submitViaRelayer()` by waiting for the
receipt before returning, which also makes an `"executed"` cycle outcome
trustworthy (confirmed on-chain) rather than merely "broadcast."

## What's intentionally not verified here

- Real Groq/Cerebras API calls (network-restricted sandbox — see above).
  `GroqClient`/`CerebrasClient` in `src/agent/llm.ts` are written against
  each provider's documented OpenAI-compatible chat-completions + tool-calling
  shape but haven't made a live request from this environment.
- A real Arc bundler endpoint (`SUBMISSION_MODE=bundler`) — written
  against the standard ERC-4337 JSON-RPC method, unverified against a live
  bundler until Arc's endpoint is confirmed (see Phase 1's README for the
  same EntryPoint-address caveat).
- Live deployment to Arc testnet itself — same `rpc.testnet.arc.io`
  network restriction as Phase 1 and 2.

## Setup

```bash
npm install
cp .env.example .env       # fill in Phase 1 deploy addresses + keys
npm run dev                 # or: npm run build && npm start
```

`GET /health` — basic liveness check.
`GET /api/agent/status` — latest cycle outcome + recent history.
`POST /api/agent/run-cycle` — manually trigger a cycle (demo/frontend affordance),
serialized behind the same path the background scheduler uses so a manual
trigger and a scheduled tick can never race.

## Running the test suite yourself

Requires `anvil` (Foundry) on `PATH`:

```bash
npm test
```
