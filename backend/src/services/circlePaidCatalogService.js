'use strict';

const { getRevenuePoolAddress, getRevenuePoolSource } = require('./agenticEconomy/revenuePoolConfig');

const DEFAULT_ARC_FEE_USDC = Number(process.env.CIRCLE_PAID_ARC_FEE_USDC || '0.10');
const CIRCLE_PAID_CHAIN = process.env.TASK_ECONOMY_CHAIN || 'Arc Testnet';
const CIRCLE_PAID_PAY_ADDRESS = process.env.TASK_ECONOMY_PAY_ADDRESS || null;

const PAID_TASK_COPY = {
  EXEC_CURVE_SWAP: {
    title: 'Swap between USDC and EURC',
    description: 'Move from one stablecoin into the other on Arc Testnet when you want to change direction quickly.',
    outcome: 'Your wallet ends with the stablecoin mix you actually want to hold.',
  },
  EXEC_CURVE_LIQUIDITY_ADD: {
    title: 'Add stable liquidity',
    description: 'Put idle USDC or EURC into the verified Arc Curve pool.',
    outcome: 'You turn idle stablecoins into a live LP position.',
  },
  EXEC_CURVE_LIQUIDITY_REMOVE: {
    title: 'Exit stable liquidity',
    description: 'Burn an existing Curve LP position back into one stable token.',
    outcome: 'You come back to a simpler wallet position before taking the next move.',
  },
  EXEC_CIRBTC_USDC_ZAP_IN: {
    title: 'Bootstrap cirBTC/USDC LP',
    description: 'Use the supported USDC amount, swap part into cirBTC, then mint LP on the direct cirBTC/USDC pair.',
    outcome: 'You end with a live cirBTC/USDC LP position on the direct pool.',
  },
  EXEC_CIRBTC_EURC_ZAP_IN: {
    title: 'Bootstrap cirBTC/EURC LP',
    description: 'Use the supported EURC amount, swap part into cirBTC, then mint LP on the direct cirBTC/EURC pair.',
    outcome: 'You end with a live cirBTC/EURC LP position on the direct pool.',
  },
  EXEC_CIRBTC_USDC_LP_REMOVE: {
    title: 'Exit cirBTC/USDC LP',
    description: 'Burn part or all of the current cirBTC/USDC LP position and return both assets to the agent wallet.',
    outcome: 'You reduce or fully close direct-pair exposure without leaving the current product lane.',
  },
  EXEC_CIRBTC_EURC_LP_REMOVE: {
    title: 'Exit cirBTC/EURC LP',
    description: 'Burn part or all of the current cirBTC/EURC LP position and return both assets to the agent wallet.',
    outcome: 'You reduce or fully close direct-pair exposure without leaving the current product lane.',
  },
  EXEC_CCTP_BRIDGE: {
    title: 'Bridge USDC to another testnet',
    description: 'Move USDC from Arc Testnet to another supported testnet with Circle CCTP.',
    outcome: 'Funds end up on the destination chain you need next.',
  },
  EXEC_ARB: {
    title: 'Run the arbitrage leg',
    description: 'Submit the signal-driven Arc swap leg when a spread looks actionable.',
    outcome: 'You act on a live signal instead of only reading it.',
  },
  EXEC_REBALANCE: {
    title: 'Rebalance the stablecoin mix',
    description: 'Shift the wallet from one stablecoin into the other to match the target posture.',
    outcome: 'Your wallet moves back toward the position you intended to hold.',
  },
};

function getCirclePaidEconomySummary() {
  if (CIRCLE_PAID_PAY_ADDRESS) {
    return {
      chain: CIRCLE_PAID_CHAIN,
      recipientAddress: CIRCLE_PAID_PAY_ADDRESS,
      recipientKind: 'explicit_address',
      payAddressSource: 'TASK_ECONOMY_PAY_ADDRESS',
    };
  }

  return {
    chain: CIRCLE_PAID_CHAIN,
    recipientAddress: getRevenuePoolAddress(),
    recipientKind: 'revenue_pool',
    payAddressSource: getRevenuePoolSource() === 'env'
      ? 'REVENUE_POOL_ADDRESS'
      : 'verified_default_revenue_pool',
  };
}

function buildRecommendedPaidActions(linkedTaskIds = [], handoffNotes = {}) {
  return linkedTaskIds.map((taskId, index) => {
    const copy = PAID_TASK_COPY[taskId] || {};

    return {
      taskId,
      priority: index + 1,
      title: copy.title || taskId,
      description: copy.description || 'Continue into the matching paid Arc Testnet action.',
      outcome: copy.outcome || 'The next paid action continues from this Circle Paid input.',
      whyPick: handoffNotes[taskId] || 'This is one of the most relevant paid follow-up actions after this check.',
    };
  });
}

function buildCirclePaidItem({
  id,
  title,
  description,
  category,
  priority,
  lane,
  providerFeeUsdc,
  sourceServices,
  linkedTaskIds = [],
  onchainIntent = 'research_only',
  status = 'preview',
  whyItMatters,
  whatYouGet,
  howItWorks = [],
  handoffNotes = {},
  recommendedOutcome,
}) {
  const arcFeeUsdc = DEFAULT_ARC_FEE_USDC;
  const safeProviderFeeUsdc = Number(providerFeeUsdc || 0);
  const totalFeeUsdc = Number((safeProviderFeeUsdc + arcFeeUsdc).toFixed(6));
  const recommendedPaidActions = buildRecommendedPaidActions(linkedTaskIds, handoffNotes);

  return {
    id,
    title,
    description,
    category,
    priority,
    lane,
    status,
    onchainIntent,
    arcTestnetActionable: lane === 'arc_action',
    linkedTaskIds,
    whyItMatters,
    whatYouGet,
    howItWorks,
    recommendedOutcome: recommendedOutcome || (
      recommendedPaidActions.length
        ? 'If this check confirms your next move, continue with one of the recommended paid Arc actions below.'
        : 'This stays in the broader research layer until a live Arc-owned data adapter is turned on.'
    ),
    recommendedPaidActions,
    sourceServices,
    pricing: {
      providerFeeUsdc: safeProviderFeeUsdc,
      arcFeeUsdc,
      totalFeeUsdc,
      displayMode: 'provider_plus_arc_fee',
    },
  };
}

function buildCirclePaidCatalogItems() {
  return [
    buildCirclePaidItem({
      id: 'ARC_WALLET_ASSET_SNAPSHOT',
      title: 'Wallet or Asset Snapshot',
      description: 'See what the Arc wallet already holds before you pay for the next on-chain move.',
      category: 'Arc Action Inputs',
      priority: 10,
      lane: 'arc_action',
      providerFeeUsdc: 0.001,
      sourceServices: ['Alchemy'],
      linkedTaskIds: ['EXEC_CURVE_SWAP', 'EXEC_CURVE_LIQUIDITY_ADD', 'EXEC_CURVE_LIQUIDITY_REMOVE', 'EXEC_REBALANCE'],
      onchainIntent: 'read_then_execute_arc_testnet',
      whyItMatters: 'You avoid paying for a swap, rebalance or liquidity move without first checking the real wallet state.',
      whatYouGet: 'A simple readout of balances, token mix and current positions, plus the best-matching paid actions to take next.',
      howItWorks: [
        'Reads the connected Arc Testnet wallet and token balances.',
        'Summarizes the current holdings in plain English.',
        'Points you to the paid action that best matches the wallet state.',
      ],
      handoffNotes: {
        EXEC_CURVE_SWAP: 'Best when the wallet already holds enough of one stablecoin and you simply want to rotate into the other.',
        EXEC_CURVE_LIQUIDITY_ADD: 'Best when the wallet is sitting on idle stablecoins that you want to deploy into the verified Curve pool.',
        EXEC_CURVE_LIQUIDITY_REMOVE: 'Best when the snapshot shows you already have Curve LP and want to unwind it.',
        EXEC_REBALANCE: 'Best when the snapshot shows the wallet is too concentrated in one stablecoin.',
      },
      recommendedOutcome: 'Use this first when you want to avoid blind execution and choose the next paid action from real wallet data.',
    }),
    buildCirclePaidItem({
      id: 'ARC_MARKET_METRICS',
      title: 'Market Metrics',
      description: 'Check liquidity, volatility and positioning before you submit an Arc action.',
      category: 'Arc Action Inputs',
      priority: 20,
      lane: 'arc_action',
      providerFeeUsdc: 0.03,
      sourceServices: ['Arrays'],
      linkedTaskIds: ['EXEC_REBALANCE', 'EXEC_ARB', 'EXEC_CURVE_SWAP'],
      onchainIntent: 'signal_then_execute_arc_testnet',
      whyItMatters: 'You get a quick market-health filter before you spend on a rebalance, swap or signal trade.',
      whatYouGet: 'A short market read on volatility, liquidity and positioning that helps you decide whether to act now or wait.',
      howItWorks: [
        'Pulls current market structure and positioning signals.',
        'Condenses them into a short decision-ready summary.',
        'Hands off to the paid action that fits the current market setup.',
      ],
      handoffNotes: {
        EXEC_REBALANCE: 'Use this when conditions support reducing concentration and moving the wallet back toward balance.',
        EXEC_ARB: 'Use this when the read suggests a short-lived pricing gap is worth acting on.',
        EXEC_CURVE_SWAP: 'Use this when you want a simpler one-leg stablecoin rotation instead of a broader rebalance.',
      },
      recommendedOutcome: 'This helps you decide whether the next paid move should be a rebalance, a one-leg swap or a signal-driven trade.',
    }),
    buildCirclePaidItem({
      id: 'ARC_TOKEN_OVERVIEW',
      title: 'Token Overview',
      description: 'Read the token context before you commit funds or change the wallet mix on Arc.',
      category: 'Arc Action Inputs',
      priority: 30,
      lane: 'arc_action',
      providerFeeUsdc: 0.008,
      sourceServices: ['CoinGecko', 'Arrays'],
      linkedTaskIds: ['EXEC_CURVE_SWAP', 'EXEC_REBALANCE'],
      onchainIntent: 'signal_then_execute_arc_testnet',
      whyItMatters: 'This gives the user a sanity check on the asset context before sending a paid transaction.',
      whatYouGet: 'A compact view of token size, pair context and current conditions that can justify a swap or rebalance.',
      howItWorks: [
        'Pulls the token and pair context from the external providers.',
        'Highlights what changed in simple terms.',
        'Suggests the paid Arc action that matches that context.',
      ],
      handoffNotes: {
        EXEC_CURVE_SWAP: 'Choose this when you only want to rotate into the other stablecoin after reviewing the pair context.',
        EXEC_REBALANCE: 'Choose this when the token context supports a broader portfolio adjustment, not just a single swap.',
      },
    }),
    buildCirclePaidItem({
      id: 'ARC_CIRBTC_USDC_DIRECT_PAIR',
      title: 'cirBTC / USDC LP Playbook',
      description: 'Review the live direct cirBTC/USDC path before opening or closing a volatile LP position.',
      category: 'Arc Action Inputs',
      priority: 35,
      lane: 'arc_action',
      providerFeeUsdc: 0.004,
      sourceServices: ['Alchemy', 'Arc direct pair state'],
      linkedTaskIds: ['EXEC_CIRBTC_USDC_ZAP_IN', 'EXEC_CIRBTC_USDC_LP_REMOVE'],
      onchainIntent: 'read_then_execute_arc_testnet',
      whyItMatters: 'This keeps the live cirBTC/USDC LP path visible inside the same paid flow instead of hiding it behind only the generic task catalog.',
      whatYouGet: 'A direct-pair handoff that explains when to seed LP and when to unwind it, using the already live manual execution path.',
      howItWorks: [
        'Frames the cirBTC/USDC direct pair as a real Arc action lane, not a future placeholder.',
        'Shows the two matching paid actions: bootstrap LP or exit LP.',
        'Keeps the user on the direct pool story instead of sending them through an unrelated stable-only path.',
      ],
      handoffNotes: {
        EXEC_CIRBTC_USDC_ZAP_IN: 'Use this when the wallet holds idle USDC and you want to open direct cirBTC exposure through the current live pair.',
        EXEC_CIRBTC_USDC_LP_REMOVE: 'Use this when the wallet already holds cirBTC/USDC LP and you want to shrink or fully close the position.',
      },
      recommendedOutcome: 'Use this when the next move should stay on the live cirBTC/USDC pair instead of the stable-only Curve lane.',
    }),
    buildCirclePaidItem({
      id: 'ARC_CIRBTC_EURC_DIRECT_PAIR',
      title: 'cirBTC / EURC LP Playbook',
      description: 'Review the live direct cirBTC/EURC path before opening or closing a volatile LP position.',
      category: 'Arc Action Inputs',
      priority: 40,
      lane: 'arc_action',
      providerFeeUsdc: 0.004,
      sourceServices: ['Alchemy', 'Arc direct pair state'],
      linkedTaskIds: ['EXEC_CIRBTC_EURC_ZAP_IN', 'EXEC_CIRBTC_EURC_LP_REMOVE'],
      onchainIntent: 'read_then_execute_arc_testnet',
      whyItMatters: 'This keeps the live cirBTC/EURC LP path visible inside the same paid flow instead of leaving it only in the raw task list.',
      whatYouGet: 'A direct-pair handoff that explains when to seed LP and when to unwind it, using the already live manual execution path.',
      howItWorks: [
        'Frames the cirBTC/EURC direct pair as a real Arc action lane, not a future placeholder.',
        'Shows the two matching paid actions: bootstrap LP or exit LP.',
        'Keeps the user on the direct pool story instead of mixing it with the stable-only Curve route.',
      ],
      handoffNotes: {
        EXEC_CIRBTC_EURC_ZAP_IN: 'Use this when the wallet holds idle EURC and you want to open direct cirBTC exposure through the current live pair.',
        EXEC_CIRBTC_EURC_LP_REMOVE: 'Use this when the wallet already holds cirBTC/EURC LP and you want to shrink or fully close the position.',
      },
      recommendedOutcome: 'Use this when the next move should stay on the live cirBTC/EURC pair instead of the stable-only Curve lane.',
    }),
    buildCirclePaidItem({
      id: 'ARC_PREDICTION_MARKET_CHECK',
      title: 'Prediction Market Check',
      description: 'Use event-market sentiment as a quick risk check before you move Arc capital.',
      category: 'Arc Action Inputs',
      priority: 1,
      lane: 'arc_action',
      status: 'live',
      providerFeeUsdc: 0.01,
      sourceServices: ['Polymarket Gamma API'],
      linkedTaskIds: ['EXEC_REBALANCE', 'EXEC_CCTP_BRIDGE'],
      onchainIntent: 'research_then_execute_arc_testnet',
      whyItMatters: 'A fast event-market read helps the user decide whether to stay defensive, rebalance, or move funds elsewhere.',
      whatYouGet: 'A live risk pulse drawn from prediction markets, framed as an action hint instead of raw market chatter.',
      howItWorks: [
        'Reads the latest event-market pricing.',
        'Turns that into a short risk or confidence signal.',
        'Suggests whether the better next move is to rebalance on Arc or bridge out.',
      ],
      handoffNotes: {
        EXEC_REBALANCE: 'Use this when the signal says capital should stay on Arc but shift into a safer mix.',
        EXEC_CCTP_BRIDGE: 'Use this when the signal suggests the better move is to move capital to another chain first.',
      },
      recommendedOutcome: 'This is the first live Circle Paid card and the first candidate to become a paid information surface once settlement is wired.',
    }),
    buildCirclePaidItem({
      id: 'ARC_EVENT_ODDS_COMPARE',
      title: 'Event Odds Compare',
      description: 'Compare two event markets before you decide whether to defend, hold or move capital.',
      category: 'Arc Action Inputs',
      priority: 2,
      lane: 'arc_action',
      status: 'live',
      providerFeeUsdc: 0.01,
      sourceServices: ['Polymarket Gamma API'],
      linkedTaskIds: ['EXEC_CCTP_BRIDGE', 'EXEC_REBALANCE'],
      onchainIntent: 'research_then_execute_arc_testnet',
      whyItMatters: 'The user gets a second opinion on risk before bridging or rebalancing funds.',
      whatYouGet: 'A side-by-side topic comparison that explains whether two market narratives stay aligned, split, or diverge enough to change the next Arc move.',
      howItWorks: [
        'Runs two separate topic searches across live Polymarket markets.',
        'Measures whether those two topic clusters stay aligned, split, or diverge.',
        'Uses that signal to frame the next paid Arc action.',
      ],
      handoffNotes: {
        EXEC_CCTP_BRIDGE: 'Use this when the market comparison suggests leaving the current chain is the cleaner defensive move.',
        EXEC_REBALANCE: 'Use this when the market comparison still supports staying on Arc but adjusting the wallet mix.',
      },
      recommendedOutcome: 'This is the second live Circle Paid card and the next candidate to graduate into a paid information surface once the runtime stabilizes.',
    }),
    buildCirclePaidItem({
      id: 'CRYPTO_NEWS_PULSE',
      title: 'Crypto News Pulse',
      description: 'Get a short external news pulse once the action-first flow is clear.',
      category: 'Research & Social',
      priority: 60,
      lane: 'research',
      providerFeeUsdc: 0.03,
      sourceServices: ['Messari', 'Gloria AI'],
      whyItMatters: 'This helps the user understand the broader market backdrop without leaving the app.',
      whatYouGet: 'A compact summary of the latest crypto headlines and sentiment shifts.',
      howItWorks: [
        'Pulls fresh headlines and sentiment cues.',
        'Compresses them into a short operator-ready brief.',
        'Leaves the final execution decision to the user.',
      ],
      recommendedOutcome: 'Use this when you want extra context, not an immediate Arc action handoff.',
    }),
    buildCirclePaidItem({
      id: 'TWITTER_PULSE',
      title: 'Twitter Pulse',
      description: 'Read the short social pulse around a topic, token or market theme.',
      category: 'Research & Social',
      priority: 70,
      lane: 'research',
      providerFeeUsdc: 0.0036,
      sourceServices: ['Twitter (X)'],
      whyItMatters: 'This helps the user spot narrative shifts and operator chatter before acting elsewhere.',
      whatYouGet: 'A quick view of current X/Twitter discussion, recurring claims and sentiment direction.',
      howItWorks: [
        'Collects the latest social discussion around the target topic.',
        'Groups the main themes and sentiment.',
        'Shows it as context the user can weigh before the next decision.',
      ],
      recommendedOutcome: 'This is a context card for awareness, not a direct Arc execution handoff yet.',
    }),
    buildCirclePaidItem({
      id: 'DEEP_RESEARCH',
      title: 'Deep Research',
      description: 'Ask for a broader reasoning pass when you need more than a quick signal.',
      category: 'Research & Social',
      priority: 80,
      lane: 'research',
      providerFeeUsdc: 0.012,
      sourceServices: ['Perplexity'],
      whyItMatters: 'This gives the user a slower, broader answer when a lightweight card is not enough.',
      whatYouGet: 'A longer explanation that can support a later execution decision or manual review.',
      howItWorks: [
        'Runs a broader reasoning and search pass.',
        'Brings together the main evidence into one answer.',
        'Leaves the final paid action choice to the user.',
      ],
      recommendedOutcome: 'Use this when you need fuller context before deciding whether any paid Arc action is justified.',
    }),
    buildCirclePaidItem({
      id: 'SOURCE_PACK',
      title: 'Source Pack',
      description: 'Pull the underlying links and pages behind a recommendation so the user can inspect them.',
      category: 'Research & Social',
      priority: 90,
      lane: 'research',
      providerFeeUsdc: 0.007,
      sourceServices: ['Exa', 'Firecrawl'],
      whyItMatters: 'This gives the user evidence, not just a summary, before they trust a recommendation.',
      whatYouGet: 'A grouped set of source links and extracted page context supporting the current recommendation.',
      howItWorks: [
        'Finds relevant public sources for the topic.',
        'Pulls the page content behind those links.',
        'Packages the sources so the user can review the evidence quickly.',
      ],
      recommendedOutcome: 'Use this when the user wants proof and references before taking any paid Arc action.',
    }),
  ].sort((left, right) => left.priority - right.priority);
}

function getCirclePaidItemById(itemId) {
  const normalizedId = String(itemId || '').trim().toUpperCase();
  if (!normalizedId) return null;
  return getCirclePaidCatalog().items.find(item => item.id === normalizedId) || null;
}

function buildCirclePaidHandoff(item, paidTaskCatalog = []) {
  if (!item) return null;

  const taskById = new Map(
    (paidTaskCatalog || []).map(task => [String(task.id || '').toUpperCase(), task]),
  );

  const recommendedTasks = (item.recommendedPaidActions || []).map(action => {
    const catalogTask = taskById.get(String(action.taskId || '').toUpperCase()) || null;

    return {
      taskId: action.taskId,
      title: catalogTask?.title || action.title,
      description: catalogTask?.description || action.description,
      feeUsdc: catalogTask?.fee_usdc != null ? Number(catalogTask.fee_usdc) : null,
      whyPick: action.whyPick,
      outcome: action.outcome,
      priority: action.priority,
    };
  });

  return {
    itemId: item.id,
    title: item.title,
    summary: item.description,
    whyItMatters: item.whyItMatters,
    whatYouGet: item.whatYouGet,
    howItWorks: item.howItWorks,
    recommendedOutcome: item.recommendedOutcome,
    recommendedTasks,
    pricing: item.pricing,
    status: 'guided_handoff',
    chargeReady: false,
    providerCallReady: false,
    note: 'This card is still preview-only. No live provider call runs yet, and only the current live cards should be treated as active runtime.',
    ui: {
      targetGroup: 'paid',
      highlightTaskIds: recommendedTasks.map(task => task.taskId),
    },
  };
}

function getCirclePaidCatalog() {
  const economy = getCirclePaidEconomySummary();
  const items = buildCirclePaidCatalogItems();

  return {
    economy: {
      rail: 'arc_live_preview_data_layer',
      railLabel: 'Live + roadmap cards',
      mode: 'visible_live_and_planned_cards',
      chain: economy.chain,
      recipientAddress: economy.recipientAddress,
      recipientKind: economy.recipientKind,
      payAddressSource: economy.payAddressSource,
      defaultArcFeeUsdc: DEFAULT_ARC_FEE_USDC,
      feePoolEnabled: true,
      feePoolNote: 'The live cards still point at the same shared pool model used by paid execution tasks if this track is reopened later.',
      providerSettlementNote: 'Circle Paid expansion is paused, but the full roadmap stays visible here. Treat provider cost and Arc fee as reference metadata unless a card is already live.',
      onchainPriority: 'arc_testnet_action_first',
      onchainPriorityLabel: 'Start with cards that help the user make the next Arc action safely.',
      userNarrative: 'Circle Paid is paused as an active expansion track, but the roadmap remains visible. Use the live cards now, and read preview or planned cards as staged product direction rather than active runtime.',
    },
    lanes: [
      {
        key: 'arc_action',
        title: 'Start with action-ready decisions',
        description: 'These cards help the user check the right input before choosing a live Arc Testnet move.',
      },
      {
        key: 'research',
        title: 'Research and social follow-up',
        description: 'Use these after the action-first flow is clear, when the user wants broader context instead of an immediate handoff.',
      },
    ],
    items,
  };
}

module.exports = {
  buildCirclePaidHandoff,
  getCirclePaidCatalog,
  getCirclePaidItemById,
};