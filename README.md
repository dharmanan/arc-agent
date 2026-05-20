# Arc Machina

Arc Machina is an Arc Testnet agent wallet product with passkey auth, Tasks automation, paid execution rails, bridge/swap flows, jobs, and Oracle/x402 surfaces.

## What is live now

- Passkey-based user and agent management
- Arc Testnet bridge and swap flows
- Tasks with free jobs, paid execution tasks, and automation controls
- Jobs lifecycle with agentic economy hooks
- Oracle public/private surfaces with x402 payment flow
- Circle Paid kept in maintenance-only mode with live cards active and preview roadmap cards still visible

## Workspace layout

- `frontend/`: Vite + React client
- `backend/`: Express API, Bull queue, DB integrations, task execution services
- `contracts/`: deployed contract sources and related scripts
- `artifacts/`: compiled contract artifacts and snapshots
- `docs/`: public-facing guides and notes

## Local development

Requirements:

- Node.js 20+
- A configured backend and frontend environment
- Reachable Postgres and Redis endpoints

Environment files used in practice:

- `backend/.env` for API, DB, Redis, auth, queue, and chain settings
- `frontend/.env` for `VITE_*` browser settings such as API URL and WalletConnect project id

Useful commands from the repo root:

```bash
npm run frontend:dev
npm run backend:dev
```

Useful commands inside `backend/`:

```bash
npm start
npm test -- --runTestsByPath src/services/__tests__/circlePaidCatalogService.test.js
node scripts/paidTaskSmoke.js --stable-only --wallet <agent-wallet-address>
```

## Current testing baseline

- Backend Jest is now wired and includes a catalog regression test for the Circle Paid visible-roadmap state.
- Paid task smoke can run in `stable-only` mode with an explicit wallet address, so preflight checks no longer depend on a local DB connection.

## Deployment notes

- Frontend production target: Vercel project `arc-agent-frontend`
- Backend production target: Railway service `backend`
- In Codespaces, prefer `npx -y @railway/cli ...` instead of assuming a global `railway` install

## Current product direction

- Keep Circle Paid in maintenance-only mode until a stronger external x402/tool fit exists, while leaving live and preview cards visible in the product
- Expand autonomy only on verified stable rails first
- Keep cirBTC paid tasks on the live direct pair rail and expose that later in the manual DeFi surface