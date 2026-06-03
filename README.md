# Arc Machina



Arc Machina exists because the agent economy still asks non-technical users to do too much by hand: write code, manage raw private keys, stitch together fragile testnet infrastructure, and find usable data before an agent can do anything meaningful.

This project turns that broken path into one product. A user connects a normal wallet, creates a separate agent wallet, protects that agent with a passkey, sets limits and permissions, and then uses the agent for swaps, bridges, DeFi actions, jobs, paid research cards, and background automation.

The product is also built around a harder observation about Arc itself. The usable Arc Testnet data shelf was much thinner than it should have been. That is why Arc Machina became more than an agent wallet. It also became an Oracle surface, a paid information surface, and a request-by-request x402 product surface.

The project is built around one idea: the person and the agent should feel clearly separated. Your connected wallet is the owner account. The agent gets its own wallet, its own operating rules, its own history, and its own onchain identity path. That separation is what makes the rest of the product understandable.

This README is split in two parts. The first half is written for non-technical readers who want to understand what the product does from the first click to a working agent. The second half is written for developers who need to understand the codebase, the services, the queue model, the contracts, and the deployment shape.

## Part I. Product Guide

### 1. Product Structure

When you open the app, the product is organized around these top-level areas:

1. Landing
	The introduction to the product. It explains the no-code promise and sends the user into the application.

2. Dashboard
	The control room. This is where a user sees balances, wallet addresses, recent activity, automation state, DeFi positions, and quick actions.

3. Bridge
	The cross-chain movement page. It handles Circle CCTP style bridging, destination gas fanout, and bridge tracking.

4. Swap
	The token conversion page. It gives quotes and lets the agent swap supported assets on Arc Testnet.

5. Agent
	The identity and control page. This is where users create or reconnect an agent, register passkeys, view onchain identity status, set limits, and choose smart behavior.

6. Jobs
	The marketplace-style work page. It supports creating jobs, receiving applications, assigning providers, delivering work, reviewing outcomes, and handling disputes.

7. Tasks
	The operational action page. It combines free checks, paid actions, Circle Paid information cards, and automation controls in one place.

8. Oracle
	The paid data product page. It explains the public x402 flow, current endpoint catalog, Gateway status, observability, and buyer readiness.

9. Trade
	The strategy page for a near-term deterministic algorithmic trading lane.

10. DeFi
	 The liquidity and lending page. It is the place for LP management, carry visibility, reserve watch, and stable lending actions.

### 2. Repository Structure

At a repository level, the project is organized like this:

```text
arc-agent/
  frontend/
  backend/
  contracts/
  scripts/
  docs/
  artifacts/
  config/
  frontend/public/
  backend/examples/
```

1. `frontend/`
	The full user interface. This is the Vite and React application that renders every tab a user sees.

2. `backend/`
	The API, queue workers, protocol adapters, agent services, payment rails, and database logic.

3. `contracts/`
	Solidity sources for the wallet, commerce, revenue, and reputation parts of the system.

4. `scripts/`
	Root-level deployment helpers, smoke scripts, and operational utilities.

5. `docs/`
	Human-readable documentation, especially for public Oracle buyer onboarding.

6. `artifacts/`
	Compiled contract artifacts and stored snapshots that support deployment and inspection.

7. `frontend/public/`
	Public static assets that ship with the app, including the Oracle buyer guide, manifest, and downloadable examples.

8. `backend/examples/`
	Example buyer clients and helper code for the public Oracle flow.

9. Local planning files such as `ACTION-PLAN.local.md`, `MASTER-PLAN.local.md`, and `final.md`
	These are not the product itself, but they explain why the product evolved in its current direction. This README was written from those decisions and then cross-checked against the live code.

### 3. What Arc Machina Actually Does

At a product level, Arc Machina combines five ideas in one system.

1. It creates a separate operational wallet for an agent.
	The user still owns the experience through their connected wallet, but the actual work is done by the agent wallet.

2. It gives that agent a secure identity and control model.
	Passkeys handle everyday authentication. The private key exists as a recovery-grade secret and is shown once at creation. Onchain identity registration can then link the agent to a testnet identity record.

3. It lets the user move from manual actions into guided automation.
	A user can start with simple swaps and bridges, move into LP and lending actions, and then selectively enable automation features when they understand the risks.

4. It turns information into a paid product.
	Oracle endpoints, paid task rails, and Circle Paid cards make information and execution part of the same economic system.

5. It keeps the product understandable for non-coders.
	The UI explains what is informational, what is actionable, what is automatic, what is still preview, and what funds are actually moving.

### 3.1 Why the Data Layer Looks Different

Arc Machina did not start from the assumption that a healthy Arc-native paid data shelf already existed.

A direct snapshot audit of the Circle x402 service catalog was run in mid-May 2026 to see where agents could actually buy raw data or infrastructure on Arc Testnet.

The result was a useful reality check.

1. `39` services were probed.

2. `515` endpoints were probed.

3. The classification result was heavily one-sided.
	`1` service looked Arc Testnet compatible, `33` were mainnet-only or otherwise not usable for the Arc Testnet product path, `1` was effectively open or not meaningfully paywalled, and `4` remained unknown in the audit snapshot.

4. The only Arc Testnet-compatible service that surfaced was `quicknode-rpc`.
	That is useful infrastructure, but it is not a full shelf of end-user intelligence products that a non-technical agent operator can browse, unlock, and trust.

5. That gap changed the product direction.
	Instead of waiting for a mature marketplace to appear, Arc Machina built its own Oracle and paid information surfaces, packaged them as request-by-request SKUs, and exposed them through the app as both buyer and seller experiences.

This is why the data layer in Arc Machina feels more opinionated than a generic wallet.
The product had to become a data product surface because the ecosystem shelf was mostly empty.

### 3.2 Why Payment Rails Are Split On Purpose

Arc Machina does not push every action through one economic rail.

That separation is deliberate.

1. Standard user actions such as `Bridge`, `Swap`, `Send`, and `Receive` stay in their normal execution lanes.

2. Agent economy actions such as public Oracle access, paid tasks, job-side micro-fees, and buyer-funded automation flows use the x402 and Circle Gateway rail.

3. That split keeps the product understandable.
	A user can still think of simple wallet actions as normal execution, while paid information and agent-economy behavior clearly belong to a separate payment model.

4. That split also keeps the codebase safer to evolve.
	Bridge and swap reliability can improve without forcing every user action into the micro-payment economy layer, while Oracle, tasks, and jobs can keep getting richer economic semantics.

### 3.3 Why the intelligence layer starts deterministic and moves toward LLM dominance

Arc Machina is not trying to look fully LLM-native before users can trust it.

That is a deliberate product choice.

1. The first layer is deterministic.
	Hard limits, policy engines, allowlists, and explicit execution guardrails come first.

2. Smart mode stays opt-in.

3. LLMs currently provide explanation, interpretation, and selective decision support.

4. In the current implementation, policy and execution layers still decide which onchain transaction goes through which adapter.

5. The longer-term product direction is more autonomous.
	As audit evidence, operator trust, and success rates improve, more decision weight is expected to move from fixed policy logic toward more dominant LLM orchestration.

6. The next efficiency layer is not only LLM output.
	Historical outcomes, execution quality, review signals, and risk behavior can also feed machine-learning-assisted ranking, timing, and sizing models.

The goal is not to remove guardrails on day one.
The goal is to make the intelligence layer more capable over time while keeping the system readable and safe today.

### 3.4 Why agent portability matters

Arc Machina is not meant to be a permanent closed cage.

One of the long-term goals is to let a user eventually take the agent with them.

1. As the user becomes more technical, the product should not force them to stay only inside a hosted UI.

2. Over time, the agent's packaged state, configuration, permissions, history, and required data layer should be able to leave through a paid export or handoff model.

3. That would let the user connect the agent to their own backend, infrastructure, or strategy stack and continue independently.

4. This does not only mean a raw export.
	With the right packaging and permission model, an agent delivered with stored decision history, task history, snapshots, settings, and behavioral memory is also a realistic long-term product direction.

This is why Arc Machina is not only a panel.
It is also an on-ramp that should eventually be able to hand the agent back to its owner.

### 3.5 Why Trade and the marketplace are the next major step

The Trade surface is not a decorative roadmap tab, but it is not a fully opened execution product yet either.

The near-term direction is clear:

1. Open a deterministic autonomous trading lane.

2. Connect that lane to DEX execution APIs.

3. Continuously read data and update entry, exit, and risk decisions.

4. Turn successful patterns, execution quality, and strategy behavior into future x402 products.

5. Let some lanes evolve into copy-trade or follow-style agent products for other agents.

That direction does not require the first live lane to start on Arc.
An ETH-first trading core can begin on more practical rails such as Sepolia or Base and later move into Arc-facing execution, while the current TradingView surface remains the early public strategy reference.

That direction naturally points toward a larger marketplace.

In the longer run, Arc Machina aims at an agent-native marketplace for endpoints, APIs, data SKUs, execution intelligence, and strategy products. That surface is not meant to remain a general human browsing portal. The direction is toward tighter access for signed, machine-verifiable agent clients that can prove identity, policy posture, and payment readiness.

### 3.6 Why reputation is more than a score and can become the core of an agent exchange

In Arc Machina, reputation is not meant to be a cosmetic number.

The long-term value comes from the combination of several layers:

1. Meaningful work is stored as local event history.
	The `agent_reputation_events` table keeps transaction, Oracle query, DeFi loop, daily task, and job review timeout events together with their score impact.

2. That history can also be linked onchain.
	Once the agent identity is attached to an ERC-8004-style token, the `ReputationRegistry` can mirror the local score into an Arc-readable onchain score.

3. The score is shown online, not buried in logs.
	The frontend already exposes the local score, recent events, onchain score status, ERC-8004 token link, and tracking switch in a user-readable way.

4. Economic history is recorded separately as well.
	The `agentic_payment_events` table keeps the x402 and Gateway-backed audit trail for tasks, jobs, Oracle purchases, and related buyer-side payment flows. That means the product can show not only what an agent claims to do, but what it actually paid for and completed.

5. That combination makes a future agent exchange realistic.
	An agent can eventually be evaluated not only as a prompt or strategy, but as a portable digital operator with identity, readable history, payment trail, reputation, and behavioral memory.

That is why a future agent-native marketplace in Arc Machina does not need to stop at endpoints and strategies. It can also become a stronger exchange for agents whose history, trust score, and economic footprint are legible.

### 4. First-Time User Journey

If someone opens Arc Machina for the first time, this is the intended path.

1. Start on the Landing page.
	The opening screen explains the pitch in plain language: no code, autonomous agents, and an always-on digital workforce. From there the user enters the app.

2. Connect the owner wallet.
	The connected wallet is the human owner account. It is not the same as the agent wallet. This distinction matters throughout the product.

3. Go to the Agent tab and choose one of two paths.
	A new user chooses `Create New Agent`. A returning user chooses `Reconnect Existing Agent`.

4. If creating a new agent, prove wallet ownership first.
	The backend creates a short-lived wallet registration challenge. The owner wallet signs that challenge. This prevents someone from registering a passkey for a wallet they do not control.

5. Register a passkey.
	After wallet ownership is proven, the app generates WebAuthn registration options. The user completes passkey registration on their device. That passkey becomes the normal way to authenticate back into the app.

6. Create the agent wallet.
	Once the passkey flow is completed, the app creates the agent record and shows the agent private key exactly once.

7. Save the private key.
	The product makes this step explicit. The key is shown once and then hidden forever. The user is expected to save it in a password manager or vault.

8. Re-enter the main Agent view.
	After the private key acknowledgement, the main agent screen appears. This is the moment where the user begins operating the agent itself.

9. Check the identity status.
	The agent can move through `pending`, `registered`, `failed`, or `not configured` identity states. This is the onchain identity registration path. If registration fails, the UI exposes a retry action.

10. Fund the agent wallet.
	 The product expects the agent wallet to hold gas and working assets. The UI makes the agent wallet address visible and warns when the wallet has no USDC. For new wallets, Tasks also explains the recommended funding order: Sepolia ETH first, then gas fanout to supported testnets, then Circle faucet USDC if needed.

11. Set limits before enabling behavior.
	 The Agent tab exposes the daily limit, max trade size, gas cap, slippage, EURC inventory controls, wallet reserve controls, auto-lock timing, and contract guard.

12. Choose whether the agent stays basic or becomes smart.
	 In basic mode, the product still works with deterministic and rule-based behavior. In smart mode, the user can add an LLM key, choose a model, test the connection, and unlock richer decision logic.

	 The longer-term direction is broader: as trust and audit evidence grow, this layer is expected to move toward more dominant LLM decision-making and later machine-learning-assisted efficiency models.

13. Choose what the agent is allowed to do.
	 Strategy preferences and automation switches limit where the agent may act. This is a deliberate safety layer. The product does not assume full autonomy by default.

14. Start with manual surfaces.
	 Users can bridge, swap, run free task checks, inspect Oracle products, or manage DeFi manually before turning on any automation.

### 5. Page by Page Guide

#### Landing

1. The Landing page is the promise of the product in one screen.
	It tells the user that Arc Machina is meant for people who do not want to write code but still want to use agents.

2. The `Enter the Future` action moves the user into the app shell.

3. The `Try Me` action opens a demo-style modal instead of pretending that the landing page itself is the product.

4. The page also makes the current environment clear.
	It marks the product as `TESTNET LIVE`, which matters because some lanes are operational while others are still preview or staged.

#### Dashboard

1. The Dashboard is the first real working screen.
	It is built to answer the question, "What does my agent own, what has it done, and what is it doing now?"

2. Wallet and portfolio summary live here.
	The user sees balances across the supported chains, including Arc Testnet and Sepolia context.

3. The agent and owner addresses are shown together.
	This is important because the owner wallet is the human controller, while the agent wallet is the one that executes operations.

4. Send and Receive live here.
	The Dashboard opens the payment modal for direct wallet interactions. Receive generates amount-specific QR requests. Send only accepts Arc Testnet USDC payment URIs, rejects wrong-network or wrong-token requests, warns on oversized QR amounts, and requires a passkey above the configured limit.

5. Stable automation state is summarized here.
	The Dashboard exposes the latest stable DeFi loop decision, the latest action, wallet inventory, protected reserve, and hold reasons.

6. cirBTC automation state is summarized here.
	This helps the user understand whether the direct-pair LP lane is waiting, adding, holding, or trimming.

7. Live DeFi positions are summarized here.
	The `Agent Positions` card reads live LP positions so users can see if the agent currently holds a pool position.

8. Lending is summarized here.
	The `Lending Summary` card shows top-level stable supply and borrow state, then directs the user to DeFi for the full action surface.

9. Recent Activity is the audit trail the user sees most often.
	It merges sends, receives, bridges, swaps, LP actions, lending actions, oracle-triggered actions, and task outcomes into one readable stream.

10. Quick actions keep the product moving.
	 The Dashboard includes simple navigation shortcuts to Bridge, Swap, and Agent Settings.

#### Agent

1. The Agent tab is the lifecycle page for the agent itself.
	It is where a user creates, reconnects, tunes, and if necessary removes the agent.

2. Create and reconnect are separated clearly.
	New users register a passkey and create a wallet. Returning users authenticate with the passkey to restore the session.

3. The private key reveal step is intentionally explicit.
	The app pauses and tells the user that the secret is only shown once.

4. The main identity card tells the user what agent is active.
	It shows the agent name, the agent wallet address, session controls, and whether Smart Mode is on.

5. The onchain identity section explains whether the agent has been registered onchain.
	The user can see if identity registration is pending, successful, failed, or skipped. Failed identity can be retried.

6. Security and limits are handled here.
	The user sets the daily limit, max trade size, EURC cap, EURC reserve, max gas, slippage, auto-lock window, and contract guard.

7. Smart Agent Mode lives here.
	Users can stay in basic mode or turn on smart mode, add an LLM key, pick a model, and run a live connection test.

	Today this layer is intentionally staged. The point is not to open invisible full autonomy too early, but to grow into a stronger intelligence layer as users gain confidence in what the agent is doing.

8. Strategy Preferences live here.
	These permissions work together with Tasks and Automation. They are the behavioral boundary around what the agent is allowed to attempt.

9. The page includes a hard warning when the wallet lacks USDC.
	This matters because paid tasks, paid unlocks, and many automated flows need working balance.

10. The page ends with a true danger zone.
	 Deleting an agent is clearly marked as irreversible.

#### Bridge

1. The Bridge tab handles cross-chain movement across Arc Testnet and the supported Sepolia environments.

2. It supports two modes.
	`Agentic` mode lets the agent handle the bridge flow automatically when limits allow it. `Manual` mode leaves the step execution visible to the user.

3. It supports both USDC bridging and ETH gas fanout.
	The ETH path is especially useful for pushing native gas from Sepolia into Base Sepolia, Optimism Sepolia, and Arbitrum Sepolia.

4. The bridge form makes chain direction explicit.
	The user chooses source chain, destination chain, token, amount, and bridge mode.

5. The bridge tracker is a core part of the experience.
	It survives tab switches, polls persisted bridge activity, and shows every stage such as approval, burn, attestation, mint, destination receipt, or failure.

	The user does not need to stay blocked on one attestation. A bridge can keep running in the background, mint completes automatically when the attestation arrives, and second or third bridge flows can still be started in parallel.

6. Manual bridging still uses the agent wallet.
	The app does not ask MetaMask to become the bridge executor. It keeps the agent wallet as the operational actor even when the user chooses a step-by-step mode.

7. The tracker also explains slow testnet behavior.
	Long attestation delays and destination gas shortages are surfaced as understandable states instead of silent stalls.

#### Swap

1. The Swap tab is the Arc Testnet token conversion surface.

2. It currently focuses on `USDC`, `EURC`, and `cirBTC`.

3. The page starts by showing live balances in the agent wallet.

4. Quote flow comes before execution.
	The app requests a live quote, checks whether the route is truly available, and then compares the requested size to the configured max auto-approve ceiling.

5. The user is told whether the amount fits the current limit.
	This makes the difference between agentic execution and blocked execution visible before the transaction is sent.

6. Successful swaps return a clean completion view.
	The screen shows the output amount and a direct ArcScan transaction link.

7. cirBTC support is honest about readiness.
	If a route is not truly available, the UI says so instead of pretending the asset is always swappable.

#### Jobs

1. The Jobs tab is the work marketplace side of Arc Machina.

2. It lets a user act as a client.
	They can create a job, optionally open it to applications, or lock it to a provider address.

3. It lets another side act as a provider.
	A provider can deliver work, and if needed, raise a dispute.

4. It includes human-friendly templates.
	The page includes example jobs such as social radar, DEX leaderboard checks, whale watch, launchpad scans, and rumor sweeps. These templates help non-technical users understand what kind of paid work the system can coordinate.

5. It explains the settlement model clearly.
	There is a difference between escrow, provider delivery, client review, and final completion. Delivery does not automatically mean payout.

6. It enforces a review window.
	The product shows a 48-hour client review SLA for delivered jobs and supports dispute handling when expectations are not met.

7. It also exposes the job economy layer.
	The user can see whether the create fee is live, skipped, dry-run, or confirmed.

#### Tasks

1. The Tasks page is the operational heart of the product.
	It brings together free checks, paid actions, paid information cards, and background automation in one place.

2. The page starts from a management point of view.
	It is not only a task launcher. It is also where users understand daily caps, revenue pool visibility, recent runs, and reputation.

3. The `Free` section is the low-risk starting point.
	It groups the current live free checks into a focused set that includes pool health, wallet and activity recap, FX reference, USDC peg monitoring, and arbitrage signal simulation.

4. The `Free` section also includes `Funding Setup`.
	This is where new users are told how to prepare a new wallet in the right order: get Sepolia ETH, run gas fanout, then use the Circle faucet when they need test USDC.

5. The `Paid` section is for direct user-triggered execution.
	It groups paid actions into Bridge Setup, Stable Curve Actions, cirBTC Direct Pair Actions, Bridge and Signal Actions, and Lending Actions.

6. The `Paid` section is explicit about what is live and what each action is for.
	A paid action here means the user is intentionally asking the agent to do something operational, not just inspect information.

7. The `Circle Paid` section is for information products.
	This is where the app separates preview from unlock. A user can inspect a free preview, then pay to unlock the fuller result and save it as a snapshot.

8. The current live Circle Paid cards are the ones that matter most today.
	`Prediction Market Check`, `Event Odds Compare`, and `Wallet or Asset Snapshot` are the strongest examples of how Arc Machina sells information before it sells action.

9. The `Automation` section is the behavior control room.
	It exposes `Market Analysis`, `Oracle Data Feed`, `Stable DeFi Loop`, `Lending Guard`, `Auto Carry`, `cirBTC LP Automation`, and `Reputation Tracking`.

10. The reputation surface is also made readable here.
	Users can see the local score, event breakdown, recent history, onchain score status, and ERC-8004 identity link in one place, so the agent's past work becomes a visible trust summary instead of only a raw log trail.

11. The page also includes `Keep Gateway ready`.
	 This matters because Oracle buying, task fees, job fees, and automation fees can all rely on buyer-side Gateway balance. The UI makes it clear that this toggle is about keeping payment balance ready, not about choosing strategy.

12. Full autonomy is still a conscious choice.
	 The page supports a combined toggle for people who understand the risk, but the text repeatedly explains what each automation lane does and what it does not do.

#### Oracle

1. The Oracle tab explains Arc Machina as a paid data seller.
	It is the place where the product stops looking like only a wallet and starts looking like a platform that can sell useful machine-readable intelligence.

2. The page begins with buyer readiness.
	It tells the operator whether the payment gate is configured, whether data is coming from live routes or fallback paths, whether the buyer wallet is ready, and what the current operational note is.

3. It exposes the public buyer onboarding tools directly.
	Users can open the buyer guide, download an example client, and download a helper script.

4. It groups Oracle products by intent.
	The UI separates execution data, macro research, and signal estimate products so that users understand the difference between "data you can trade on now" and "research you should still interpret carefully."

5. It shows the current public endpoint catalog.
	This includes stablecoin and pool reads, wallet snapshot surfaces, prediction market surfaces, and arbitrage scanners. The UI is explicit about what each endpoint is best for and what its caveat is.

6. It exposes Gateway buyer-side balance for the selected agent.
	This matters because a paid public Oracle request may need a warm Gateway balance. The page shows whether the agent wallet can fund it on demand or whether more wallet balance is needed first.

7. It exposes observability.
	402 challenges, fallbacks, alert delivery, settlement failures, recent events, and sink configuration are surfaced so the operator can understand health, not just revenue.

8. It ends with the access story.
	The user sees the four-step `request -> 402 challenge -> payment proof -> unlock response` flow in plain language.

#### Trade

1. The Trade tab is intentionally future-facing.
	It does not pretend to be live on Arc today.

2. It points to a TradingView strategy reference.
	The purpose is to show the strategy language and near-term trading direction before the autonomous trade lane is opened.

3. It tells the user what the plan is.
	The lane is meant to evolve into a shorter-horizon autonomous trading system that runs under deterministic rules, connects to DEX execution, and keeps adapting to incoming data.

4. It is not only about opening trades.
	Successful patterns, execution quality, and strategy behavior are expected to become future x402 products.

5. Some lanes may later become copy-trade or follow-style products for other agents.
	That is what turns Trade from a chart reference into a future economic surface.


6. It tells the truth about current readiness.
	The page clearly states that this lane is not live on Arc yet.

#### DeFi

1. The DeFi tab is divided into `Liquidity` and `Lending`.
	This matters because LP management and lending risk are connected, but they are not the same thing.

2. The `Liquidity` side exposes the current pool map.
	The product currently centers on `Curve USDC / EURC`, plus two direct cirBTC LP pairs: `cirBTC / USDC` and `cirBTC / EURC`.

3. The `Liquidity` side exposes live pool context before execution.
	It is meant to show pool state, LP status, and position-aware context before the user adds or removes liquidity.

4. Curve pool actions are explicit.
	The manual controls expose swap, add single-sided liquidity, add dual-sided liquidity, remove to one token, and remove to both tokens.

5. Direct pair LP actions are also explicit.
	On the cirBTC pairs, the page supports single-sided add, dual-sided add, exit to one token, and exit to both tokens.

6. cirBTC swap logic is intentionally separated.
	The UI tells the user to use the main Swap tab for cirBTC trades. The DeFi pair cards are for LP actions, not for general token swap flow.

7. The `Lending` side exposes the live lending account view.
	It summarizes total supplied value, total borrowed value, health factor, risk band, and available borrowing room.

8. Lending actions are manual and visible.
	Users can supply, withdraw, borrow, repay, top up collateral, run a safe exit, deleverage, or liquidate another unhealthy account when the conditions are met.

9. Carry is shown separately from plain lending.
	The page contains a `Carry Readiness` view so users can understand where carry yield comes from, what the borrow cost is, and whether the LP leg still looks attractive.

10. Reserve readiness is shown as a watch layer.
	 The `Reserve Readiness Watch` section is clearly explained as a read-only monitor that watches APY, utilization, and feed readiness.

11. The page also supports migration from manual LP into Auto Carry ownership.
	 If a stable LP position was opened outside the carry lane, the UI explains that it must be converted before Auto Carry should own it.

### 6. How Identity, Wallets, and Money Move Through the System

1. There are always two wallets in the story.
	The owner wallet belongs to the human. The agent wallet belongs to the autonomous actor.

2. The passkey protects application access.
	A user signs with the owner wallet during registration, but daily reconnects happen with the passkey.

3. The private key is a recovery asset, not the normal UX path.
	That is why it is shown once and then hidden.

4. Onchain identity is an extra trust layer.
	When identity registration succeeds, the agent can be associated with an onchain identity record instead of existing only as a local app object.

5. Not every paid thing in Arc Machina is the same kind of payment.
	Paid task execution, job create fees, Circle Paid unlocks, and public Oracle requests all belong to the economic system, but they do not all use the same exact user-facing journey.

6. Some fees settle into the revenue system.
	ArcRevenuePool and the Gateway-linked payment services are part of how the product turns execution and information into an economy, not just a wallet utility.

7. Jobs keep an escrow-style workflow.
	Create, deliver, review, complete, and dispute are treated as separate moments instead of being collapsed into one opaque payout event.

8. Oracle access follows an x402 pattern.
	A buyer first gets challenged, then pays, then retries, then receives the data.

9. The QR payment surface is simple but guarded.
	The Dashboard send and receive flow can generate or scan payment QR codes, but it only accepts Arc Testnet USDC EIP-681 requests, rejects wrong chain, wrong token, zero-address, and bad-checksum payloads, and asks for stronger confirmation when limits are exceeded.

### 7. What Is Live Today

1. Passkey-backed agent creation and reconnect are live.

2. Arc Testnet swaps, CCTP bridge flows, and gas fanout flows are live.

3. Tasks are live across free checks, paid actions, and automation controls.

4. Circle Paid keeps live cards visible and working while future cards can still remain preview-only.
	Its current role is not to be the main growth rail. It is the early layer that productizes action-adjacent information and can later evolve into Oracle API SKUs.

5. Public and private Oracle surfaces are live, including paid public buyer flows.

6. Jobs are live as a structured create, deliver, review, and completion system.

7. DeFi LP management and lending controls are live on the current supported rails.

8. The Trade tab is not a live Arc execution lane yet.

9. The whole product is still testnet-first.

## Part II. Developer Guide

### 8. High-Level Architecture

Arc Machina is a three-layer system.

1. The frontend is a React application that explains the product and gives users a clear control surface.

2. The backend is an Express API plus Bull queue workers that decide, execute, record, and expose status.

3. Contracts and protocol adapters provide the actual onchain rails.

The shape is easiest to think about like this:

```text
UI state and product surfaces
  -> authenticated API routes and public seller routes
  -> queue workers and policy engines
  -> protocol adapters and payment rails
  -> contracts, testnet pools, lending markets, and external chain services
```

4. The data layer is intentionally more first-party than marketplace-driven.
	The repo contains the audit trail for that decision. `backend/scripts/auditCircleServices.js` and the stored audit artifacts document why Arc Machina did not treat the ecosystem as a ready-made Arc-native data marketplace.

5. Public information is treated as productized SKU inventory.
	Oracle routes, Circle Paid cards, and wallet snapshot or prediction surfaces are not side experiments. They are the answer to a missing Arc-native paid data shelf.

6. Standard execution rails and x402 economy rails stay separate in code as well as product design.
	`Bridge`, `Swap`, `Send`, and `Receive` remain ordinary execution surfaces. Public Oracle, task economy, job economy, and Gateway-backed buyer flows sit on the x402 path instead of being mixed into every wallet action.

7. Arc-specific execution needs explicit chain and gas handling.
	The frontend bridge flow uses `@circle-fin/bridge-kit` together with `@circle-fin/adapter-viem-v2`, while the backend keeps preflight transaction safety checks around `estimateGas`, chain-specific overrides, and CCTP receive handling. The point is not cosmetic complexity. The point is making Arc Testnet execution behave consistently enough for non-technical users to trust it.

### 9. Frontend Architecture

1. `frontend/src/App.jsx`
	The application shell. It controls the top navigation, the landing-vs-app state, and the active tab.

2. `frontend/src/providers/AgentProvider.jsx`
	The shared agent session context. This is the glue that keeps the selected agent and auth state available across the UI.

3. `frontend/src/components/LandingPage.jsx`
	Marketing entry and app handoff.

4. `frontend/src/components/DashboardTab.jsx`
	Portfolio loading, address display, send and receive modal wiring, automation summaries, LP position summaries, lending summaries, and recent activity rendering.

5. `frontend/src/components/AgentTab.jsx`
	Agent creation, reconnect, passkey registration, settings save, smart-mode configuration, permissions save, identity retry, and delete flow.

6. `frontend/src/components/BridgeTab.jsx`
	Bridge form, mode selection, activity polling, tracker modal, manual claim flow, and gas top-up path.

7. `frontend/src/components/SwapTab.jsx`
	Quote polling, amount limit handling, agentic swap execution, and success-state rendering.

8. `frontend/src/components/JobsTab.jsx`
	Client and provider workflow, review policy display, open-application mode, and economy-state visibility.

9. `frontend/src/components/TasksTab.jsx`
	Catalog loading, Circle Paid catalog rendering, free and paid task dispatch, automation toggles, reputation and result surfaces, and Gateway auto-topup controls.

10. `frontend/src/components/OracleTab.jsx`
	 Oracle product matrix, buyer guide actions, Gateway balance visibility, observability, warning surfacing, and x402 flow explanation.

11. `frontend/src/components/DeFiTab.jsx`
	 Liquidity pool cards, manual LP actions, lending summary, carry view, reserve watch, and manual lending controls.

12. `frontend/src/components/TradeTab.jsx`
	 Future lane documentation around the TradingView strategy reference.

13. `frontend/src/components/PaymentModal.jsx` and `frontend/src/components/PositionAwareLpCard.jsx`
	 Shared surfaces for wallet transfer flow and LP position visibility.

14. `frontend/src/lib/`
	 API wrappers, chain config, passkey client logic, wallet balances, and Web3 helpers.

15. `frontend/public/`
	 Public Oracle buyer docs, downloadable example files, and the manifest that outside buyers can consume directly.

### 10. Backend Architecture

1. `backend/src/server.js`
	The main Express entry point. It configures `helmet`, CORS, request logging, trust proxy, body size limits, global rate limiting, readiness, health probes, and route mounts.

2. Route groups are intentionally separated by responsibility.

3. `backend/src/routes/auth.js`
	Passkey registration challenge, passkey registration finish, passkey login start and finish, refresh, and logout-related session handling.

4. `backend/src/routes/agents.js`
	Agent CRUD, settings updates, permissions, identity retry, live status, positions, reputation reads, lending reads, and model testing.

5. `backend/src/routes/transactions.js`
	Send, nano-pay, bridge, gas top-up, manual bridge steps, attestation reads, swap quote, swap execution, and transaction status polling.

6. `backend/src/routes/tasks.js`
	Task catalog, featured tasks, revenue pool balance, task runs, recent task results, Circle Paid preview and unlock flows, Circle Paid saved snapshots, manual DeFi task resolution, and paid execution dispatch.

7. `backend/src/routes/jobs.js`
	Authenticated job lifecycle for create, detail, deliver, complete, reject, and cancel.

8. `backend/src/routes/publicJobs.js`
	The public jobs board surface, separated because public read and write rate limiting need their own protection profile.

9. `backend/src/routes/oracle.js`
	Private Oracle endpoints, Oracle status, Gateway summaries, Gateway funding helpers, and public x402 seller routes under `/api/oracle/public/*`.

10. `backend/src/services/`
	 The real business logic layer. This directory holds passkey service, agent service, transaction service, protocol adapters, prediction market service, wallet snapshot service, payment economy services, security services, and queue-facing policy logic.

11. `backend/src/db/`
	 PostgreSQL schema and migration bootstrap.

12. Health is split cleanly.
	 `/readyz` is the lightweight readiness endpoint for platform health checks. `/health` is the heavier manual diagnostic endpoint that can probe DB and Redis.

### 11. Queue and Automation Model

1. `backend/src/queue/agentQueue.js` is the center of the runtime automation model.

2. The queue is Bull over Redis.
	That choice matters because the product needs persistence, retries, delayed execution, and worker control across bridge flows, task flows, and automation loops.

3. The queue coordinates more than one kind of automation.
	It is not just a generic job runner. It carries incoming transfer reactions, market analysis, Oracle checks, stable LP decisions, lending safety actions, carry decisions, cirBTC LP management, and paid execution work.

4. Several specialized policy services feed the queue.
	Current policy layers include stable LP management, lending automation, carry automation, Oracle strategy, and cirBTC LP automation.

5. The queue is also responsible for persisting readable snapshots.
	Dashboard and Tasks do not guess what happened. They read the latest saved automation decisions and statuses from the backend state persisted on the agent.

6. Buyer-side Gateway balance can be warmed automatically.
	The queue can top up buyer-ready Gateway balance for an agent when automation or paid flows need it.

7. Bridge lifecycle is also persisted.
	The tracker does not depend on local component state. Bridge activities are stored and polled so progress survives refreshes and tab switches.

8. The queue is built to support both deterministic and smart behavior.
	Rule-based and LLM-assisted decisions can both fit into the same worker model.

	The current weighting is intentionally deterministic-first. Over time, stronger LLM orchestration and machine-learning-assisted efficiency models are expected to grow on top of the same runtime spine.

### 12. Contracts and Chain Integrations

1. `AgentWallet.sol`
	The agent's operational wallet contract surface.

2. `AgentWalletFactory.sol`
	The contract used to create agent wallets.

3. `AgenticCommerce.sol`
	The commerce contract behind the jobs flow.

4. `ArcRevenuePool.sol`
	The pool that represents the shared fee and revenue side of the system.

5. `ReputationRegistry.sol`
	The reputation contract source kept in the repo for the reputation path.

6. Identity registration is also part of the app flow.
	The agent service tracks ERC-8004 style identity state and surfaces it back to the frontend even when the identity path is still testnet-scoped.

7. Protocol integrations are layered, not hardcoded into routes.
	The backend uses service adapters for Curve, lending, swaps, bridge flow, and Gateway payment rails.

### 12.1 Live Contract Surface

The live Arc Testnet surface used by the product is split between repo-owned contracts, liquidity rails, and external infrastructure.

1. Repo-owned contracts on Arc Testnet
	- AgentWalletFactory: `0xA16B21F856BB0b33220D7391f48D0D0248834643`
	- AgenticCommerce (ERC-8183): `0x35e9EA4cba090f5C38C57CEBa67AB558c2FB3397`
	- ReputationRegistry (ERC-8004): `0xBDa45b03781Ea61A4ee9B19F27B5c063DE031bDF`
	- ArcRevenuePool: `0x7E84fFFAA5f0524CD55b13B6AEC7eE0785c07e5e`
	- ArcLendingPool: `0x2774242539CCB2e63FED506beC77ceDb96984d6C`

2. Live liquidity and token rails used by the product
	- cirBTC token: `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF`
	- cirBTC / USDC direct pair: `0x10D4115Da1880C4b4D424F69f3a9DBd7a2B8ffd0`
	- cirBTC / EURC direct pair: `0x6f29F477D950821683dbE249DbB5D87d48183535`
	- USDC / EURC Curve fallback pool: `0x2D84D79C852f6842AbE0304b70bBaA1506AdD457`

3. External Circle and Arc infrastructure rails used by the product
	- Circle CCTP TokenMessenger: `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`
	- Circle CCTP MessageTransmitter: `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`
	- Circle Gateway Wallet: `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`
	- Circle Gateway Minter: `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`
	- Arc BridgeKit contract: `0xC5567a5E3370d4DBfB0540025078e283e36A363d`

4. Swap fallback routing is code-routed, not contract-routed.
	There is no separate custom fallback swap contract in the repo.
	Stable fallback uses the verified Curve pool, while cirBTC fallback uses the direct pair contracts listed above.

### 13. Core Data Model

The schema is broad, but these are the records that define how the product behaves.

1. `users`
	Owner wallet identities and auth counters.

2. `passkey_credentials` and `passkey_challenges`
	Passkey registration and authentication state.

3. `agents`
	The central agent record, including wallet address, smart-mode state, identity state, automation snapshots, and settings.

4. `agent_permissions`
	Strategy and execution permissions.

5. `transactions`
	The unified transaction and action history used across activity surfaces.

6. `chain_events`
	Indexed chain-side receive and event tracking data.

7. `task_catalog`
	The visible task list that powers Free and Paid task rendering.

8. `agent_task_results`
	Historical task output and outcome records.

9. Task run state through the task run service
	Used to track recent runs, queue state, and manual execution lifecycle.

10. `agent_jobs`
	 The jobs ledger for create, deliver, review, complete, reject, and cancel.

11. `circle_paid_snapshots`
	 Persisted saved results for paid information cards.

12. `oracle_payments`
	 Replay-safe payment records for Oracle public route settlement.

13. `agentic_payment_events`
	 The unified audit trail for task, job, Gateway, and related economic events.

14. `agent_reputation_events`
	 Local agent reputation history with score deltas and timeline.

15. `security_events`
	 Security audit trail for auth failures, suspicious activity, freezes, and related controls.

16. `llm_audit` and Oracle observability tables
	 Used to persist decision traces and alert events instead of hiding them inside logs only.

### 14. Security Model

The security approach is layered because this is a wallet product, an automation product, and a payment product at the same time.

1. Wallet ownership proof happens before passkey registration.
	The backend creates a challenge and expects a wallet signature before it will start the passkey registration flow.

2. Passkeys are first-class.
	They are not an afterthought added on top of passwords. They are the main application auth path.

3. Failed login handling is enforced.
	Auth routes use scoped rate limits, and repeated failures can trigger lockout behavior.

4. JWT session lifecycle is explicit.
	Refresh and logout behavior are part of the real auth model, not just placeholders.

5. Sensitive keys are encrypted at rest.
	Agent private keys and LLM keys are not stored in plaintext fields.

6. The agent has operational guardrails.
	Daily limits, max trade size, slippage, contract guard, and reserve settings all shape what execution paths are allowed.

7. Transaction safety is centralized.
	Shared transaction security services exist so different execution rails do not all reinvent nonce, replay, or risk handling in inconsistent ways.

8. Security events can freeze an agent.
	The backend does not only log suspicious behavior. It also has a freeze path that can stop an agent from continuing until the state is reviewed.

9. Public Oracle routes are not left open.
	They are separated from private routes, protected by payment challenge logic, and hardened with rate limits, query allowlists, and blocked scanner user-agent filters.

10. The server is hardened at the edge.
	 `helmet`, explicit CSP behavior, trust proxy validation, CORS allowlisting, sanitized logs, and bounded request sizes are part of the base runtime.

### 15. Local Development

The project is easiest to understand when you run frontend and backend separately.

1. Requirements

```text
Node.js 20+
PostgreSQL
Redis
Configured env files for backend and frontend
```

2. Common env locations

```text
/.env
/backend/.env
/frontend/.env
```

3. Important local note

The root `.env` used in local and devcontainer work should point `DATABASE_URL` at the Railway public Postgres URL. Internal Railway hostnames are only valid from inside Railway services.

4. Run from the repo root

```bash
npm run frontend:dev
npm run backend:dev
```

5. Or run each service directly

```bash
cd backend
npm start

cd frontend
npm run dev
```

6. Default local ports

```text
Frontend: 5173
Backend: 3001
Readiness: http://localhost:3001/readyz
Health: http://localhost:3001/health
```

### 16. Testing and Smoke Coverage

Arc Machina uses both focused tests and reality-based smoke flows.

1. Root-level commands

```bash
npm run smoke:prod
npm run smoke:defi
npm run smoke:automation:live
```

2. Backend test and smoke commands

```bash
cd backend
npm test
npm run smoke:route
npm run smoke:paid-readiness
npm run smoke:defi-full
npm run smoke:automation-live
npm run jobs:smoke:e2e
npm run oracle:buyer:preview
```

3. Frontend build check

```bash
cd frontend
npm run build
```

4. Oracle buyer examples

```bash
cd backend
node examples/oraclePublicBuyerExample.js
node examples/oraclePublicBuyerExample.js --preview
```

These commands matter because the product is not only UI-deep. Many of its most important promises live in bridge state, DeFi execution, paid unlock behavior, and public Oracle payment flow.

### 17. Deployment and Runtime Shape

1. Frontend
	The production frontend is deployed on Vercel and served from the canonical domain `https://arcmachina.xyz`.

2. Backend
	The production backend is deployed on Railway. Platform health checks use `/readyz`, while deeper manual checks use `/health`.

3. Public app-to-API shape
	The app is structured so the public site can expose `/api` through the frontend domain, which keeps the buyer-facing experience simpler.

4. Deployment config files

```text
/vercel.json
/frontend/vercel.json
/railway.json
```

5. Practical deploy notes

```bash
cd frontend
npx -y vercel --prod --yes

npx -y @railway/cli up --service backend --detach
```

6. Public Oracle buyer base URL

```text
https://arcmachina.xyz/api
```

### 18. Current Scope and Honest Boundaries

1. This repository is testnet-first.
	The product is serious, but it is still intentionally operating on testnet rails while flows are hardened.

2. Not every visible surface is equally mature.
	Bridge, swap, tasks, jobs, Oracle, and DeFi are live working surfaces. The Trade tab already points at a near-term deterministic trading lane, but it is not yet a fully open Arc execution product.

3. Circle Paid is intentionally selective and efficiency-focused at this stage.
	Live cards remain visible and useful, while roadmap cards can still stay visible without pretending that every card is already operational. The current role of Circle Paid is to incubate information products that can later become Oracle API surfaces, not to expand aggressively as a standalone category.

4. Automation expands only where the rails are verified.
	Stable routes, carry controls, lending protections, and cirBTC LP management are treated differently on purpose. The product does not flatten these into one fake universal bot mode.

5. LLM weight is still intentionally constrained.
	The current posture is deterministic-first, and onchain transaction selection still sits in the policy plus adapter layer. More dominant LLM decisions and machine-learning efficiency layers are part of the longer-term direction, but only once the audit trail, user trust, and repeated success are strong enough.

6. The long-term goal is larger than a wallet.
	Arc Machina is moving toward a world where no-code users can create agents, buy information, sell information, coordinate jobs, move funds, export their agents into their own stack, and gradually trust automation. That path also includes trade intelligence products and an agent-native marketplace. The current repo already contains the pieces of that system. The work now is about making those pieces understandable, reliable, and economically coherent.