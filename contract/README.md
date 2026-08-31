# Cadence — Autonomous DeFi Rebalancing Agent (Contracts)

**Phase 1 of 3** (Contracts → Frontend → Backend) for the AI Builders Hackathon 2026.

An ERC-4337 smart account, controlled by an autonomous AI reasoning loop,
that manages its own DeFi lending position — supplying collateral,
borrowing, and repaying to keep its health factor safe — with every action
gated by a deterministic on-chain policy contract the AI cannot override.

Architecture principle (carried over from this portfolio's AegisX
project): **the AI reasons, the contracts enforce.** The off-chain agent
(Phase 3) decides *what* to do; nothing it decides executes unless
`PolicyModule` independently agrees the action is inside scope.

Target network: **Arc Testnet** (Circle's USDC-native-gas L1, Chain ID
`5042002`) — see [Network](#network) below.

---

## Setup

Dependencies (`lib/`) aren't included in the zip to keep it small — restore them with:

```bash
forge install OpenZeppelin/openzeppelin-contracts
forge install eth-infinitism/account-abstraction@v0.7.0
forge build
forge test
```

## Contracts

| Contract | Purpose |
|---|---|
| `AgentAccount.sol` | ERC-4337 smart account. Two roles: `owner` (human, admin-only) and `agentSigner` (autonomous key, day-to-day UserOperations). Every `execute()`/`executeBatch()` call is checked against `PolicyModule` before it runs. |
| `AgentAccountFactory.sol` | CREATE2 factory — deploys `AgentAccount`s at a counterfactual address, idempotent on repeat calls with the same params. |
| `PolicyModule.sol` | Deterministic guardrail: per-account allowlist of `(target, selector)` pairs, an optional per-call spend cap, and a cooldown between actions. Reverts with a specific, indexed reason on every rejection — nothing fails silently. |
| `PriceOracle.sol` | Owner-settable price feed (USDC terms, 18-decimal precision) with a staleness check (`maxPriceAge`, default 1 day). |
| `LendingPool.sol` | Minimal single-collateral/single-debt-asset money market: `supplyCollateral`, `withdrawCollateral`, `borrow`, `repay`, `liquidate`, `healthFactor`. Deliberately scoped down from a full multi-asset market — see Sentinel in this portfolio for that shape — so `PolicyModule`'s rules can wrap tightly around a small, fully-tested surface. |
| `mocks/MockUSDC.sol`, `mocks/MockCollateralToken.sol` | 6- and 18-decimal ERC20 mocks for local/CI testing. **Never deploy these where real USDC exists** — use Arc's faucet-issued USDC instead. |

## Why ERC-4337 (not 7702)

This account has no pre-existing EOA history to preserve — it's a fresh
autonomous identity from day one. ERC-4337 smart accounts let
authorization policy live in on-chain validation logic (allowlists, spend
caps, cooldowns) enforced independently of the signing key, which is the
right primitive for a key an unattended reasoning loop holds. EIP-7702 is
for upgrading an *existing* EOA in place — not this project's situation.

## Test suite

47/47 passing, including a full ERC-4337 integration path: tests sign real
`PackedUserOperation`s and submit them through an actual deployed
`EntryPoint` (v0.7, `eth-infinitism/account-abstraction`), not a shortcut
around it.

```
forge test              # run everything
forge test --gas-report # + gas cost table
forge coverage          # coverage report
```

Coverage highlights:
- Full agent lifecycle through real UserOperations: supply -> borrow ->
  repay, health factor asserted at each step
- Policy cap blocking an over-limit action (agent's position could
  technically support a larger borrow; policy says no anyway)
- Non-allowlisted function calls rejected (e.g. agent attempting
  `liquidate()`, which was never part of its scoped job)
- Cooldown throttling rapid repeated actions
- Owner emergency pause halting the account even with a valid signature
- Signer rotation immediately revoking the old key's ability to act

One finding worth knowing before you read the tests: **a real
`EntryPoint.handleOps` does not revert the whole bundle when a single
UserOperation fails at execution** (policy block, pause, etc.) — it
catches the failure, emits `UserOperationRevertReason`, and the bundle
still lands with that op marked failed. Tests assert on resulting
contract state, not a top-level revert, for exactly this reason.

## Network

**Arc Testnet** (Circle)
- Chain ID: `5042002`
- RPC: `https://rpc.testnet.arc.io` (also available via Alchemy, QuickNode, dRPC)
- Explorer: `https://testnet.arcscan.app`
- Faucet: `https://faucet.circle.com` (testnet USDC — this is both gas *and* the debt asset here)
- Native gas token: USDC, **18 decimals** — note this differs from the
  ERC-20 USDC interface's 6 decimals; don't mix the two up when reasoning
  about `msg.value` vs. token amounts.
- ERC-4337: natively supported, standard bundlers/paymasters work
- Arc mainnet launches **September 16, 2026** — one day after this
  hackathon's deadline, so testnet is correctly the target for judging.

### EntryPoint address — verify before relying on it

`Deploy.s.sol` defaults to `0x0000000071727De22E5E9d8BAf0edAc6f37da032`,
the widely-referenced ERC-4337 v0.7 canonical address (confirmed deployed
at that same address on Moonbase Alpha, Polygon Amoy, and others via the
deterministic deployer). It is **not independently confirmed specifically
on Arc testnet** as of writing this. Check `testnet.arcscan.app` for code
at that address on Arc before deploying against it, or override via the
`ENTRY_POINT` env var if Arc's bundler docs specify a different one.

## Deployment runbook

This sandbox cannot reach `rpc.testnet.arc.io` directly (outside its
network allowlist), so live deployment needs to run from your own
machine — same limitation as this portfolio's AegisX/Fuji deployment.
Everything below is written, compiled, and unit/integration-tested; only
the actual broadcast step is unverified against live Arc.

```bash
# 1. Env setup
export PRIVATE_KEY=0x...                 # deployer/admin key
export AGENT_SIGNER=0x...                # separate key - see warning below

# 2. (Optional) Deploy mock tokens - skip if using Arc's real faucet USDC
#    as DEBT_TOKEN and you have a real collateral asset address to use.
forge script script/DeployMocks.s.sol --rpc-url arc_testnet --broadcast
# -> copy COLLATERAL_TOKEN and DEBT_TOKEN from the output

export COLLATERAL_TOKEN=0x...
export DEBT_TOKEN=0x...

# 3. Deploy core system
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
# -> copy POLICY_MODULE, PRICE_ORACLE, LENDING_POOL, AGENT_FACTORY from output

export POLICY_MODULE=0x...
export LENDING_POOL=0x...
export AGENT_FACTORY=0x...

# 4. Set the collateral price on-chain (owner-only)
cast send $PRICE_ORACLE "setPrice(address,uint256)" $COLLATERAL_TOKEN 3000000000000000000000 \
  --rpc-url arc_testnet --private-key $PRIVATE_KEY

# 5. Fund the pool with borrowable liquidity (owner-only; requires prior approve)
cast send $DEBT_TOKEN "approve(address,uint256)" $LENDING_POOL 1000000000000 \
  --rpc-url arc_testnet --private-key $PRIVATE_KEY
cast send $LENDING_POOL "fundPoolLiquidity(uint256)" 1000000000000 \
  --rpc-url arc_testnet --private-key $PRIVATE_KEY

# 6. Create + configure the agent account
forge script script/ConfigureAgent.s.sol --rpc-url arc_testnet --broadcast
# -> logs the deployed AgentAccount address

# 7. Manual funding (see ConfigureAgent.s.sol's printed next-steps):
#    - send the AgentAccount native USDC for gas prefunding
#    - mint/send it some collateral token to supply into the pool
```

**Never set `AGENT_SIGNER` to the same key as `PRIVATE_KEY`.** The owner
key should stay cold/manual; the agent signer is the hot key your Phase 3
backend holds and signs routine UserOperations with. `ConfigureAgent.s.sol`
hard-`require`s these differ.

## What Phase 1 deliberately does not include

- A live broadcast to Arc testnet (network-restricted sandbox - see above)
- Contract verification on `testnet.arcscan.app` (etherscan-style
  verification endpoint listed in `foundry.toml` as a placeholder, not
  confirmed working)
- A bundler/paymaster integration - Phase 2/3 will wire `permissionless.js`
  against Arc's bundler once addresses above are broadcast and confirmed
- The off-chain reasoning loop itself (Phase 3: Groq/Llama 3.3 70B,
  bounded tool-use, reads `LendingPool` state and proposes actions)

## Repo layout

```
Cadence-contracts/
├── src/
│   ├── AgentAccount.sol
│   ├── AgentAccountFactory.sol
│   ├── PolicyModule.sol
│   ├── PriceOracle.sol
│   ├── LendingPool.sol
│   ├── interfaces/IPolicyModule.sol
│   └── mocks/{MockUSDC,MockCollateralToken}.sol
├── script/
│   ├── Deploy.s.sol
│   ├── DeployMocks.s.sol
│   └── ConfigureAgent.s.sol
├── test/
│   ├── helpers/TestBase.sol   # deploys full stack, real UserOp build/sign/submit helpers
│   ├── AgentAccount.t.sol
│   ├── PolicyModule.t.sol
│   ├── LendingPool.t.sol
│   └── Integration.t.sol      # full agent-lifecycle + guardrail scenarios
└── foundry.toml
```
