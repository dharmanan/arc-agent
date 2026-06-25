'use strict';

const { ethers } = require('ethers');
const { sendProtectedContractTx } = require('../txSecurityService');
const { createArcRpcProvider } = require('../arcProvider');

const CONSTANT_PRODUCT_PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function mint(address to) returns (uint256 liquidity)',
  'function burn(address to) returns (uint256 amount0, uint256 amount1)',
  'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)',
];

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

function getArcRpcUrl() {
  return process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
}

function toFeeBps(feePct = 0.3) {
  const normalized = Number(feePct);
  if (!Number.isFinite(normalized) || normalized <= 0) return 30;
  return Math.max(1, Math.round(normalized * 100));
}

function applySlippageFloor(amountRaw, slippagePct = 0.5) {
  const normalized = Number(slippagePct);
  if (!Number.isFinite(normalized) || normalized <= 0) return amountRaw;

  const basisPoints = BigInt(Math.round(normalized * 100));
  return amountRaw * (10_000n - basisPoints) / 10_000n;
}

function calculateAmountOut(amountInRaw, reserveInRaw, reserveOutRaw, feePct = 0.3) {
  if (amountInRaw <= 0n || reserveInRaw <= 0n || reserveOutRaw <= 0n) {
    return 0n;
  }

  const feeBps = BigInt(toFeeBps(feePct));
  const amountInWithFee = amountInRaw * (10_000n - feeBps);
  const numerator = amountInWithFee * reserveOutRaw;
  const denominator = reserveInRaw * 10_000n + amountInWithFee;

  if (denominator <= 0n) {
    return 0n;
  }

  return numerator / denominator;
}

function sqrtBigInt(value) {
  if (value < 0n) {
    throw new Error('sqrtBigInt only supports non-negative values');
  }
  if (value < 2n) {
    return value;
  }

  let x0 = value;
  let x1 = (value >> 1n) + 1n;

  while (x1 < x0) {
    x0 = x1;
    x1 = ((value / x1) + x1) >> 1n;
  }

  return x0;
}

function calculateOptimalZapInSwapAmount(totalAmountInRaw, reserveInRaw, feePct = 0.3) {
  if (totalAmountInRaw <= 0n || reserveInRaw <= 0n) {
    return 0n;
  }

  const scale = 10_000n;
  const feeBps = BigInt(toFeeBps(feePct));
  const gamma = scale - feeBps;
  const reserveTerm = reserveInRaw * (scale + gamma);
  const discriminant = reserveTerm * reserveTerm + 4n * gamma * reserveInRaw * totalAmountInRaw * scale;
  const numerator = sqrtBigInt(discriminant) - reserveTerm;

  if (numerator <= 0n || gamma <= 0n) {
    return 0n;
  }

  return numerator / (2n * gamma);
}

async function readPairState(pairAddress, provider) {
  const pair = new ethers.Contract(pairAddress, CONSTANT_PRODUCT_PAIR_ABI, provider);
  const [token0, token1, reserves] = await Promise.all([
    pair.token0(),
    pair.token1(),
    pair.getReserves(),
  ]);

  return {
    pair,
    token0: ethers.getAddress(token0),
    token1: ethers.getAddress(token1),
    reserve0: reserves.reserve0,
    reserve1: reserves.reserve1,
  };
}

function resolveSwapDirection(pairState, tokenInAddress, tokenOutAddress) {
  const normalizedTokenIn = ethers.getAddress(tokenInAddress);
  const normalizedTokenOut = ethers.getAddress(tokenOutAddress);

  if (pairState.token0 === normalizedTokenIn && pairState.token1 === normalizedTokenOut) {
    return {
      zeroForOne: true,
      reserveInRaw: pairState.reserve0,
      reserveOutRaw: pairState.reserve1,
    };
  }

  if (pairState.token0 === normalizedTokenOut && pairState.token1 === normalizedTokenIn) {
    return {
      zeroForOne: false,
      reserveInRaw: pairState.reserve1,
      reserveOutRaw: pairState.reserve0,
    };
  }

  throw new Error('Pair token ordering does not match the requested swap direction');
}

function resolveLiquidityPlan(pairState, tokenAAddress, tokenBAddress, maxAmountARaw, maxAmountBRaw) {
  const normalizedTokenA = ethers.getAddress(tokenAAddress);
  const normalizedTokenB = ethers.getAddress(tokenBAddress);

  let reserveARaw;
  let reserveBRaw;

  if (pairState.token0 === normalizedTokenA && pairState.token1 === normalizedTokenB) {
    reserveARaw = pairState.reserve0;
    reserveBRaw = pairState.reserve1;
  } else if (pairState.token0 === normalizedTokenB && pairState.token1 === normalizedTokenA) {
    reserveARaw = pairState.reserve1;
    reserveBRaw = pairState.reserve0;
  } else {
    throw new Error('Pair token ordering does not match the requested liquidity direction');
  }

  if (maxAmountARaw <= 0n || maxAmountBRaw <= 0n) {
    throw new Error('Both liquidity token amounts must be greater than zero');
  }

  if ((reserveARaw === 0n) !== (reserveBRaw === 0n)) {
    throw new Error('Pair reserves are inconsistent and cannot price a liquidity addition');
  }

  let amountAUsedRaw = maxAmountARaw;
  let amountBUsedRaw = maxAmountBRaw;

  if (reserveARaw > 0n && reserveBRaw > 0n) {
    const optimalAmountBRaw = maxAmountARaw * reserveBRaw / reserveARaw;
    if (optimalAmountBRaw <= maxAmountBRaw) {
      amountBUsedRaw = optimalAmountBRaw;
    } else {
      amountAUsedRaw = maxAmountBRaw * reserveARaw / reserveBRaw;
    }
  }

  if (amountAUsedRaw <= 0n || amountBUsedRaw <= 0n) {
    throw new Error('Pair reserves would round this liquidity addition down to zero');
  }

  return {
    reserveARaw,
    reserveBRaw,
    amountAUsedRaw,
    amountBUsedRaw,
    amountARemainingRaw: maxAmountARaw - amountAUsedRaw,
    amountBRemainingRaw: maxAmountBRaw - amountBUsedRaw,
  };
}

async function getConstantProductQuote({
  pairAddress,
  tokenInAddress,
  tokenOutAddress,
  amountIn,
  decimalsIn = 6,
  decimalsOut = 6,
  feePct = 0.3,
}) {
  const provider = createArcRpcProvider(getArcRpcUrl());
  const pairState = await readPairState(pairAddress, provider);
  const direction = resolveSwapDirection(pairState, tokenInAddress, tokenOutAddress);
  const amountInRaw = ethers.parseUnits(String(amountIn), decimalsIn);
  const amountOutRaw = calculateAmountOut(amountInRaw, direction.reserveInRaw, direction.reserveOutRaw, feePct);

  return {
    amountOut: ethers.formatUnits(amountOutRaw, decimalsOut),
    amountOutRaw,
    reserveInRaw: direction.reserveInRaw,
    reserveOutRaw: direction.reserveOutRaw,
  };
}

async function executeConstantProductSwap({
  pairAddress,
  tokenInAddress,
  tokenOutAddress,
  amountIn,
  slippagePct = 0.5,
  agentPrivateKey,
  decimalsIn = 6,
  decimalsOut = 6,
  feePct = 0.3,
}) {
  if (!agentPrivateKey) {
    throw new Error('agentPrivateKey is required');
  }

  const provider = createArcRpcProvider(getArcRpcUrl());
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const pairState = await readPairState(pairAddress, signer);
  const direction = resolveSwapDirection(pairState, tokenInAddress, tokenOutAddress);
  const amountInRaw = ethers.parseUnits(String(amountIn), decimalsIn);
  const amountOutRaw = calculateAmountOut(amountInRaw, direction.reserveInRaw, direction.reserveOutRaw, feePct);

  if (amountOutRaw <= 0n) {
    throw new Error('Constant-product pair has insufficient liquidity for this swap');
  }

  const minAmountOutRaw = applySlippageFloor(amountOutRaw, slippagePct);
  const tokenIn = new ethers.Contract(tokenInAddress, ERC20_ABI, signer);
  const pair = new ethers.Contract(pairAddress, CONSTANT_PRODUCT_PAIR_ABI, signer);

  await sendProtectedContractTx({
    contract: tokenIn,
    methodName: 'transfer',
    args: [pairAddress, amountInRaw],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_swap_transfer_in',
    replayFingerprint: [pairAddress, tokenInAddress, amountInRaw.toString()],
  });

  const amount0Out = direction.zeroForOne ? 0n : minAmountOutRaw;
  const amount1Out = direction.zeroForOne ? minAmountOutRaw : 0n;
  const { receipt } = await sendProtectedContractTx({
    contract: pair,
    methodName: 'swap',
    args: [amount0Out, amount1Out, signer.address, '0x'],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_swap',
    replayFingerprint: [pairAddress, amount0Out.toString(), amount1Out.toString(), amountInRaw.toString()],
  });

  return {
    txHash: receipt.hash,
    amountOut: ethers.formatUnits(amountOutRaw, decimalsOut),
    minAmountOut: ethers.formatUnits(minAmountOutRaw, decimalsOut),
  };
}

async function executeConstantProductAddLiquidity({
  pairAddress,
  tokenAAddress,
  tokenBAddress,
  maxAmountA,
  maxAmountB,
  agentPrivateKey,
  decimalsA = 6,
  decimalsB = 6,
  lpDecimals = 18,
}) {
  if (!agentPrivateKey) {
    throw new Error('agentPrivateKey is required');
  }

  const provider = createArcRpcProvider(getArcRpcUrl());
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const pairState = await readPairState(pairAddress, signer);
  const pair = new ethers.Contract(pairAddress, CONSTANT_PRODUCT_PAIR_ABI, signer);
  const tokenA = new ethers.Contract(tokenAAddress, ERC20_ABI, signer);
  const tokenB = new ethers.Contract(tokenBAddress, ERC20_ABI, signer);
  const maxAmountARaw = ethers.parseUnits(String(maxAmountA), decimalsA);
  const maxAmountBRaw = ethers.parseUnits(String(maxAmountB), decimalsB);
  const plan = resolveLiquidityPlan(pairState, tokenAAddress, tokenBAddress, maxAmountARaw, maxAmountBRaw);

  await sendProtectedContractTx({
    contract: tokenA,
    methodName: 'transfer',
    args: [pairAddress, plan.amountAUsedRaw],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_add_liquidity_transfer_a',
    replayFingerprint: [pairAddress, tokenAAddress, plan.amountAUsedRaw.toString()],
  });

  await sendProtectedContractTx({
    contract: tokenB,
    methodName: 'transfer',
    args: [pairAddress, plan.amountBUsedRaw],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_add_liquidity_transfer_b',
    replayFingerprint: [pairAddress, tokenBAddress, plan.amountBUsedRaw.toString()],
  });

  const lpAmountRaw = await pair.mint.staticCall(signer.address);
  const { receipt: mintReceipt } = await sendProtectedContractTx({
    contract: pair,
    methodName: 'mint',
    args: [signer.address],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_add_liquidity_mint',
    replayFingerprint: [pairAddress, lpAmountRaw.toString(), plan.amountAUsedRaw.toString(), plan.amountBUsedRaw.toString()],
  });

  return {
    txHash: mintReceipt.hash,
    mintTxHash: mintReceipt.hash,
    lpAmount: ethers.formatUnits(lpAmountRaw, lpDecimals),
    amountAUsed: ethers.formatUnits(plan.amountAUsedRaw, decimalsA),
    amountBUsed: ethers.formatUnits(plan.amountBUsedRaw, decimalsB),
    amountARemaining: ethers.formatUnits(plan.amountARemainingRaw, decimalsA),
    amountBRemaining: ethers.formatUnits(plan.amountBRemainingRaw, decimalsB),
  };
}

async function executeConstantProductZapIn({
  pairAddress,
  tokenInAddress,
  tokenOutAddress,
  totalAmountIn,
  swapAmountIn,
  slippagePct = 0.5,
  agentPrivateKey,
  decimalsIn = 6,
  decimalsOut = 6,
  feePct = 0.3,
}) {
  if (!agentPrivateKey) {
    throw new Error('agentPrivateKey is required');
  }

  const provider = createArcRpcProvider(getArcRpcUrl());
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const pairState = await readPairState(pairAddress, signer);
  const direction = resolveSwapDirection(pairState, tokenInAddress, tokenOutAddress);

  if (direction.reserveInRaw <= 0n || direction.reserveOutRaw <= 0n) {
    throw new Error('Constant-product pair must be seeded before zap-in liquidity can run');
  }

  const totalAmountInRaw = ethers.parseUnits(String(totalAmountIn), decimalsIn);
  if (totalAmountInRaw <= 0n) {
    throw new Error('totalAmountIn must be greater than zero');
  }

  const explicitSwapAmountRaw = swapAmountIn != null
    ? ethers.parseUnits(String(swapAmountIn), decimalsIn)
    : null;
  const swapAmountInRaw = explicitSwapAmountRaw != null
    ? explicitSwapAmountRaw
    : calculateOptimalZapInSwapAmount(totalAmountInRaw, direction.reserveInRaw, feePct);

  if (swapAmountInRaw >= totalAmountInRaw) {
    throw new Error('swapAmountIn must be smaller than totalAmountIn');
  }

  const remainingAmountInRaw = totalAmountInRaw - swapAmountInRaw;
  const quotedAmountOutRaw = calculateAmountOut(swapAmountInRaw, direction.reserveInRaw, direction.reserveOutRaw, feePct);

  if (swapAmountInRaw <= 0n || remainingAmountInRaw <= 0n || quotedAmountOutRaw <= 0n) {
    throw new Error('Constant-product pair could not derive a valid zap-in split for this amount');
  }

  const minAmountOutRaw = applySlippageFloor(quotedAmountOutRaw, slippagePct);
  const tokenIn = new ethers.Contract(tokenInAddress, ERC20_ABI, signer);
  const tokenOut = new ethers.Contract(tokenOutAddress, ERC20_ABI, signer);
  const pair = new ethers.Contract(pairAddress, CONSTANT_PRODUCT_PAIR_ABI, signer);

  const tokenOutBalanceBefore = await tokenOut.balanceOf(signer.address);
  await sendProtectedContractTx({
    contract: tokenIn,
    methodName: 'transfer',
    args: [pairAddress, swapAmountInRaw],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_zap_transfer_swap_leg',
    replayFingerprint: [pairAddress, tokenInAddress, swapAmountInRaw.toString()],
  });

  const amount0Out = direction.zeroForOne ? 0n : minAmountOutRaw;
  const amount1Out = direction.zeroForOne ? minAmountOutRaw : 0n;
  const { receipt: swapReceipt } = await sendProtectedContractTx({
    contract: pair,
    methodName: 'swap',
    args: [amount0Out, amount1Out, signer.address, '0x'],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_zap_swap',
    replayFingerprint: [pairAddress, amount0Out.toString(), amount1Out.toString(), swapAmountInRaw.toString()],
  });

  const tokenOutBalanceAfter = await tokenOut.balanceOf(signer.address);
  const receivedAmountOutRaw = tokenOutBalanceAfter - tokenOutBalanceBefore;
  if (receivedAmountOutRaw <= 0n) {
    throw new Error('Zap-in swap did not return output tokens to the agent wallet');
  }

  await sendProtectedContractTx({
    contract: tokenIn,
    methodName: 'transfer',
    args: [pairAddress, remainingAmountInRaw],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_zap_transfer_remaining_in',
    replayFingerprint: [pairAddress, tokenInAddress, remainingAmountInRaw.toString()],
  });

  await sendProtectedContractTx({
    contract: tokenOut,
    methodName: 'transfer',
    args: [pairAddress, receivedAmountOutRaw],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_zap_transfer_out',
    replayFingerprint: [pairAddress, tokenOutAddress, receivedAmountOutRaw.toString()],
  });

  const lpDecimals = await pair.decimals().catch(() => 18);
  const lpAmountRaw = await pair.mint.staticCall(signer.address);
  const { receipt: mintReceipt } = await sendProtectedContractTx({
    contract: pair,
    methodName: 'mint',
    args: [signer.address],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_zap_mint',
    replayFingerprint: [pairAddress, lpAmountRaw.toString(), totalAmountInRaw.toString()],
  });

  return {
    txHash: mintReceipt.hash,
    swapTxHash: swapReceipt.hash,
    mintTxHash: mintReceipt.hash,
    swappedAmountIn: ethers.formatUnits(swapAmountInRaw, decimalsIn),
    remainingAmountIn: ethers.formatUnits(remainingAmountInRaw, decimalsIn),
    amountOut: ethers.formatUnits(receivedAmountOutRaw, decimalsOut),
    quotedAmountOut: ethers.formatUnits(quotedAmountOutRaw, decimalsOut),
    minAmountOut: ethers.formatUnits(minAmountOutRaw, decimalsOut),
    lpAmount: ethers.formatUnits(lpAmountRaw, lpDecimals),
  };
}

async function executeConstantProductRemoveLiquidity({
  pairAddress,
  withdrawPct = 100,
  agentPrivateKey,
  tokenDecimals = {},
  lpDecimals = 18,
}) {
  if (!agentPrivateKey) {
    throw new Error('agentPrivateKey is required');
  }

  const normalizedWithdrawPct = Number(withdrawPct);
  if (!Number.isFinite(normalizedWithdrawPct) || normalizedWithdrawPct <= 0 || normalizedWithdrawPct > 100) {
    throw new Error('withdrawPct must be between 0 and 100');
  }

  const provider = createArcRpcProvider(getArcRpcUrl());
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const pairState = await readPairState(pairAddress, signer);
  const pair = new ethers.Contract(pairAddress, CONSTANT_PRODUCT_PAIR_ABI, signer);

  const lpBalanceRaw = await pair.balanceOf(signer.address);
  if (lpBalanceRaw <= 0n) {
    throw new Error('Direct-pair LP position not found for this wallet');
  }

  const withdrawBps = BigInt(Math.round(normalizedWithdrawPct * 100));
  const lpAmountRaw = lpBalanceRaw * withdrawBps / 10_000n;
  if (lpAmountRaw <= 0n) {
    throw new Error('Requested LP withdrawal is too small for the current balance');
  }

  await sendProtectedContractTx({
    contract: pair,
    methodName: 'transfer',
    args: [pairAddress, lpAmountRaw],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_remove_liquidity_transfer_lp',
    replayFingerprint: [pairAddress, lpAmountRaw.toString(), normalizedWithdrawPct],
  });

  const [amount0Raw, amount1Raw] = await pair.burn.staticCall(signer.address);
  const { receipt: burnReceipt } = await sendProtectedContractTx({
    contract: pair,
    methodName: 'burn',
    args: [signer.address],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'constant_product_remove_liquidity_burn',
    replayFingerprint: [pairAddress, amount0Raw.toString(), amount1Raw.toString(), lpAmountRaw.toString()],
  });

  const token0Decimals = Number(tokenDecimals[String(pairState.token0).toLowerCase()] ?? 18);
  const token1Decimals = Number(tokenDecimals[String(pairState.token1).toLowerCase()] ?? 18);

  return {
    txHash: burnReceipt.hash,
    burnTxHash: burnReceipt.hash,
    withdrawPct: normalizedWithdrawPct,
    lpAmount: ethers.formatUnits(lpAmountRaw, lpDecimals),
    token0Address: pairState.token0,
    token1Address: pairState.token1,
    token0Amount: ethers.formatUnits(amount0Raw, token0Decimals),
    token1Amount: ethers.formatUnits(amount1Raw, token1Decimals),
  };
}

module.exports = {
  calculateAmountOut,
  calculateOptimalZapInSwapAmount,
  getConstantProductQuote,
  executeConstantProductAddLiquidity,
  executeConstantProductRemoveLiquidity,
  executeConstantProductSwap,
  executeConstantProductZapIn,
};