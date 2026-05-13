// scripts/deploy-revenue-pool.js
// Deploy ArcRevenuePool to Arc Testnet
// Usage: npx hardhat run scripts/deploy-revenue-pool.js --network arc

const { ethers } = require('hardhat');
require('dotenv').config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying ArcRevenuePool with:', deployer.address);

  // Arc Testnet USDC
  const USDC_ADDRESS     = process.env.ARC_USDC_ADDRESS  || '0x3600000000000000000000000000000000000000';
  // Platform = relayer address (same as deployer key on testnet)
  const PLATFORM_ADDRESS = process.env.RELAYER_ADDRESS   || deployer.address;

  console.log('USDC address  :', USDC_ADDRESS);
  console.log('Platform addr :', PLATFORM_ADDRESS);

  const Factory = await ethers.getContractFactory('ArcRevenuePool');
  const pool    = await Factory.deploy(USDC_ADDRESS, PLATFORM_ADDRESS);
  await pool.waitForDeployment();

  const address = await pool.getAddress();
  console.log('\n✅ ArcRevenuePool deployed to:', address);
  console.log('Add to .env:\nREVENUE_POOL_ADDRESS=' + address);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
