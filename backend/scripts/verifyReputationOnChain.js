'use strict';
/**
 * verifyReputationOnChain.js
 *
 * Reads ERC-8004 #5999 reputation from the live ReputationRegistry contract
 * and prints all ReputationRecorded events that make up the on-chain score.
 *
 * Usage:
 *   node backend/scripts/verifyReputationOnChain.js
 *
 * Optional env overrides:
 *   ARC_TESTNET_RPC              — override RPC endpoint
 *   REPUTATION_REGISTRY_ADDRESS  — override contract address
 *   TOKEN_ID                     — override token id (default 5999)
 */

const { ethers } = require('ethers');

const CONTRACT_ADDRESS =
  process.env.REPUTATION_REGISTRY_ADDRESS ||
  '0xBDa45b03781Ea61A4ee9B19F27B5c063DE031bDF';

const RPC_URL =
  process.env.ARC_TESTNET_RPC ||
  'https://rpc.testnet.arc.network';

const TOKEN_ID = BigInt(process.env.TOKEN_ID || '5999');
const CHAIN_ID = 5042002;

const ABI = [
  'function getScore(uint256 tokenId) view returns (uint256)',
  'function totalEvents(uint256 tokenId) view returns (uint256)',
  'function owner() view returns (address)',
  'event ReputationRecorded(uint256 indexed tokenId, string eventType, int256 scoreDelta, uint256 newScore)',
];

async function main() {
  console.log('─────────────────────────────────────────────');
  console.log(' Arc Testnet  |  ReputationRegistry Verifier');
  console.log('─────────────────────────────────────────────');
  console.log(`  Contract : ${CONTRACT_ADDRESS}`);
  console.log(`  Token ID : ${TOKEN_ID} (ERC-8004 #${TOKEN_ID})`);
  console.log(`  RPC      : ${RPC_URL}`);
  console.log(`  Chain    : ${CHAIN_ID}`);
  console.log('─────────────────────────────────────────────\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    chainId: CHAIN_ID,
    name: 'Arc Testnet',
  });

  // ── Basic connectivity check ─────────────────────────────────────────────
  let blockNumber;
  try {
    blockNumber = await provider.getBlockNumber();
    console.log(`[chain]  Connected ✓  latest block = ${blockNumber}\n`);
  } catch (err) {
    console.error('[chain]  RPC connection failed:', err.message);
    process.exit(1);
  }

  const registry = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

  // ── Contract ownership ───────────────────────────────────────────────────
  try {
    const contractOwner = await registry.owner();
    console.log(`[contract] owner = ${contractOwner}`);
  } catch (_) {
    console.log('[contract] owner() call failed (ABI mismatch or wrong address)');
  }

  // ── Current score (state read) ───────────────────────────────────────────
  let currentScore;
  try {
    currentScore = await registry.getScore(TOKEN_ID);
    const totalEv  = await registry.totalEvents(TOKEN_ID);
    console.log(`[score]   getScore(${TOKEN_ID})   = ${currentScore}`);
    console.log(`[score]   totalEvents(${TOKEN_ID}) = ${totalEv}\n`);
  } catch (err) {
    console.error('[score]  getScore() failed:', err.message);
    process.exit(1);
  }

  // ── Event log (history) ──────────────────────────────────────────────────
  console.log('[events]  Fetching ReputationRecorded log for this token…\n');

  const filter = registry.filters.ReputationRecorded(TOKEN_ID);

  let logs = [];
  // Arc Testnet node limits eth_getLogs to 10 000 blocks — paginate backwards
  const CHUNK = 9999;
  // Scan at most the last ~200 000 blocks (~few days) to keep it fast
  const SCAN_DEPTH = 200000;
  const scanFrom = Math.max(0, blockNumber - SCAN_DEPTH);
  let chunkEnd = blockNumber;
  let chunksDone = 0;

  process.stdout.write('  Scanning in 10 000-block pages… ');
  while (chunkEnd >= scanFrom) {
    const chunkStart = Math.max(scanFrom, chunkEnd - CHUNK + 1);
    try {
      const chunk = await registry.queryFilter(filter, chunkStart, chunkEnd);
      logs = [...chunk, ...logs];  // prepend so result is chronological
      chunksDone++;
      if (chunksDone % 5 === 0) process.stdout.write('.');
    } catch (err) {
      // silently skip chunks that error
    }
    chunkEnd = chunkStart - 1;
  }
  console.log(` done (${chunksDone} pages, ${SCAN_DEPTH.toLocaleString()} blocks)\n`);

  if (logs.length === 0) {
    console.log('  No ReputationRecorded events found for this token in range.\n');
  } else {
    console.log(`  Found ${logs.length} event(s):\n`);
    console.log(
      '  #'.padEnd(5) +
      'Block'.padEnd(10) +
      'Event Type'.padEnd(32) +
      'Delta'.padEnd(8) +
      'New Score'
    );
    console.log('  ' + '─'.repeat(70));

    let runningTotal = 0;
    for (let i = 0; i < logs.length; i++) {
      const ev = logs[i];
      const delta    = Number(ev.args.scoreDelta);
      const newScore = Number(ev.args.newScore);
      const evType   = ev.args.eventType;
      runningTotal  += delta;

      console.log(
        `  ${String(i + 1).padEnd(4)} ` +
        `${String(ev.blockNumber).padEnd(9)} ` +
        `${evType.padEnd(31)} ` +
        `${(delta >= 0 ? '+' : '') + delta}`.padEnd(8) +
        `${newScore}`,
      );
    }

    console.log('  ' + '─'.repeat(70));
    console.log(`\n  Accumulated delta from events : ${runningTotal}`);
    console.log(`  getScore() (live state)       : ${currentScore}`);

    if (BigInt(runningTotal) === currentScore) {
      console.log('\n  ✓ Event trail matches on-chain state — score is verifiable.\n');
    } else {
      console.log(
        '\n  ⚠ Mismatch — events outside the scanned range may be missing.\n' +
        '    Try a node with full history or narrow TOKEN_ID search manually.\n',
      );
    }
  }

  // ── Transaction hashes ───────────────────────────────────────────────────
  if (logs.length > 0) {
    console.log('[tx hashes]  Each event was posted in:');
    const unique = [...new Set(logs.map(l => l.transactionHash))];
    unique.forEach(h => console.log(`  ${h}`));
    console.log();
  }

  console.log('─────────────────────────────────────────────');
  console.log(' Verification complete.');
  console.log('─────────────────────────────────────────────');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
