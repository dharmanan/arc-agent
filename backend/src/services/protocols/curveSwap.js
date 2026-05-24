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
const { sendProtectedContractTx } = require('../txSecurityService');

const CURVE_EXCHANGE_ABI = [
  // Read: how many coins[j] do I get for dx coins[i]?
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
  // Write: exchange coins[i] → coins[j], min_dy protects against slippage
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)',
  'function calc_token_amount(uint256[] amounts, bool is_deposit) view returns (uint256)',
  'function add_liquidity(uint256[] amounts, uint256 min_mint_amount) returns (uint256)',
  'function calc_withdraw_one_coin(uint256 token_amount, int128 i) view returns (uint256)',
  'function remove_liquidity(uint256 amount, uint256[] min_amounts) returns (uint256[])',
  'function remove_liquidity_one_coin(uint256 token_amount, int128 i, uint256 min_amount) returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  // Coin addresses at each index
  'function coins(uint256 i) view returns (address)',
];

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

const REUSABLE_APPROVAL_AMOUNT = ethers.MaxUint256;

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

async function approveIfNeeded(tokenAddress, signer, spender, amountRaw, txSecurity = {}) {
  const token = new ethers.Contract(tokenAddress, ERC20_APPROVE_ABI, signer);
  const allowance = await token.allowance(signer.address, spender);
  if (allowance >= amountRaw) {
    return token;
  }

  try {
    await sendProtectedContractTx({
      contract: token,
      methodName: 'approve',
      args: [spender, REUSABLE_APPROVAL_AMOUNT],
      chainName: 'Arc Testnet',
      walletAddress: txSecurity.walletAddress || signer.address,
      agentId: txSecurity.agentId || null,
      operation: txSecurity.operation || 'curve_token_approve',
      replayFingerprint: txSecurity.replayFingerprint || [tokenAddress, spender, amountRaw.toString()],
    });
  } catch (error) {
    if (allowance > 0n) {
      await sendProtectedContractTx({
        contract: token,
        methodName: 'approve',
        args: [spender, 0n],
        chainName: 'Arc Testnet',
        walletAddress: txSecurity.walletAddress || signer.address,
        agentId: txSecurity.agentId || null,
        operation: `${txSecurity.operation || 'curve_token_approve'}_reset`,
        replayFingerprint: ['reset', tokenAddress, spender],
      });
      await sendProtectedContractTx({
        contract: token,
        methodName: 'approve',
        args: [spender, REUSABLE_APPROVAL_AMOUNT],
        chainName: 'Arc Testnet',
        walletAddress: txSecurity.walletAddress || signer.address,
        agentId: txSecurity.agentId || null,
        operation: txSecurity.operation || 'curve_token_approve',
        replayFingerprint: txSecurity.replayFingerprint || [tokenAddress, spender, amountRaw.toString()],
      });
    } else {
      throw error;
    }
  }

  const refreshedAllowance = await token.allowance(signer.address, spender);
  if (refreshedAllowance < amountRaw) {
    throw new Error(`Curve approval remained below the required amount for ${tokenAddress}`);
  }

  return token;
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
  await approveIfNeeded(tokenInAddress, signer, poolAddress, amountRaw, {
    operation: 'curve_swap_approve',
    replayFingerprint: [poolAddress, tokenInAddress, amountRaw.toString()],
  });

  // Execute swap
  const { receipt } = await sendProtectedContractTx({
    contract: pool,
    methodName: 'exchange',
    args: [indexIn, indexOut, amountRaw, minDy],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'curve_swap',
    replayFingerprint: [poolAddress, indexIn, indexOut, amountRaw.toString(), minDy.toString()],
  });

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

  await approveIfNeeded(tokenInAddress, signer, poolAddress, amountRaw, {
    operation: 'curve_add_liquidity_approve',
    replayFingerprint: [poolAddress, tokenInAddress, amountRaw.toString()],
  });

  const { receipt } = await sendProtectedContractTx({
    contract: pool,
    methodName: 'add_liquidity',
    args: [depositAmounts, minMintAmount],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'curve_add_liquidity',
    replayFingerprint: [poolAddress, amountRaw.toString(), minMintAmount.toString(), indexIn],
  });

  return {
    txHash: receipt.hash,
    lpAmount: lpOutRaw ? ethers.formatUnits(lpOutRaw, lpDecimals) : null,
    minLpAmount: lpOutRaw ? ethers.formatUnits(minMintAmount, lpDecimals) : null,
  };
}

async function executeCurveAddLiquidityBalanced({
  poolAddress,
  token0Address,
  token1Address,
  amount0,
  amount1,
  slippagePct = 0.5,
  agentPrivateKey,
  decimals0 = 6,
  decimals1 = 6,
  lpDecimals = 18,
}) {
  const rpcUrl = getArcRpcUrl();
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const amount0Raw = ethers.parseUnits(String(amount0), decimals0);
  const amount1Raw = ethers.parseUnits(String(amount1), decimals1);
  const depositAmounts = [amount0Raw, amount1Raw];
  const pool = new ethers.Contract(poolAddress, CURVE_EXCHANGE_ABI, signer);

  const lpOutRaw = await pool.calc_token_amount(depositAmounts, true).catch(() => null);
  const minMintAmount = lpOutRaw ? applySlippageFloor(lpOutRaw, slippagePct) : 0n;

  await approveIfNeeded(token0Address, signer, poolAddress, amount0Raw, {
    operation: 'curve_add_liquidity_balanced_approve_token0',
    replayFingerprint: [poolAddress, token0Address, amount0Raw.toString()],
  });
  await approveIfNeeded(token1Address, signer, poolAddress, amount1Raw, {
    operation: 'curve_add_liquidity_balanced_approve_token1',
    replayFingerprint: [poolAddress, token1Address, amount1Raw.toString()],
  });

  const { receipt } = await sendProtectedContractTx({
    contract: pool,
    methodName: 'add_liquidity',
    args: [depositAmounts, minMintAmount],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'curve_add_liquidity_balanced',
    replayFingerprint: [poolAddress, amount0Raw.toString(), amount1Raw.toString(), minMintAmount.toString()],
  });

  return {
    txHash: receipt.hash,
    lpAmount: lpOutRaw ? ethers.formatUnits(lpOutRaw, lpDecimals) : null,
    minLpAmount: lpOutRaw ? ethers.formatUnits(minMintAmount, lpDecimals) : null,
    amount0In: ethers.formatUnits(amount0Raw, decimals0),
    amount1In: ethers.formatUnits(amount1Raw, decimals1),
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

  const { receipt } = await sendProtectedContractTx({
    contract: pool,
    methodName: 'remove_liquidity_one_coin',
    args: [lpAmountRaw, indexOut, minAmountOut],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'curve_remove_liquidity_one_coin',
    replayFingerprint: [poolAddress, lpAmountRaw.toString(), indexOut, minAmountOut.toString()],
  });

  return {
    txHash: receipt.hash,
    amountOut: amountOutRaw ? ethers.formatUnits(amountOutRaw, decimalsOut) : null,
    minAmountOut: amountOutRaw ? ethers.formatUnits(minAmountOut, decimalsOut) : null,
  };
}

async function executeCurveRemoveLiquidity({
  poolAddress,
  lpAmount,
  slippagePct = 0.5,
  agentPrivateKey,
  token0Address,
  token1Address,
  decimals0 = 6,
  decimals1 = 6,
  lpDecimals = 18,
}) {
  const rpcUrl = getArcRpcUrl();
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const pool = new ethers.Contract(poolAddress, CURVE_EXCHANGE_ABI, signer);
  const lpAmountRaw = ethers.parseUnits(String(lpAmount), lpDecimals);
  const resolvedToken0Address = token0Address || await pool.coins(0);
  const resolvedToken1Address = token1Address || await pool.coins(1);
  const token0 = new ethers.Contract(resolvedToken0Address, ERC20_APPROVE_ABI, signer);
  const token1 = new ethers.Contract(resolvedToken1Address, ERC20_APPROVE_ABI, signer);

  const [poolToken0BalanceRaw, poolToken1BalanceRaw, totalSupplyRaw, token0BalanceBeforeRaw, token1BalanceBeforeRaw] = await Promise.all([
    token0.balanceOf(poolAddress),
    token1.balanceOf(poolAddress),
    pool.totalSupply(),
    token0.balanceOf(signer.address),
    token1.balanceOf(signer.address),
  ]);

  const expectedAmount0Raw = totalSupplyRaw > 0n ? (poolToken0BalanceRaw * lpAmountRaw) / totalSupplyRaw : 0n;
  const expectedAmount1Raw = totalSupplyRaw > 0n ? (poolToken1BalanceRaw * lpAmountRaw) / totalSupplyRaw : 0n;
  const minAmounts = [
    applySlippageFloor(expectedAmount0Raw, slippagePct),
    applySlippageFloor(expectedAmount1Raw, slippagePct),
  ];

  const { receipt } = await sendProtectedContractTx({
    contract: pool,
    methodName: 'remove_liquidity',
    args: [lpAmountRaw, minAmounts],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'curve_remove_liquidity',
    replayFingerprint: [poolAddress, lpAmountRaw.toString(), minAmounts.map((amount) => amount.toString())],
  });

  const [token0BalanceAfterRaw, token1BalanceAfterRaw] = await Promise.all([
    token0.balanceOf(signer.address),
    token1.balanceOf(signer.address),
  ]);

  return {
    txHash: receipt.hash,
    token0Amount: ethers.formatUnits(token0BalanceAfterRaw - token0BalanceBeforeRaw, decimals0),
    token1Amount: ethers.formatUnits(token1BalanceAfterRaw - token1BalanceBeforeRaw, decimals1),
    minToken0Amount: ethers.formatUnits(minAmounts[0], decimals0),
    minToken1Amount: ethers.formatUnits(minAmounts[1], decimals1),
    lpAmount: ethers.formatUnits(lpAmountRaw, lpDecimals),
  };
}

module.exports = {
  getCurveQuote,
  executeCurveSwap,
  executeCurveAddLiquidity,
  executeCurveAddLiquidityBalanced,
  executeCurveRemoveLiquidity,
  executeCurveRemoveLiquidityOneCoin,
};
