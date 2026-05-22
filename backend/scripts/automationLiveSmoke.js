'use strict';

const db = require('../src/db');
const queue = require('../src/queue/agentQueue');
const positionsService = require('../src/services/positionsService');

function parseArgs(argv) {
  const options = {
    agentId: process.env.AUTOMATION_SMOKE_AGENT_ID || null,
    runDefi: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--agent-id' && argv[index + 1]) {
      options.agentId = argv[index + 1];
      index += 1;
    } else if (arg === '--run-defi') {
      options.runDefi = true;
    } else if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

async function resolveAgent(agentId) {
  if (agentId) {
    const { rows: [agent] } = await db.query(
      `SELECT id, name, wallet_address, is_smart_mode,
              market_analysis_enabled, oracle_enabled, defi_loop_enabled, cirbtc_lp_enabled,
              market_analysis_last_run_at, market_analysis_last_status,
              oracle_last_run_at, oracle_last_status,
              defi_loop_last_run_at, defi_loop_last_status,
              cirbtc_lp_last_run_at, cirbtc_lp_last_status
         FROM agents
        WHERE id = $1
        LIMIT 1`,
      [agentId],
    );

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return agent;
  }

  const { rows: [fallbackAgent] } = await db.query(
    `SELECT id, name, wallet_address, is_smart_mode,
            market_analysis_enabled, oracle_enabled, defi_loop_enabled, cirbtc_lp_enabled,
            market_analysis_last_run_at, market_analysis_last_status,
            oracle_last_run_at, oracle_last_status,
            defi_loop_last_run_at, defi_loop_last_status,
            cirbtc_lp_last_run_at, cirbtc_lp_last_status
       FROM agents
      WHERE is_smart_mode = TRUE
        AND (market_analysis_enabled = TRUE OR oracle_enabled = TRUE OR defi_loop_enabled = TRUE OR cirbtc_lp_enabled = TRUE)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
  );

  if (!fallbackAgent) {
    throw new Error('No smart-mode automation agent found. Pass --agent-id explicitly.');
  }

  return fallbackAgent;
}

async function loadAutomationStatus(agentId) {
  const { rows: [row] } = await db.query(
    `SELECT market_analysis_last_run_at::text AS market_analysis_last_run_at,
            market_analysis_last_status,
            oracle_last_run_at::text AS oracle_last_run_at,
            oracle_last_status,
            defi_loop_last_run_at::text AS defi_loop_last_run_at,
            defi_loop_last_status,
            defi_loop_last_decision,
            cirbtc_lp_last_run_at::text AS cirbtc_lp_last_run_at,
            cirbtc_lp_last_status,
            cirbtc_lp_last_decision
       FROM agents
      WHERE id = $1`,
    [agentId],
  );

  return row || null;
}

async function loadLatestEvidence(agentId) {
  const { rows } = await db.query(
    `SELECT created_at::text AS created_at,
            type,
            status,
            tx_hash,
            token,
            amount_usdc::text AS amount_usdc,
            meta->>'executionSource' AS execution_source,
            meta->>'summary' AS summary,
            meta->>'token0Amount' AS token0_amount,
            meta->>'token0Symbol' AS token0_symbol,
            meta->>'token1Amount' AS token1_amount,
            meta->>'token1Symbol' AS token1_symbol
       FROM transactions
      WHERE agent_id = $1
        AND (
          meta->>'executionSource' IN ('stable_policy_v1', 'cirbtc_lp_policy_v1', 'oracle_strategy')
          OR type IN ('oracle_signal', 'curve_lp_add', 'curve_lp_remove', 'direct_lp_add', 'direct_lp_remove', 'defi_loop_swap', 'defi_loop_dry')
        )
      ORDER BY created_at DESC
      LIMIT 20`,
    [agentId],
  );

  const latestStable = rows.find((row) => row.execution_source === 'stable_policy_v1' || row.execution_source === 'oracle_strategy') || null;
  const latestCirbtc = rows.find((row) => row.execution_source === 'cirbtc_lp_policy_v1') || null;
  const latestOracleSignal = rows.find((row) => row.type === 'oracle_signal') || null;

  return {
    latestStable,
    latestCirbtc,
    latestOracleSignal,
    recent: rows,
  };
}

async function runHandler(name, payload) {
  const handler = queue?.handlers?.[name];
  if (typeof handler !== 'function') {
    return {
      ok: false,
      reason: 'handler_missing',
    };
  }

  const result = await handler({ data: payload });
  return {
    ok: true,
    result,
  };
}

function printHumanSummary(summary) {
  console.log(`Agent: ${summary.agent.name} (${summary.agent.id})`);
  console.log(`Wallet: ${summary.agent.walletAddress || 'n/a'}`);
  console.log('');
  console.log(`Market Analysis: ${summary.executions.marketAnalysis.after?.market_analysis_last_status || 'unknown'} @ ${summary.executions.marketAnalysis.after?.market_analysis_last_run_at || 'n/a'}`);
  console.log(`Oracle: ${summary.executions.oracle.after?.oracle_last_status || 'unknown'} @ ${summary.executions.oracle.after?.oracle_last_run_at || 'n/a'}`);
  console.log(`Stable DeFi: ${summary.status?.defi_loop_last_status || 'unknown'} @ ${summary.status?.defi_loop_last_run_at || 'n/a'}`);
  console.log(`cirBTC LP: ${summary.status?.cirbtc_lp_last_status || 'unknown'} @ ${summary.status?.cirbtc_lp_last_run_at || 'n/a'}`);
  console.log('');

  if (summary.evidence.latestStable) {
    console.log(`Latest stable evidence: ${summary.evidence.latestStable.type} ${summary.evidence.latestStable.status} ${summary.evidence.latestStable.tx_hash || ''}`.trim());
  }
  if (summary.evidence.latestCirbtc) {
    console.log(`Latest cirBTC evidence: ${summary.evidence.latestCirbtc.type} ${summary.evidence.latestCirbtc.status} ${summary.evidence.latestCirbtc.tx_hash || ''}`.trim());
  }
  if (summary.positions?.positions?.length) {
    console.log('');
    console.log('Current positions:');
    for (const position of summary.positions.positions) {
      console.log(`- ${position.poolKey}: LP ${position.lpBalance || '0'} | USD ${position.valueUsd || 0}`);
    }
  }

  if (summary.executions.defiLoopTriggered) {
    console.log('');
    console.log(`Live DEFI_LOOP run: ${summary.executions.defiLoopTriggered.ok ? 'completed' : 'skipped'}${summary.executions.defiLoopTriggered.reason ? ` (${summary.executions.defiLoopTriggered.reason})` : ''}`);
  } else {
    console.log('');
    console.log('Live DEFI_LOOP run: skipped by default. Pass --run-defi to execute it intentionally.');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const agent = await resolveAgent(options.agentId);

  const marketBefore = await loadAutomationStatus(agent.id);
  const marketAnalysis = await runHandler('MARKET_ANALYSIS', {
    agentId: agent.id,
    chain: 'arc-testnet',
    token: 'USDC',
  });
  const marketAfter = await loadAutomationStatus(agent.id);

  const oracleBefore = await loadAutomationStatus(agent.id);
  const oracleExecution = await runHandler('ORACLE_QUERY', {
    agentId: agent.id,
  });
  const oracleAfter = await loadAutomationStatus(agent.id);

  let defiLoopTriggered = null;
  if (options.runDefi) {
    defiLoopTriggered = await runHandler('DEFI_LOOP', {
      agentId: agent.id,
    });
  }

  const status = await loadAutomationStatus(agent.id);
  const evidence = await loadLatestEvidence(agent.id);
  const positions = agent.wallet_address
    ? await positionsService.getWalletPositions(agent.wallet_address).catch((error) => ({
        positions: [],
        warnings: [{ message: error.message }],
      }))
    : { positions: [], warnings: [{ message: 'wallet_missing' }] };

  const summary = {
    timestamp: new Date().toISOString(),
    safeMode: !options.runDefi,
    agent: {
      id: agent.id,
      name: agent.name,
      walletAddress: agent.wallet_address,
      isSmartMode: agent.is_smart_mode,
      features: {
        marketAnalysisEnabled: agent.market_analysis_enabled,
        oracleEnabled: agent.oracle_enabled,
        defiLoopEnabled: agent.defi_loop_enabled,
        cirbtcLpEnabled: agent.cirbtc_lp_enabled,
      },
    },
    executions: {
      marketAnalysis: {
        before: marketBefore,
        after: marketAfter,
        ...marketAnalysis,
      },
      oracle: {
        before: oracleBefore,
        after: oracleAfter,
        ...oracleExecution,
      },
      defiLoopTriggered,
    },
    status,
    evidence,
    positions: {
      positions: (positions.positions || []).map((position) => ({
        poolKey: position.poolKey,
        lpBalance: position.lpToken?.balance || null,
        valueUsd: position.valuation?.totalUsd || null,
      })),
      warnings: positions.warnings || [],
    },
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printHumanSummary(summary);
  console.log('');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });