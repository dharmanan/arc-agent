'use strict';

const fs = require('fs');
const path = require('path');
const solc = require('/workspaces/arc-agent/backend/node_modules/solc');

const ROOT = path.resolve(__dirname, '..');
const BUILD_INFO_DIR = path.join(ROOT, 'artifacts/build-info');
const CONTRACT_SOURCE_NAME = 'contracts/ArcLendingPool.sol';
const CONTRACT_NAME = 'ArcLendingPool';

function loadBuildInfoSources() {
  const files = fs.readdirSync(BUILD_INFO_DIR).filter((name) => name.endsWith('.json'));
  const mergedSources = {};
  let settings = null;

  for (const fileName of files) {
    const payload = JSON.parse(fs.readFileSync(path.join(BUILD_INFO_DIR, fileName), 'utf8'));
    Object.assign(mergedSources, payload?.input?.sources || {});
    if (!settings && payload?.input?.settings) {
      settings = payload.input.settings;
    }
  }

  if (!settings) {
    throw new Error('No Solidity build-info settings were found under artifacts/build-info');
  }

  return { mergedSources, settings };
}

function compileArcLendingPool() {
  const { mergedSources, settings } = loadBuildInfoSources();
  mergedSources[CONTRACT_SOURCE_NAME] = {
    content: fs.readFileSync(path.join(ROOT, CONTRACT_SOURCE_NAME), 'utf8'),
  };

  const input = {
    language: 'Solidity',
    sources: mergedSources,
    settings: {
      viaIR: true,
      optimizer: settings.optimizer || { enabled: true, runs: 200 },
      evmVersion: settings.evmVersion || 'paris',
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'evm.methodIdentifiers'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = Array.isArray(output.errors) ? output.errors : [];
  const fatalErrors = errors.filter((entry) => entry.severity === 'error');

  if (fatalErrors.length > 0) {
    for (const entry of errors) {
      console.error(entry.formattedMessage || entry.message || String(entry));
    }
    throw new Error('ArcLendingPool compilation failed');
  }

  for (const entry of errors) {
    console.warn(entry.formattedMessage || entry.message || String(entry));
  }

  const contractOutput = output.contracts?.[CONTRACT_SOURCE_NAME]?.[CONTRACT_NAME];
  if (!contractOutput) {
    throw new Error('ArcLendingPool output was not found in solc result');
  }

  const artifact = {
    _format: 'hh-sol-artifact-1',
    contractName: CONTRACT_NAME,
    sourceName: CONTRACT_SOURCE_NAME,
    abi: contractOutput.abi,
    bytecode: contractOutput.evm?.bytecode?.object ? `0x${contractOutput.evm.bytecode.object}` : '0x',
    deployedBytecode: contractOutput.evm?.deployedBytecode?.object ? `0x${contractOutput.evm.deployedBytecode.object}` : '0x',
    linkReferences: contractOutput.evm?.bytecode?.linkReferences || {},
    deployedLinkReferences: contractOutput.evm?.deployedBytecode?.linkReferences || {},
  };

  const outputDir = path.join(ROOT, 'artifacts/contracts/ArcLendingPool.sol');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, `${CONTRACT_NAME}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );

  console.log(`Wrote artifact: ${path.join(outputDir, `${CONTRACT_NAME}.json`)}`);
}

try {
  compileArcLendingPool();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}