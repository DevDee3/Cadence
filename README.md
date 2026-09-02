# Cadence

Cadence is an autonomous DeFi position-management agent for Arc. A user connects an EVM wallet, signs a one-time authentication message, creates or selects an AgentAccount, funds the account, and gives Cadence a risk-management instruction. Cadence reads the position, reasons over the available state, checks the on-chain policy, and submits a UserOperation only when the action is safe and allowed.

The project is currently designed for Arc Testnet and should be treated as a testnet application until contracts, keys, transaction limits, and infrastructure have been independently reviewed for production.

## What Cadence does

- Connects EVM wallets through injected wallets and WalletConnect.
- Authenticates wallet ownership with an EIP-191 signed challenge.
- Maps a wallet to its own AgentAccount.
- Provisions a wallet-specific AgentAccount and signer when configured.
- Reads collateral, debt, prices, balances, health factor, policy limits, and recent activity.
- Uses an LLM to produce a structured decision: hold, block, submit, or fail.
- Enforces PolicyModule limits on-chain before actions are submitted.
- Submits transactions through either an ERC-4337 bundler or the relayer path.
- Stores settings, cycles, sessions, agents, signers, and service events in Supabase.
- Displays decision history and verified on-chain actions in the frontend.
- Exposes health, readiness, metrics, and optional webhook alerts.

Cadence is not a promise that every instruction becomes a transaction. A safe `hold` is a successful agent decision when the requested action is unnecessary, unsafe, outside policy, blocked by cooldown, or cannot be simulated safely.

## Repository layout

```text
.
├── backend/       Express + TypeScript agent service
│   ├── src/
│   ├── supabase/schema.sql
│   ├── .env.example
│   └── package.json
├── contract/      Solidity contracts and Foundry scripts
├── frontend/      Next.js + React + Wagmi application
│   ├── app/
│   ├── components/
│   ├── lib/
│   ├── .env.example
│   └── package.json
└── README.md      This document
```

## System architecture

```text
User wallet
   │ connect + sign challenge
   ▼
Next.js frontend on Vercel
   │ server-side proxy + AGENT_API_KEY + cadence session cookie
   ▼
Express backend on Render
   ├── wallet authentication and sessions
   ├── AgentAccount provisioning
   ├── perception and LLM reasoning loop
   ├── policy simulation and UserOperation submission
   ├── scheduler and reconciliation
   └── health, metrics, logs, and alerts
        │
        ├── Arc RPC / EntryPoint / DeFi contracts
        ├── ERC-4337 bundler or relayer
        └── Supabase/PostgreSQL
```

The browser never receives private keys, the Supabase service-role key, or the agent API key. The frontend talks to Next.js route handlers, which proxy protected requests to the backend.

## Prerequisites

- Node.js compatible with the project dependencies.
- npm.
- Git and a GitHub repository for deployment.
- An EVM wallet such as MetaMask or a WalletConnect-compatible mobile wallet.
- Arc Testnet RPC access.
- A WalletConnect Project ID for mobile wallet connections.
- A Groq or Cerebras API key and a currently supported tool-calling model.
- Supabase project access.
- Foundry only if deploying or configuring contracts.

## Install dependencies

From the repository root:

```powershell
cd C:\Users\user\Guardian
cd backend
npm install
cd ..\frontend
npm install
```

## Environment configuration

Create the files from the examples:

```powershell
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env.local
```

Do not commit either file. Do not paste private keys into the frontend environment.

### Backend variables

The backend `.env` contains the complete server configuration:

```dotenv
RPC_URL=https://rpc.testnet.arc.network
CHAIN_ID=5042002
ENTRY_POINT=0x0000000071727De22E5E9d8BAf0edAc6f37da032

AGENT_ACCOUNT=
AGENT_FACTORY=
POLICY_MODULE=
LENDING_POOL=
PRICE_ORACLE=
COLLATERAL_TOKEN=
DEBT_TOKEN=

AGENT_SIGNER_PRIVATE_KEY=
ADMIN_PRIVATE_KEY=
AGENT_SIGNER_ENCRYPTION_KEY=

SUBMISSION_MODE=relayer
RELAYER_PRIVATE_KEY=
BUNDLER_RPC_URL=

LLM_PROVIDER=groq
GROQ_API_KEY=
GROQ_MODEL=qwen/qwen3-32b
CEREBRAS_API_KEY=
CEREBRAS_BASE_URL=https://api.cerebras.ai/v1
CEREBRAS_MODEL=llama-3.3-70b

MAX_REASONING_ROUNDS=6
POLL_INTERVAL_SECONDS=900
PORT=8787
AGENT_API_KEY=
ALERT_WEBHOOK_URL=

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Important rules:

- `AGENT_SIGNER_PRIVATE_KEY` signs agent actions. It is not the encryption key.
- `AGENT_SIGNER_ENCRYPTION_KEY` protects provisioned signer keys at rest. Use a newly generated random 32-byte value represented as 64 hexadecimal characters, without `0x`.
- `ADMIN_PRIVATE_KEY` is used for provisioning and administration. Keep it separate from the agent signer.
- `AGENT_API_KEY` protects backend control endpoints. Generate a long random secret.
- `BUNDLER_RPC_URL` must be a complete URL if `SUBMISSION_MODE=bundler`.
- `RELAYER_PRIVATE_KEY` is required by the relayer submission path.
- Use only the LLM model names actually supported by the provider account.
- `SUPABASE_SERVICE_ROLE_KEY` must stay server-side.

If using the relayer path during testnet development:

```dotenv
SUBMISSION_MODE=relayer
RELAYER_PRIVATE_KEY=0x...
```

If using a production ERC-4337 bundler:

```dotenv
SUBMISSION_MODE=bundler
BUNDLER_RPC_URL=https://your-bundler-endpoint
```

### Frontend variables

The frontend `.env.local` contains public contract and client configuration plus server-only proxy configuration:

```dotenv
NEXT_PUBLIC_AGENT_ACCOUNT=
NEXT_PUBLIC_AGENT_FACTORY=
NEXT_PUBLIC_POLICY_MODULE=
NEXT_PUBLIC_LENDING_POOL=
NEXT_PUBLIC_PRICE_ORACLE=
NEXT_PUBLIC_COLLATERAL_TOKEN=
NEXT_PUBLIC_DEBT_TOKEN=
NEXT_PUBLIC_RPC_URL=https://rpc.testnet.arc.network
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_DEPLOY_BLOCK=

AGENT_BACKEND_URL=http://localhost:8787
AGENT_BACKEND_API_KEY=
```

`AGENT_BACKEND_API_KEY` is used by Next.js server route handlers and is not exposed as a browser `NEXT_PUBLIC_` variable. Its value must match backend `AGENT_API_KEY`.

`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is the public Project ID from the
WalletConnect/Reown dashboard. `NEXT_PUBLIC_APP_URL` is Cadence's canonical
browser URL and is included in WalletConnect metadata so a mobile wallet can
identify Cadence and return to it after approval. Use `http://localhost:3000`
locally, and the final HTTPS Cadence domain (without a trailing slash) in
Vercel. Add that production domain to the project's allowed domains in the
WalletConnect/Reown dashboard. Neither variable is a secret; do not put any
backend keys or signer material in a `NEXT_PUBLIC_` variable.

## Supabase setup

1. Create a Supabase project.
2. Open the SQL Editor.
3. Copy and run `backend/supabase/schema.sql`.
4. Confirm these tables exist:

```text
agent_settings
agent_cycles
wallet_sessions
wallet_agents
agent_signers
service_events
```

5. Confirm `agent_cycles` includes `cycle_id`.
6. Put the project URL and service-role key in the backend environment only.

The service-role key bypasses normal database row-level security and must never be placed in client code, GitHub, Vercel public variables, or screenshots.

## Run locally

Start the backend first:

```powershell
cd C:\Users\user\Guardian\backend
npm run dev
```

Start the frontend in another terminal:

```powershell
cd C:\Users\user\Guardian\frontend
npm run dev
```

Open:

```text
http://localhost:3000
```

The backend listens on:

```text
http://localhost:8787
```

Useful checks:

```powershell
Invoke-RestMethod -Uri http://localhost:8787/health -Method GET
Invoke-RestMethod -Uri http://localhost:8787/ready -Method GET
Invoke-RestMethod -Uri http://localhost:8787/metrics -Method GET
```

Build and type-check the backend:

```powershell
cd backend
npm run typecheck
npm run build
```

Build the frontend:

```powershell
cd frontend
npm run build
```

## First-time user flow

1. Open the frontend.
2. Connect an EVM wallet.
3. Switch the wallet to Arc Testnet.
4. Click the wallet verification/sign-message control.
5. Sign the challenge. This proves wallet ownership; it does not authorize a blockchain transaction.
6. Create or provision an AgentAccount.
7. Fund the displayed AgentAccount with a small test amount.
8. Configure the position and policy.
9. Give Cadence an instruction from the command center.
10. Review the decision and rationale.
11. If Cadence submits a UserOperation, follow the transaction link and confirm it on ArcScan.

The wallet is not expected to approve every agent transaction. Once the agent signer and policy are configured, the agent operates through the account and submission path on the server.

## Giving Cadence instructions

Examples:

```text
Review my position and explain whether it is safe.
```

```text
Keep my health factor above 1.5 and repay debt only if necessary.
```

```text
Supply my deposited collateral only if the action is allowed by policy.
```

```text
Withdraw 10 mCOL only if the position remains safe afterward.
```

The requested amount is not an unconditional authorization. Cadence checks balances, health impact, cooldowns, simulation results, and PolicyModule limits before submitting.

To trigger a backend cycle manually during local development:

```powershell
Invoke-RestMethod `
  -Uri http://localhost:8787/api/agent/run-cycle `
  -Method POST `
  -Headers @{ "x-agent-api-key" = "YOUR_AGENT_API_KEY"; "x-wallet-token" = "YOUR_SESSION_TOKEN"; "content-type" = "application/json" } `
  -Body '{"instruction":"Review my position and act only if it improves safety."}'
```

In normal use, users should use the frontend instead of this command.

## Decisions and transaction states

Common outcomes:

| Status | Meaning |
|---|---|
| `held` | No action was needed or the agent chose to wait safely. |
| `blocked` | The requested action was outside policy or failed a safety check. |
| `submitted` | A UserOperation was accepted and is being reconciled. |
| `executed` | The transaction was confirmed on-chain. |
| `failed` | The action or confirmation failed. |
| `reasoning_failed` | The LLM could not produce a valid decision. |
| `error` | The cycle encountered an infrastructure or contract error. |

An internal cycle UUID may exist in API responses, logs, and database rows for support and reconciliation. It is intentionally not shown in the normal user-facing result.

## Deployment: backend on Render

1. Push the repository to GitHub.
2. In Render, select **New → Web Service** and connect the repository.
3. Set:

```text
Root Directory: backend
Runtime: Node
Build Command: npm ci && npm run build
Start Command: npm start
Health Check Path: /ready
```

4. Use an always-on instance because the backend runs the scheduler.
5. Add every backend variable from `backend/.env.example` in Render’s environment settings.
6. Set the production `AGENT_API_KEY` and copy the same value later to Vercel as `AGENT_BACKEND_API_KEY`.
7. Deploy and inspect the logs.
8. Verify:

```text
https://YOUR-SERVICE.onrender.com/health
https://YOUR-SERVICE.onrender.com/ready
https://YOUR-SERVICE.onrender.com/metrics
```

9. Keep one scheduler instance unless the scheduler is redesigned for distributed locking. Multiple active instances can produce duplicate cycles.

## Deployment: frontend on Vercel

1. In Vercel, select **Add New → Project** and import the GitHub repository.
2. Set the project root directory to `frontend`.
3. Use the Next.js framework preset.
4. Add the frontend public variables from `frontend/.env.example`.
5. Add these server-side variables:

```text
AGENT_BACKEND_URL=https://YOUR-SERVICE.onrender.com
AGENT_BACKEND_API_KEY=the-same-value-as-Render-AGENT_API_KEY
```

6. Deploy a Preview first and test it.
7. After acceptance testing, add the variables to the Production environment and deploy Production.
8. Attach the custom domain only after wallet authentication, proxy requests, and cookies have been tested on the final HTTPS domain.

Do not add any of the following to Vercel:

```text
SUPABASE_SERVICE_ROLE_KEY
ADMIN_PRIVATE_KEY
AGENT_SIGNER_PRIVATE_KEY
AGENT_SIGNER_ENCRYPTION_KEY
RELAYER_PRIVATE_KEY
GROQ_API_KEY
CEREBRAS_API_KEY
```

These variables must remain server-side and must not be exposed as `NEXT_PUBLIC_` values.

## Production checklist

Before opening the application to users:

- Deploy and verify the contracts on the intended production network.
- Generate new production keys; never reuse testnet keys.
- Store all secrets in Render/Vercel secret management.
- Confirm the bundler endpoint and `BUNDLER_RPC_URL` are valid.
- Fund the relayer or bundler sponsorship path appropriately.
- Configure strict PolicyModule limits and cooldowns.
- Confirm price oracle behavior and stale-price handling.
- Run wallet login and refresh tests on desktop and mobile.
- Provision two separate test wallets and verify their AgentAccounts do not overlap.
- Test hold, blocked, submitted, confirmed, failed, and retry paths.
- Test backend restart and UserOperation reconciliation.
- Confirm Supabase writes to all six tables.
- Configure `ALERT_WEBHOOK_URL` and verify an alert reaches the destination.
- Monitor `/ready`, `/metrics`, Render logs, RPC errors, LLM errors, and failed transactions.
- Perform a smart-contract and application security review before handling meaningful funds.
- Start with small deposit and transaction limits.

## Troubleshooting

### `Couldn't reach the RPC endpoint`

Check that `RPC_URL` and `NEXT_PUBLIC_RPC_URL` are valid Arc endpoints, the backend and browser have network access, and the wallet is on the expected chain. Test the backend `/ready` endpoint and inspect Render logs.

### `BUNDLER_RPC_URL: Invalid URL`

Use a complete URL including `https://`, for example:

```dotenv
BUNDLER_RPC_URL=https://provider.example/rpc/project-key
```

If using the relayer path, set `SUBMISSION_MODE=relayer` and configure `RELAYER_PRIVATE_KEY` instead.

### `The contract function getPrice reverted`

Verify `PRICE_ORACLE`, `COLLATERAL_TOKEN`, chain ID, deployment addresses, and oracle configuration. A wrong-network or wrong-contract address commonly causes this error.

### `The contract function handleOps reverted`

Check EntryPoint, account, signer, nonce, policy configuration, token approvals, account balances, relayer balance, and UserOperation simulation. Inspect the complete backend error rather than only the first line.

### The agent returns `held`

This is not automatically an error. Read the rationale. Cadence may be waiting because the position is safe, cooldown is active, the amount is unavailable, the action is outside policy, or acting would worsen risk.

### History is empty

Confirm the frontend is connected to the same AgentAccount that the backend is using, the wallet has been verified, Supabase contains `agent_cycles`, and the Render backend is reachable from the Vercel deployment.

### `Could not find the cycle_id column`

Run the migration in Supabase:

```sql
alter table agent_cycles add column if not exists cycle_id text;
```

### WalletConnect does nothing

Check `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, use HTTPS in deployed environments, confirm the mobile wallet supports the selected EVM chain, and test the WalletConnect QR/deep link on a real mobile device.

### Wallet popup appears after every refresh

The app is configured for silent reconnect. A popup after refresh generally means the wallet connector is requesting authorization rather than restoring an existing session. Check connector configuration, browser wallet permissions, and whether the user previously disconnected the wallet.

### Model `404` or tool-call validation errors

The configured model is unavailable or does not support the required tool-calling format. Select a model listed by the provider account and restart the backend after changing `GROQ_MODEL` or `CEREBRAS_MODEL`.

## Security model

Cadence is designed so the agent signer is constrained by the deployed PolicyModule. This reduces the blast radius of a compromised agent key, but it is not a substitute for contract audits, key protection, correct deployment addresses, monitoring, or conservative limits.

- Never expose private keys in frontend code or API responses.
- Never commit `.env` files.
- Rotate API keys if they are pasted into a chat, issue, log, or screenshot.
- Use separate wallets and keys for development, testnet, staging, and production.
- Restrict Supabase service-role access to the backend.
- Keep transaction limits small until the complete system has been observed in production.
- Review all requested actions as untrusted input.
- Treat LLM output as a proposal. The backend and on-chain policy must remain authoritative.

## Operational notes

The scheduler runs automatically according to `POLL_INTERVAL_SECONDS`. Manual cycles are rate-limited per wallet, and the cycle queue prevents overlapping submissions from competing for the same nonce. Submitted UserOperations are reconciled after submission so a delayed confirmation can later become `executed` or `failed`.

For production, keep the Render service continuously running, retain logs, configure alerts, and use a database-backed deployment rather than relying on local JSON fallback storage. Supabase is the intended persistent store keyed by wallet and AgentAccount.

## License and status

Cadence is an active development project. Review the contract license and repository history before redistributing. The current application has been tested on Arc Testnet; production-network deployment requires separate contract deployment, keys, addresses, infrastructure, and security validation.
