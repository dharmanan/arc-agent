// scripts/direct-deploy-factory.js — deploy AgentWalletFactory to Arc Testnet
require('dotenv').config({ path: '/workspaces/arc-agent/.env' });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

(async () => {
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../artifacts/contracts/AgentWalletFactory.sol/AgentWalletFactory.json')
    )
  );

  const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC, {
    chainId: 5042002, name: 'Arc Testnet'
  });
  const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

  console.log('Deploying AgentWalletFactory...');
  console.log('  Deployer:', wallet.address);

  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();

  console.log('  Tx      :', contract.deploymentTransaction().hash);
  console.log('  Waiting for confirmation...');

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log('\n✅ AgentWalletFactory deployed to:', address);
  console.log('\nAdd to .env:');
  console.log(`FACTORY_ADDRESS=${address}`);
})().catch(e => { console.error('Deploy error:', e.message); process.exit(1); });
