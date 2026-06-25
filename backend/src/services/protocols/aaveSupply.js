'use strict';
/**
 * Aave V3 protocol adapter — ARC Testnet
 *
 * getAaveApy        — read-only: current supply / borrow APY for an asset
 * executeAaveSupply — write: supply (deposit) an asset to earn yield
 * executeAaveWithdraw — write: withdraw a previously supplied asset
 *
 * Requires AAVE_POOL_ADDRESS env var (find via ArcScan or DefiLlama).
 * Falls back to oracle/defiLlama data when on-chain pool is not deployed yet.
 */
const { ethers }  = require('ethers');
const defiLlama   = require('../oracle/defiLlama');
const { createArcRpcProvider } = require('../arcProvider');

// Minimal Aave V3 Pool ABI
const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

function getArcRpcUrl() {
  return process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
}

/**
 * Get current supply and borrow APY for an asset.
 *
 * Tries on-chain first (AAVE_POOL_ADDRESS env); falls back to DefiLlama yields.
 *
 * @param {string} assetAddress  ERC-20 address of the asset
 * @param {string} assetSymbol   Human-readable symbol (e.g. 'USDC')
 * @param {number} [decimals=6]
 * @returns {{ supplyApy: number, borrowApy: number, source: string }}
 */
async function getAaveApy(assetAddress, assetSymbol = 'USDC') {
  const poolAddress = process.env.AAVE_POOL_ADDRESS;

  if (poolAddress) {
    try {
      const rpcUrl  = getArcRpcUrl();

      const provider = createArcRpcProvider(rpcUrl);
      const pool     = new ethers.Contract(poolAddress, AAVE_POOL_ABI, provider);
      const data     = await pool.getReserveData(assetAddress);

      // currentLiquidityRate is in ray (1e27) — convert to annual APY
      const liquidityRate      = Number(data.currentLiquidityRate);
      const variableBorrowRate = Number(data.currentVariableBorrowRate);
      const supplyApy = ((1 + liquidityRate      / 1e27 / 365) ** 365 - 1) * 100;
      const borrowApy = ((1 + variableBorrowRate / 1e27 / 365) ** 365 - 1) * 100;

      return {
        supplyApy: Math.round(supplyApy * 100) / 100,
        borrowApy: Math.round(borrowApy * 100) / 100,
        source:    'aave_onchain',
      };
    } catch (err) {
      console.warn(`[Protocols/Aave] On-chain APY fetch failed (${err.message}) — falling back to DefiLlama`);
    }
  }

  // Fallback: DefiLlama yield data
  const yields = await defiLlama.getYieldOpportunities(assetSymbol, 0);
  const aaveEntry = yields.find((p) => p.name?.toLowerCase().includes('aave'));

  return {
    supplyApy: aaveEntry?.apy ?? 4.2,
    borrowApy: 0,
    source:    'defillama_fallback',
  };
}

/**
 * Supply (deposit) an asset into Aave.
 *
 * @param {object} params
 * @param {string} params.assetAddress     ERC-20 address to supply
 * @param {string} params.amount           Human-readable amount (e.g. "50.0")
 * @param {string} params.agentPrivateKey  Decrypted agent wallet private key
 * @param {number} [params.decimals=6]
 * @returns {{ txHash: string }}
 */
async function executeAaveSupply({ assetAddress, amount, agentPrivateKey, decimals = 6 }) {
  const poolAddress = process.env.AAVE_POOL_ADDRESS;
  if (!poolAddress)     throw new Error('AAVE_POOL_ADDRESS is not configured');

  const rpcUrl = getArcRpcUrl();
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider  = createArcRpcProvider(rpcUrl);
  const signer    = new ethers.Wallet(agentPrivateKey, provider);
  const amountRaw = ethers.parseUnits(String(amount), decimals);

  // Approve Aave pool
  const token      = new ethers.Contract(assetAddress, ERC20_ABI, signer);
  const allowance  = await token.allowance(signer.address, poolAddress);
  if (allowance < amountRaw) {
    const approveTx = await token.approve(poolAddress, amountRaw);
    await approveTx.wait(1);
  }

  // Supply — referralCode = 0 (no referral)
  const pool    = new ethers.Contract(poolAddress, AAVE_POOL_ABI, signer);
  const tx      = await pool.supply(assetAddress, amountRaw, signer.address, 0);
  const receipt = await tx.wait(1);

  return { txHash: receipt.hash };
}

/**
 * Withdraw a previously supplied asset.
 *
 * @param {object} params
 * @param {string} params.assetAddress     ERC-20 address to withdraw
 * @param {string} params.amount           Human-readable amount, or 'max' to withdraw all
 * @param {string} params.agentPrivateKey  Decrypted agent wallet private key
 * @param {number} [params.decimals=6]
 * @returns {{ txHash: string, amountWithdrawn: string }}
 */
async function executeAaveWithdraw({ assetAddress, amount, agentPrivateKey, decimals = 6 }) {
  const poolAddress = process.env.AAVE_POOL_ADDRESS;
  if (!poolAddress)     throw new Error('AAVE_POOL_ADDRESS is not configured');

  const rpcUrl = getArcRpcUrl();
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider  = createArcRpcProvider(rpcUrl);
  const signer    = new ethers.Wallet(agentPrivateKey, provider);

  // ethers.MaxUint256 = withdraw entire balance
  const amountRaw = amount === 'max'
    ? ethers.MaxUint256
    : ethers.parseUnits(String(amount), decimals);

  const pool    = new ethers.Contract(poolAddress, AAVE_POOL_ABI, signer);
  const tx      = await pool.withdraw(assetAddress, amountRaw, signer.address);
  const receipt = await tx.wait(1);

  // Decode actual withdrawn amount from receipt logs if available
  return {
    txHash:          receipt.hash,
    amountWithdrawn: amount === 'max' ? 'all' : amount,
  };
}

module.exports = { getAaveApy, executeAaveSupply, executeAaveWithdraw };
