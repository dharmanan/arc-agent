'use strict';
/**
 * Direct ethers.js deploy — no Hardhat CLI needed.
 * Run from anywhere: node scripts/deploy-direct.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { ethers } = require('/workspaces/arc-agent/backend/node_modules/ethers');
const fs   = require('fs');
const path = require('path');

async function main() {
  const root = path.resolve(__dirname, '..');

  // Load compiled artifacts
  const factoryArtifact = JSON.parse(
    fs.readFileSync(path.join(root, 'artifacts/contracts/AgentWalletFactory.sol/AgentWalletFactory.json'), 'utf8')
  );
  const walletArtifact = JSON.parse(
    fs.readFileSync(path.join(root, 'artifacts/contracts/AgentWallet.sol/AgentWallet.json'), 'utf8')
  );

  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC);
  const deployer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

  const balance = await provider.getBalance(deployer.address);
  console.log('Deployer:', deployer.address);
  console.log('Balance: ', ethers.formatEther(balance), 'ETH');
  if (balance === 0n) throw new Error('No ETH — fund the relayer wallet first');

  const network = await provider.getNetwork();
  console.log('Network: ', network.name, '(chainId', network.chainId.toString() + ')');

  // Deploy AgentWalletFactory
  console.log('\n→ Deploying AgentWalletFactory...');
  const Factory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, deployer);
  const factory = await Factory.deploy();
  console.log('  TX hash:', factory.deploymentTransaction().hash);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  console.log('\n✅ Deployment complete!');
  console.log('──────────────────────────────────────────────────────');
  console.log('FACTORY_ADDRESS=' + factoryAddress);
  console.log('──────────────────────────────────────────────────────');
  console.log('\nVerify on Etherscan:');
  console.log('https://sepolia.etherscan.io/address/' + factoryAddress);

  // Auto-write to .env
  const envPath = path.join(root, '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  envContent = envContent.replace(/^FACTORY_ADDRESS=.*$/m, 'FACTORY_ADDRESS=' + factoryAddress);
  fs.writeFileSync(envPath, envContent);
  console.log('\n✅ .env updated with FACTORY_ADDRESS');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
