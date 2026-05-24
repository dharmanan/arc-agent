# Arc Oracle Public Buyer Guide

## What This System Is

Arc exposes paid Oracle endpoints over the x402 protocol using Circle Gateway as the settlement rail.

This means a third-party buyer can call Arc's public Oracle APIs without creating an Arc account, as long as the buyer can:

- sign nanopayment authorizations with an EOA wallet
- hold USDC on a supported chain
- complete the x402 payment flow

Arc is the seller. The external integrator is the buyer.

## What Arc Adds on Top of Circle

Circle's quickstarts describe the standard seller flow and the standard buyer flow separately:

- seller returns `402 Payment Required`
- buyer inspects the payment terms
- buyer deposits USDC into Gateway when needed
- buyer retries with `Payment-Signature`
- seller settles with Gateway and serves the resource

Arc keeps that wire-level compatibility, but adds a more productized buyer pattern for Arc-managed agents:

- Oracle `402` responses include a `docsUrl` so buyers know where to go next
- Arc's internal buyer helper auto-funds Gateway when wallet USDC exists but Gateway available balance is still empty
- Arc keeps standard `Bridge`, `Swap`, `Send`, and `Receive` flows separate from paid Oracle, Tasks, Jobs, and nanopayment economy rails

## Why Arc Is More Convenient Than Raw Circle Buyer Flow

The raw Circle buyer quickstart expects the buyer to manage deposit timing directly.

Arc's buyer helper improves that by turning the flow into:

1. request the paid resource
2. inspect the `402` payment terms
3. deposit only if Gateway balance is short
4. sign the payment payload
5. retry automatically with the payment header

That reduces the most common integration failure:

- wallet has USDC
- Gateway available balance is `0`
- direct `pay()` call fails with `insufficient_balance`

Arc's helper closes that gap by funding Gateway on demand before the paid retry.

## How The Public Oracle Payment Flow Works

### Seller side

Arc's public Oracle routes are protected by Circle Gateway seller middleware.

When the buyer sends an unpaid request:

- Arc returns `402 Payment Required`
- response body includes `error`, `endpoint`, `price`, `sellerMode`, `callbackEndpoint`, and `docsUrl`
- `PAYMENT-REQUIRED` response header carries the x402 payment terms

When the buyer retries with a valid `Payment-Signature` header:

- Arc settles through Gateway
- Arc returns the Oracle resource payload
- `PAYMENT-RESPONSE` can include the settlement transaction identifier

### Buyer side

The buyer must:

1. use an EOA private key
2. have USDC on the configured chain
3. ensure Gateway available balance is large enough for the requested payment
4. create a valid x402 payment payload
5. resend the request with the signed payment header

## Important Limitation: EOA Required

Buyer wallets must be EOAs.

Smart contract accounts are not supported for this nanopayment flow because Circle Gateway verifies signatures off-chain with `ecrecover`, which does not support EIP-1271 contract signatures.

## Current Oracle Public Endpoints

- `/api/oracle/public/stablecoin-fx`
- `/api/oracle/public/pool-state`
- `/api/oracle/public/peg-monitor`
- `/api/oracle/public/pool-compare`
- `/api/oracle/public/wallet-asset-snapshot`
- `/api/oracle/public/prediction-market-check`
- `/api/oracle/public/event-odds-compare`
- `/api/oracle/public/arb-signal`
- `/api/oracle/public/arb-scan-multi`

These are ordinary HTTP endpoints. The paid behavior appears only when the route returns `402` and the client follows the x402 flow.

For supported verified pairs, `/api/oracle/public/stablecoin-fx` also returns an `arcCurvePool` object with the live Arc Curve pool snapshot used for on-chain comparison.

New catalog additions:

- `/api/oracle/public/peg-monitor` returns spot stablecoin peg health with explicit `isFallback` metadata when upstream pricing degrades.
- `/api/oracle/public/pool-compare` compares multiple pool targets side by side across `curve`, `uniswap_v2_like`, and `arcfx`.
- `/api/oracle/public/wallet-asset-snapshot` returns Arc wallet balances, live LP positions, and a yesterday UTC recap when the requested wallet is already indexed as an Arc agent.
- `/api/oracle/public/prediction-market-check` returns a live Polymarket-based crypto regime snapshot with liquidity, movement and Arc action guidance.
- `/api/oracle/public/event-odds-compare` compares two Polymarket topic clusters and scores whether they stay aligned, split, or diverge enough to change the next Arc move.
- `/api/oracle/public/arb-scan-multi` scans multiple stable lanes at once and returns the best currently profitable arbitrage candidate.

`reserve-state` stays out of the public seller catalog until the deployment has a live reserve source configured.

## Current Verified Arc Pair Coverage

Currently verified live Arc pool lanes exposed by the Oracle are:

- `EURC/USDC` for `stablecoin-fx`
- `EURC/WUSDC` for `stablecoin-fx`
- `USDC-EURC`, `EURC-USDC` for `pool-state`
- `EURC-WUSDC`, `WUSDC-EURC` for `pool-state`
- `WUSDC-USDC`, `USDC-WUSDC` for `pool-state`

`USDC-USYC` and `USYC-USDC` are still mapped for `pool-state`, but the current Arc Curve pools remain empty on-chain.

Experimental external pool coverage currently exposed through paid routes:

- `QTM-WUSDC` on `uniswap_v2_like`
- `MUSDC-MEURC` on `arcfx`

## Recommended Integration Options

### Option 1: Use Circle's raw buyer client

This works today, but the buyer must manage deposit behavior explicitly.

Best when:

- you already have a Circle/x402 client
- you want full low-level control

### Option 2: Use Arc's example buyer helper

This is the recommended starting point for third-party integrators.

The helper wraps:

- unpaid request preview
- Gateway balance check
- on-demand Gateway deposit
- signed retry with `Payment-Signature`

See:

- `backend/examples/arcOracleBuyerHelper.js`
- `backend/examples/oraclePublicBuyerExample.js`

## Quick Start

From the backend package:

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=pool-state \
ORACLE_PUBLIC_POOL=USDC-EURC \
node examples/oraclePublicBuyerExample.js --preview
```

`--preview` performs the unpaid request and prints the `402` metadata, including `docsUrl`.

To execute the paid retry:

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=pool-state \
ORACLE_PUBLIC_POOL=USDC-EURC \
node examples/oraclePublicBuyerExample.js
```

For the new `EURC/WUSDC` lane:

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=stablecoin-fx \
ORACLE_PUBLIC_PAIR=EURC/WUSDC \
node examples/oraclePublicBuyerExample.js --preview
```

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=pool-state \
ORACLE_PUBLIC_POOL=EURC-WUSDC \
node examples/oraclePublicBuyerExample.js --preview
```

Preview the new peg health SKU:

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=peg-monitor \
ORACLE_PUBLIC_ASSETS=USDC,EURC,USDT \
node examples/oraclePublicBuyerExample.js --preview
```

Preview the pool comparison SKU:

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=pool-compare \
ORACLE_PUBLIC_TARGETS=curve:USDC-EURC,curve:EURC-WUSDC,uniswap_v2_like:QTM-WUSDC \
node examples/oraclePublicBuyerExample.js --preview
```

Preview the event comparison SKU:

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=event-odds-compare \
ORACLE_PUBLIC_PRIMARY_TOPIC=bitcoin \
ORACLE_PUBLIC_SECONDARY_TOPIC=ethereum \
ORACLE_PUBLIC_LIMIT=4 \
node examples/oraclePublicBuyerExample.js --preview
```

Preview the wallet snapshot SKU:

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=wallet-asset-snapshot \
ORACLE_PUBLIC_WALLET_ADDRESS=0x000000000000000000000000000000000000dEaD \
node examples/oraclePublicBuyerExample.js --preview
```

If the requested wallet already exists as an indexed Arc agent, the response also includes a yesterday UTC recap of swaps, LP changes, lending actions, and modeled oracle signals. Non-indexed wallets still return balances and positions, but `dailySummary.status` stays `unavailable`.

Preview the multi-lane arbitrage scanner SKU:

```bash
cd backend
ORACLE_BUYER_PRIVATE_KEY=0xyour_eoa_private_key \
ORACLE_PUBLIC_BASE_URL=https://your-public-arc-oracle-base-url \
ORACLE_PUBLIC_ENDPOINT=arb-scan-multi \
ORACLE_PUBLIC_TARGETS=curve:EURC-USDC,curve:EURC-WUSDC,curve:WUSDC-USDC \
node examples/oraclePublicBuyerExample.js --preview
```

The API base URL is not an admin secret. These paid Oracle routes are public seller endpoints by design, so third-party buyers must be able to reach them. Protect private and operator-only routes separately with JWT or admin auth, keep rate limits enabled, and during testnet prefer the public alias (`https://arcmachina.xyz/api`) instead of documenting a raw infrastructure hostname.

## Environment Variables Used By The Example

- `ORACLE_BUYER_PRIVATE_KEY`: EOA private key used for Gateway deposit and x402 signing
- `ORACLE_PUBLIC_BASE_URL`: Arc backend base URL
- `ORACLE_PUBLIC_ENDPOINT`: one of `stablecoin-fx`, `pool-state`, `peg-monitor`, `pool-compare`, `wallet-asset-snapshot`, `prediction-market-check`, `event-odds-compare`, `arb-signal`, `arb-scan-multi`
- `ORACLE_BUYER_CHAIN`: defaults to `arcTestnet`
- `ORACLE_BUYER_RPC_URL`: optional RPC override
- `ORACLE_PUBLIC_PAIR`: query parameter for `stablecoin-fx`
- `ORACLE_PUBLIC_POOL`: query parameter for `pool-state`
- `ORACLE_PUBLIC_ASSETS`: comma-separated assets for `peg-monitor`
- `ORACLE_PUBLIC_TARGETS`: comma-separated `venue:pool` targets for `pool-compare` or `arb-scan-multi`
- `ORACLE_PUBLIC_WALLET_ADDRESS`: target wallet for `wallet-asset-snapshot`
- `ORACLE_PUBLIC_TOPIC`: query parameter for `prediction-market-check`
- `ORACLE_PUBLIC_PRIMARY_TOPIC`: first topic cluster for `event-odds-compare`
- `ORACLE_PUBLIC_SECONDARY_TOPIC`: second topic cluster for `event-odds-compare`
- `ORACLE_PUBLIC_LIMIT`: optional sample size for `prediction-market-check` or `event-odds-compare`
- `ORACLE_PUBLIC_STRATEGY`: query parameter for `arb-signal`

## Example Unpaid Response Body

```json
{
  "error": "payment_required",
  "endpoint": "pool-state",
  "price": "0.001 USDC",
  "sellerMode": "circle_gateway",
  "callbackEndpoint": "https://your-public-arc-oracle-base-url/api/oracle/public/pool-state?pool=USDC-EURC",
  "docsUrl": "https://arcmachina.xyz/oracle-public-buyer-guide.html",
  "note": "Retry with the payment headers returned by the Circle Gateway x402 flow."
}
```

## When To Override The Documentation URL

The backend defaults `docsUrl` to the public Vercel guide URL for this integration.

If you publish a dedicated external docs page, set:

```bash
ORACLE_BUYER_DOCS_URL=https://your-public-docs.example.com/arc-oracle-buyer-guide
```

This is the recommended production setup for external integrators.