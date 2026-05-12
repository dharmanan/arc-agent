// direct-deploy-agentic.js — hardhat olmadan doğrudan deploy
require('dotenv').config({ path: '/workspaces/arc-agent/.env' });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

(async () => {
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../artifacts/contracts/AgenticCommerce.sol/AgenticCommerce.json')
    )
  );

  const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC, {
    chainId: 5042002, name: 'Arc Testnet'
  });
  const wallet   = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);

  console.log('Deploying AgenticCommerce...');
  console.log('  USDC  :', process.env.USDC_ADDRESS_ARC);
  console.log('  Owner :', wallet.address);

  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(process.env.USDC_ADDRESS_ARC, wallet.address);

  console.log('  Tx    :', contract.deploymentTransaction().hash);
  console.log('  Waiting for confirmation...');

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log('\n✅ AgenticCommerce deployed to:', address);
  console.log('\nAdd to .env:');
  console.log(`AGENTIC_COMMERCE_ADDRESS=${address}`);
})().catch(e => { console.error('Deploy error:', e.message); process.exit(1); });
