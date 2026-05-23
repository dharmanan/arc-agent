'use strict';

require('/workspaces/arc-agent/backend/node_modules/dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { ethers } = require('/workspaces/arc-agent/backend/node_modules/ethers');

const ARC_LENDING_POOL_ABI = [
  'function supportedAssetCount() view returns (uint256)',
  'function supportedAssetAt(uint256 index) view returns (address)',
  'function configureReserve(address asset,uint8 decimals,uint16 collateralFactorBps,uint16 liquidationThresholdBps,uint16 liquidationBonusBps,uint16 reserveFactorBps,uint128 supplyCap,uint128 borrowCap,bool collateralEnabled,bool borrowEnabled,bool paused)',
];

const DEFAULT_DECIMALS = 6;
const DEFAULT_COLLATERAL_FACTOR_BPS = 8_000;
const DEFAULT_LIQUIDATION_THRESHOLD_BPS = 8_500;
const DEFAULT_LIQUIDATION_BONUS_BPS = 10_500;
const DEFAULT_RESERVE_FACTOR_BPS = 1_000;
const DEFAULT_SUPPLY_CAP = '1000000';
const DEFAULT_BORROW_CAP = '850000';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readOptionalNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function buildReserveSpec(symbol, addressEnvName) {
  const decimals = readOptionalNumber(`LENDING_${symbol}_DECIMALS`, DEFAULT_DECIMALS);
  return {
    symbol,
    address: requiredEnv(addressEnvName),
    decimals,
    collateralFactorBps: readOptionalNumber(`LENDING_${symbol}_COLLATERAL_FACTOR_BPS`, DEFAULT_COLLATERAL_FACTOR_BPS),
    liquidationThresholdBps: readOptionalNumber(`LENDING_${symbol}_LIQUIDATION_THRESHOLD_BPS`, DEFAULT_LIQUIDATION_THRESHOLD_BPS),
    liquidationBonusBps: readOptionalNumber(`LENDING_${symbol}_LIQUIDATION_BONUS_BPS`, DEFAULT_LIQUIDATION_BONUS_BPS),
    reserveFactorBps: readOptionalNumber(`LENDING_${symbol}_RESERVE_FACTOR_BPS`, DEFAULT_RESERVE_FACTOR_BPS),
    supplyCap: ethers.parseUnits(process.env[`LENDING_${symbol}_SUPPLY_CAP`] || DEFAULT_SUPPLY_CAP, decimals),
    borrowCap: ethers.parseUnits(process.env[`LENDING_${symbol}_BORROW_CAP`] || DEFAULT_BORROW_CAP, decimals),
    collateralEnabled: String(process.env[`LENDING_${symbol}_COLLATERAL_ENABLED`] || 'true') !== 'false',
    borrowEnabled: String(process.env[`LENDING_${symbol}_BORROW_ENABLED`] || 'true') !== 'false',
    paused: String(process.env[`LENDING_${symbol}_PAUSED`] || 'false') === 'true',
  };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC);
  const signer = new ethers.Wallet(requiredEnv('RELAYER_PRIVATE_KEY'), provider);
  const poolAddress = requiredEnv('ARC_LENDING_POOL_ADDRESS');
  const pool = new ethers.Contract(poolAddress, ARC_LENDING_POOL_ABI, signer);

  const desiredReserves = [
    buildReserveSpec('USDC', 'USDC_ADDRESS_ARC'),
    buildReserveSpec('EURC', 'EURC_ADDRESS_ARC'),
  ];

  const configuredCount = Number(await pool.supportedAssetCount());
  const configuredAssets = new Set();
  for (let index = 0; index < configuredCount; index += 1) {
    configuredAssets.add(String(await pool.supportedAssetAt(index)).toLowerCase());
  }

  for (const reserve of desiredReserves) {
    if (configuredAssets.has(reserve.address.toLowerCase())) {
      console.log(`skip ${reserve.symbol}: already configured`);
      continue;
    }

    console.log(`configure ${reserve.symbol}...`);
    const tx = await pool.configureReserve(
      reserve.address,
      reserve.decimals,
      reserve.collateralFactorBps,
      reserve.liquidationThresholdBps,
      reserve.liquidationBonusBps,
      reserve.reserveFactorBps,
      reserve.supplyCap,
      reserve.borrowCap,
      reserve.collateralEnabled,
      reserve.borrowEnabled,
      reserve.paused,
    );
    console.log(`  tx=${tx.hash}`);
    await tx.wait(1);
  }

  console.log(`configured_count=${(await pool.supportedAssetCount()).toString()}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});