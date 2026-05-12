// scripts/deploy-agentic-commerce.js
// Usage: npx hardhat run scripts/deploy-agentic-commerce.js --network arcTestnet
//        USDC_ADDRESS ve OWNER_ADDRESS .env'den alınır.

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const hre = require('hardhat');

async function main() {
  const usdcAddress  = process.env.USDC_ADDRESS_ARC;
  const ownerAddress = process.env.RELAYER_PRIVATE_KEY
    ? new hre.ethers.Wallet(process.env.RELAYER_PRIVATE_KEY).address
    : null;

  if (!usdcAddress)  throw new Error('USDC_ADDRESS_ARC missing in .env');
  if (!ownerAddress) throw new Error('RELAYER_PRIVATE_KEY missing in .env');

  console.log('Deploying AgenticCommerce...');
  console.log('  USDC  :', usdcAddress);
  console.log('  Owner :', ownerAddress);

  const Factory  = await hre.ethers.getContractFactory('AgenticCommerce');
  const contract = await Factory.deploy(usdcAddress, ownerAddress);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('\n✅ AgenticCommerce deployed to:', address);
  console.log('\nAdd to .env:');
  console.log(`AGENTIC_COMMERCE_ADDRESS=${address}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
