'use strict';
/**
 * Direct ethers.js deploy for ReputationRegistry — no Hardhat CLI.
 * Run: node scripts/direct-deploy-reputation-registry.js
 * Optional: node scripts/direct-deploy-reputation-registry.js --compile-only
 */
const path = require('path');
require('/workspaces/arc-agent/backend/node_modules/dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { ethers } = require('/workspaces/arc-agent/backend/node_modules/ethers');
const solc = require('/workspaces/arc-agent/backend/node_modules/solc');
const fs = require('fs');

function compileContract(root) {
  const contractPath = path.join(root, 'contracts/ReputationRegistry.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'ReputationRegistry.sol': { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors || [];
  const fatalErrors = errors.filter(error => error.severity === 'error');
  if (fatalErrors.length > 0) {
    throw new Error(fatalErrors.map(error => error.formattedMessage).join('\n\n'));
  }

  const artifact = output.contracts['ReputationRegistry.sol']?.ReputationRegistry;
  if (!artifact?.abi || !artifact?.evm?.bytecode?.object) {
    throw new Error('Failed to compile ReputationRegistry artifact');
  }

  const artifactDir = path.join(root, 'artifacts/contracts/ReputationRegistry.sol');
  fs.mkdirSync(artifactDir, { recursive: true });

  const artifactPath = path.join(artifactDir, 'ReputationRegistry.json');
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({
      contractName: 'ReputationRegistry',
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`,
    }, null, 2),
  );

  return {
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    artifactPath,
  };
}

function updateEnv(root, address) {
  const envPath = path.join(root, '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  if (/^REPUTATION_REGISTRY_ADDRESS=.*$/m.test(envContent)) {
    envContent = envContent.replace(/^REPUTATION_REGISTRY_ADDRESS=.*$/m, `REPUTATION_REGISTRY_ADDRESS=${address}`);
  } else {
    envContent += `\nREPUTATION_REGISTRY_ADDRESS=${address}\n`;
  }
  fs.writeFileSync(envPath, envContent);
}

async function main() {
  const compileOnly = process.argv.includes('--compile-only');
  const root = path.resolve(__dirname, '..');
  const { abi, bytecode, artifactPath } = compileContract(root);

  console.log('Compiled ReputationRegistry artifact:');
  console.log(artifactPath);

  if (compileOnly) return;

  const rpc = process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  const recorder = process.env.REPUTATION_RECORDER_ADDRESS || null;

  if (!process.env.RELAYER_PRIVATE_KEY) {
    throw new Error('RELAYER_PRIVATE_KEY is required');
  }

  const provider = new ethers.JsonRpcProvider(rpc, { chainId: 5042002, name: 'Arc Testnet' });
  const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);

  console.log('Deploying ReputationRegistry...');
  console.log('  Deployer:', wallet.address);
  console.log('  Balance :', ethers.formatEther(balance), 'ARC');
  console.log('  Recorder:', recorder || wallet.address);

  if (balance === 0n) {
    throw new Error('No ARC gas available on relayer wallet');
  }

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(recorder || wallet.address);
  console.log('  Tx      :', contract.deploymentTransaction().hash);
  console.log('  Waiting for confirmation...');
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const code = await provider.getCode(address);
  if (code === '0x') {
    throw new Error('Deployment failed — no bytecode at deployed address');
  }

  updateEnv(root, address);

  console.log('\n✅ ReputationRegistry deployed to:', address);
  console.log('──────────────────────────────────────────────────────');
  console.log(`REPUTATION_REGISTRY_ADDRESS=${address}`);
  console.log('──────────────────────────────────────────────────────');
  console.log('\n.env updated with REPUTATION_REGISTRY_ADDRESS');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});