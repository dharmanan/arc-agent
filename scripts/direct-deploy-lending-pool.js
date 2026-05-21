'use strict';
/**
 * Direct ethers.js deploy — no Hardhat CLI needed.
 * Run: node scripts/direct-deploy-lending-pool.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { ethers } = require('/workspaces/arc-agent/backend/node_modules/ethers');
const fs = require('fs');
const path = require('path');

function loadArtifact(root) {
  const artifactPath = path.join(root, 'artifacts/contracts/ArcLendingPool.sol/ArcLendingPool.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error('ArcLendingPool artifact is missing. Compile the contract before deploy.');
  }
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const artifact = loadArtifact(root);
  const rpc = process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
  const treasury = process.env.LENDING_TREASURY_ADDRESS || process.env.REVENUE_POOL_ADDRESS || null;

  if (!treasury) {
    throw new Error('LENDING_TREASURY_ADDRESS or REVENUE_POOL_ADDRESS must be set before deploy.');
  }
  if (!process.env.RELAYER_PRIVATE_KEY) {
    throw new Error('RELAYER_PRIVATE_KEY is required before deploy.');
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  const deployer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

  const balance = await provider.getBalance(deployer.address);
  console.log('Deployer :', deployer.address);
  console.log('Balance  :', ethers.formatEther(balance), 'ARC');
  if (balance === 0n) throw new Error('No ARC gas — fund the relayer wallet first');

  const network = await provider.getNetwork();
  console.log('Network  :', network.name, '(chainId', network.chainId.toString() + ')');
  console.log('Treasury :', treasury);

  console.log('\n→ Deploying ArcLendingPool...');
  const Factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const contract = await Factory.deploy(treasury);
  console.log('  TX hash:', contract.deploymentTransaction().hash);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('\n✅ ArcLendingPool deployed to:', address);
  console.log('──────────────────────────────────────────────────────');
  console.log('ARC_LENDING_POOL_ADDRESS=' + address);
  console.log('──────────────────────────────────────────────────────');

  const envPath = path.join(root, '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (envContent.includes('ARC_LENDING_POOL_ADDRESS=')) {
    envContent = envContent.replace(/ARC_LENDING_POOL_ADDRESS=.*/m, `ARC_LENDING_POOL_ADDRESS=${address}`);
  } else {
    envContent += `\nARC_LENDING_POOL_ADDRESS=${address}\n`;
  }
  fs.writeFileSync(envPath, envContent);
  console.log('\n.env updated with ARC_LENDING_POOL_ADDRESS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});