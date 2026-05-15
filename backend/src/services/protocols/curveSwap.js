'use strict';
/**
 * Curve Finance protocol adapter — ARC Testnet
 *
 * getCurveQuote   — read-only: simulate exchange() output
 * executeCurveSwap — write: call exchange() with agent signer
 * executeCurveAddLiquidity — write: add one-sided liquidity to the verified pool
 * executeCurveRemoveLiquidityOneCoin — write: burn LP into one output token
 *
 * Pool ABI limited to the two functions we need.
 * All amounts are in the token's native decimals (USDC/EURC = 6).
 */
const { ethers }  = require('ethers');

const CURVE_EXCHANGE_ABI = [
  // Read: how many coins[j] do I get for dx coins[i]?
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
  // Write: exchange coins[i] → coins[j], min_dy protects against slippage
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)',
  'function calc_token_amount(uint256[2] amounts, bool is_deposit) view returns (uint256)',
  'function add_liquidity(uint256[2] amounts, uint256 min_mint_amount) returns (uint256)',
  'function calc_withdraw_one_coin(uint256 token_amount, int128 i) view returns (uint256)',
  'function remove_liquidity_one_coin(uint256 token_amount, int128 i, uint256 min_amount) returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  // Coin addresses at each index
  'function coins(uint256 i) view returns (address)',
];

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

function getArcRpcUrl() {
  return process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
}

function applySlippageFloor(amountRaw, slippagePct = 0.5) {
  return amountRaw * BigInt(Math.floor((1 - slippagePct / 100) * 10_000)) / 10_000n;
}

function buildCurveDepositAmounts(indexIn, amountRaw) {
  return Number(indexIn) === 0
    ? [amountRaw, 0n]
    : [0n, amountRaw];
}

/**
 * Get the expected output for a swap.
 *
 * @param {string}  poolAddress   Curve pool contract address
 * @param {number}  indexIn       Token index going in  (0 or 1)
 * @param {number}  indexOut      Token index coming out (0 or 1)
 * @param {string}  amountIn      Human-readable amount (e.g. "100.5")
 * @param {number}  decimalsIn    Decimals of input token (default 6)
 * @param {number}  decimalsOut   Decimals of output token (default 6)
 * @returns {{ amountOut: string, amountOutRaw: bigint }}
 */
async function getCurveQuote(poolAddress, indexIn, indexOut, amountIn, decimalsIn = 6, decimalsOut = 6) {
  const rpcUrl  = getArcRpcUrl();

  const provider  = new ethers.JsonRpcProvider(rpcUrl);
  const pool      = new ethers.Contract(poolAddress, CURVE_EXCHANGE_ABI, provider);
  const amountRaw = ethers.parseUnits(String(amountIn), decimalsIn);
  const outRaw    = await pool.get_dy(indexIn, indexOut, amountRaw);

  return {
    amountOut:    ethers.formatUnits(outRaw, decimalsOut),
    amountOutRaw: outRaw,
  };
}

/**
 * Execute a Curve swap with the agent's private key.
 *
 * @param {object} params
 * @param {string} params.poolAddress      Curve pool address
 * @param {string} params.tokenInAddress   ERC-20 address of the token being sold
 * @param {number} params.indexIn          Curve coin index of tokenIn
 * @param {number} params.indexOut         Curve coin index of tokenOut
 * @param {string} params.amountIn         Human-readable amount in
 * @param {number} params.slippagePct      Acceptable slippage % (e.g. 0.5 = 0.5%)
 * @param {string} params.agentPrivateKey  Decrypted agent wallet private key
 * @param {number} [params.decimalsIn=6]
 * @param {number} [params.decimalsOut=6]
 * @returns {{ txHash: string, amountOut: string }}
 */
async function executeCurveSwap({
  poolAddress,
  tokenInAddress,
  indexIn,
  indexOut,
  amountIn,
  slippagePct = 0.5,
  agentPrivateKey,
  decimalsIn  = 6,
  decimalsOut = 6,
}) {
  const rpcUrl  = getArcRpcUrl();
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider  = new ethers.JsonRpcProvider(rpcUrl);
  const signer    = new ethers.Wallet(agentPrivateKey, provider);
  const amountRaw = ethers.parseUnits(String(amountIn), decimalsIn);

  // Get expected output → apply slippage floor
  const pool     = new ethers.Contract(poolAddress, CURVE_EXCHANGE_ABI, signer);
  const outRaw   = await pool.get_dy(indexIn, indexOut, amountRaw);
  const minDy    = applySlippageFloor(outRaw, slippagePct);

  // Approve pool to spend tokenIn if allowance is insufficient
  const token      = new ethers.Contract(tokenInAddress, ERC20_APPROVE_ABI, signer);
  const allowance  = await token.allowance(signer.address, poolAddress);
  if (allowance < amountRaw) {
    const approveTx = await token.approve(poolAddress, amountRaw);
    await approveTx.wait(1);
  }

  // Execute swap
  const tx      = await pool.exchange(indexIn, indexOut, amountRaw, minDy);
  const receipt = await tx.wait(1);

  return {
    txHash:    receipt.hash,
    amountOut: ethers.formatUnits(outRaw, decimalsOut),
    minDy:     ethers.formatUnits(minDy, decimalsOut),
  };
}

async function executeCurveAddLiquidity({
  poolAddress,
  tokenInAddress,
  indexIn,
  amountIn,
  slippagePct = 0.5,
  agentPrivateKey,
  decimalsIn = 6,
  lpDecimals = 18,
}) {
  const rpcUrl = getArcRpcUrl();
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const amountRaw = ethers.parseUnits(String(amountIn), decimalsIn);
  const depositAmounts = buildCurveDepositAmounts(indexIn, amountRaw);
  const pool = new ethers.Contract(poolAddress, CURVE_EXCHANGE_ABI, signer);

  const lpOutRaw = await pool.calc_token_amount(depositAmounts, true).catch(() => null);
  const minMintAmount = lpOutRaw ? applySlippageFloor(lpOutRaw, slippagePct) : 0n;

  const token = new ethers.Contract(tokenInAddress, ERC20_APPROVE_ABI, signer);
  const allowance = await token.allowance(signer.address, poolAddress);
  if (allowance < amountRaw) {
    const approveTx = await token.approve(poolAddress, amountRaw);
    await approveTx.wait(1);
  }

  const tx = await pool.add_liquidity(depositAmounts, minMintAmount);
  const receipt = await tx.wait(1);

  return {
    txHash: receipt.hash,
    lpAmount: lpOutRaw ? ethers.formatUnits(lpOutRaw, lpDecimals) : null,
    minLpAmount: lpOutRaw ? ethers.formatUnits(minMintAmount, lpDecimals) : null,
  };
}

async function executeCurveRemoveLiquidityOneCoin({
  poolAddress,
  indexOut,
  lpAmount,
  slippagePct = 0.5,
  agentPrivateKey,
  decimalsOut = 6,
  lpDecimals = 18,
}) {
  const rpcUrl = getArcRpcUrl();
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const pool = new ethers.Contract(poolAddress, CURVE_EXCHANGE_ABI, signer);
  const lpAmountRaw = ethers.parseUnits(String(lpAmount), lpDecimals);

  const amountOutRaw = await pool.calc_withdraw_one_coin(lpAmountRaw, indexOut).catch(() => null);
  const minAmountOut = amountOutRaw ? applySlippageFloor(amountOutRaw, slippagePct) : 0n;

  const tx = await pool.remove_liquidity_one_coin(lpAmountRaw, indexOut, minAmountOut);
  const receipt = await tx.wait(1);

  return {
    txHash: receipt.hash,
    amountOut: amountOutRaw ? ethers.formatUnits(amountOutRaw, decimalsOut) : null,
    minAmountOut: amountOutRaw ? ethers.formatUnits(minAmountOut, decimalsOut) : null,
  };
}

module.exports = {
  getCurveQuote,
  executeCurveSwap,
  executeCurveAddLiquidity,
  executeCurveRemoveLiquidityOneCoin,
};
