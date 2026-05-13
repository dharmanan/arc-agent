'use strict';
/**
 * Direct ethers.js deploy — no Hardhat CLI needed.
 * Run: node scripts/direct-deploy-revenue-pool.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { ethers } = require('/workspaces/arc-agent/backend/node_modules/ethers');
const fs   = require('fs');
const path = require('path');

async function main() {
  const root     = path.resolve(__dirname, '..');
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(root, 'artifacts/contracts/ArcRevenuePool.sol/ArcRevenuePool.json'),
      'utf8',
    ),
  );

  const rpc     = process.env.ARC_TESTNET_RPC || 'https://rpc.arc-testnet.io';
  const usdc    = process.env.USDC_ADDRESS_ARC || '0x3600000000000000000000000000000000000000';

  const provider = new ethers.JsonRpcProvider(rpc);
  const deployer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

  const balance = await provider.getBalance(deployer.address);
  console.log('Deployer :', deployer.address);
  console.log('Balance  :', ethers.formatEther(balance), 'ARC');
  if (balance === 0n) throw new Error('No ARC gas — fund the relayer wallet first');

  const network = await provider.getNetwork();
  console.log('Network  :', network.name, '(chainId', network.chainId.toString() + ')');
  console.log('USDC     :', usdc);
  console.log('Platform :', deployer.address);

  console.log('\n→ Deploying ArcRevenuePool...');
  const Factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const pool    = await Factory.deploy(usdc, deployer.address);
  console.log('  TX hash:', pool.deploymentTransaction().hash);
  await pool.waitForDeployment();

  const address = await pool.getAddress();
  console.log('\n✅ ArcRevenuePool deployed to:', address);
  console.log('──────────────────────────────────────────────────────');
  console.log('REVENUE_POOL_ADDRESS=' + address);
  console.log('──────────────────────────────────────────────────────');

  // Auto-write to .env
  const envPath = path.join(root, '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  if (envContent.includes('REVENUE_POOL_ADDRESS=')) {
    envContent = envContent.replace(/REVENUE_POOL_ADDRESS=.*/m, `REVENUE_POOL_ADDRESS=${address}`);
  } else {
    envContent += `\nREVENUE_POOL_ADDRESS=${address}\n`;
  }
  fs.writeFileSync(envPath, envContent);
  console.log('\n.env updated with REVENUE_POOL_ADDRESS');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
