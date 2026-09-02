# Cadence — Frontend (Phase 2 of 3)

Next.js App Router dashboard for the Cadence autonomous DeFi agent,
wired directly to the Phase 1 contracts — no mocked data anywhere in this
app. Every number on screen is a real `useReadContract`/`getLogs` call
against the deployed system, or an explicit "not configured yet" empty
state when it isn't.

## Design

Token system and rationale documented inline in `app/globals.css`. Short
version: a navy-charcoal "ledger" palette (not black, not cream) with
three functional accent colors — jade (safe), brass (value), clay
(risk) — rather than one decorative accent. Newsreader italic is
reserved exclusively for the agent's own reasoning text once Phase 3
wires it in; everything else uses IBM Plex Sans/Mono, so a reader can
tell "the AI is speaking" from "this is a verified on-chain fact" at a
glance without reading closely.

The signature element is the **Vitals Line** (`components/VitalsWaveform.tsx`)
— a waveform of the position's health factor over time, reconstructed
from real historical `healthFactor()` reads pinned to the block of each
past action, not decorative animation.

## How this is wired to Phase 1

- `lib/abis/*.json` — extracted directly from `Cadence-contracts/out/*.sol/*.json`
  (Phase 1's `forge build` output), not hand-written. Re-run the
  extraction below any time the contracts change:
  ```bash
  cd Cadence-contracts && forge build
  python3 -c "
  import json
  for c in ['AgentAccount','PolicyModule','LendingPool','PriceOracle','AgentAccountFactory']:
      d = json.load(open(f'out/{c}.sol/{c}.json'))
      json.dump(d['abi'], open(f'../Cadence-frontend/lib/abis/{c}.json','w'), indent=2)
  "
  ```
- `lib/contracts.ts` — addresses come from `NEXT_PUBLIC_*` env vars, filled
  in after running Phase 1's `Deploy.s.sol` + `ConfigureAgent.s.sol`. See
  `.env.example`.
- `lib/hooks.ts` — `usePositionVitals()` reads `LendingPool.healthFactor()`
  and `.positions()`; `usePolicyRules()` reads `PolicyModule.rules()` for
  the exact four selectors `ConfigureAgent.s.sol` allowlists, plus
  `cooldownSeconds()`.
- `lib/useAgentFeed.ts` — fetches and decodes real `ActionExecuted` logs
  emitted by the deployed `AgentAccount` via `getLogs`. Each feed entry
  links to its transaction on Arcscan.
- `lib/hooks.ts`'s `useHealthFactorHistory()` — reads `healthFactor()` at
  the pinned block number of each of the agent's last 12 actions (real
  historical `eth_call`s), feeding the Vitals Line waveform.

## What's intentionally not here yet

- **Reasoning text.** Each feed entry has a `reasoning-voice` italic slot
  that currently says "reasoning trace connects here once Phase 3's agent
  backend is wired in." That's deliberate — inventing placeholder AI
  commentary would blur the exact distinction (verified on-chain fact vs.
  the model's words) this UI's typography exists to keep sharp.
- **A bundler/paymaster-aware "propose action" UI.** This dashboard is
  read-only by design for Phase 2 — it observes what the agent (Phase 3)
  already did. Wallet connect exists for future write paths (e.g. owner
  emergency pause) but nothing writes yet.
- **Contract verification against a live Arc RPC.** This sandbox can't
  reach `rpc.testnet.arc.io`. Everything here is type-checked, linted, and
  build-verified (`npm run build` succeeds); live data flow is
  unverified until you run it with real deployed addresses.

## Known sandbox limitation

`next/font/google` (Newsreader, IBM Plex Sans, IBM Plex Mono) fetches
font files from `fonts.googleapis.com` at build time, which this sandbox
can't reach — same limitation as this portfolio's AegisX project. Build
was verified clean via a temporary system-font swap; the shipped
`app/layout.tsx` uses the real Google Fonts imports and has not been
re-verified with live font fetching. Run `npm run build` yourself once
you have normal internet access to confirm.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in addresses from Phase 1 deploy output
npm run dev
```

### WalletConnect

Cadence supports EVM wallets only. In MetaMask's in-app browser the UI uses
the injected MetaMask provider. In regular mobile browsers it shows
WalletConnect, which opens its modal and delegates the MetaMask app handoff to
WalletConnect. Phantom is deliberately not listed as a primary connector.

Create a WalletConnect/Reown project and set these public browser variables:

```dotenv
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_reown_project_id
NEXT_PUBLIC_APP_URL=https://your-cadence-domain.example
```

Use `http://localhost:3000` for `NEXT_PUBLIC_APP_URL` in `.env.local` during
local development. On Vercel, use Cadence's final HTTPS domain (without a
trailing slash) and add that same domain to the WalletConnect/Reown project's
allowed domains. The project ID is public configuration, but backend keys,
private keys, and `AGENT_API_KEY` must never be prefixed with `NEXT_PUBLIC_`.
