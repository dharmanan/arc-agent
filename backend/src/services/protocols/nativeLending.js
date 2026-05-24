'use strict';

const { ethers } = require('ethers');
const { sendProtectedContractTx } = require('../txSecurityService');

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const ARC_LENDING_POOL_ABI = [
  'function treasury() view returns (address)',
  'function globalPaused() view returns (bool)',
  'function implementationStatus() view returns (string)',
  'function supportedAssetCount() view returns (uint256)',
  'function supportedAssetAt(uint256 index) view returns (address)',
  'function getReserveConfig(address asset) view returns (tuple(bool supported, bool collateralEnabled, bool borrowEnabled, bool paused, uint8 decimals, uint16 collateralFactorBps, uint16 liquidationThresholdBps, uint16 liquidationBonusBps, uint16 reserveFactorBps, uint128 supplyCap, uint128 borrowCap))',
  'function getReserveState(address asset) view returns (tuple(uint128 totalSupplied, uint128 totalBorrowed, uint128 supplyIndexRay, uint128 borrowIndexRay, uint64 lastAccrualTimestamp))',
  'function getUserPosition(address account, address asset) view returns (tuple(uint128 suppliedPrincipal, uint128 borrowPrincipal, bool useAsCollateral))',
  'function previewAccountLiquidity(address account) view returns (uint256 collateralValueUsd18, uint256 borrowValueUsd18, uint256 availableBorrowUsd18)',
  'function supply(address asset, uint256 amount, address onBehalfOf)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, address to)',
  'function repay(address asset, uint256 amount, address onBehalfOf) returns (uint256)',
  'function liquidate(address borrower, address debtAsset, uint256 repayAmount, address collateralAsset)',
];

const SUPPORTED_LENDING_ASSETS = {
  USDC: {
    symbol: 'USDC',
    address: process.env.USDC_ADDRESS_ARC || process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
    decimals: 6,
  },
  EURC: {
    symbol: 'EURC',
    address: process.env.EURC_ADDRESS_ARC || process.env.EURC_ADDRESS || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals: 6,
  },
};

const RESERVE_SNAPSHOT_CACHE_TTL_MS = (() => {
  const numeric = Number(process.env.ARC_LENDING_RESERVE_CACHE_TTL_MS || '5000');
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 5000;
})();

let reserveSnapshotCache = {
  contractAddress: null,
  expiresAt: 0,
  value: null,
  inflight: null,
};

function getArcRpcUrl() {
  return process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
}

function getArcLendingPoolAddress() {
  return process.env.ARC_LENDING_POOL_ADDRESS || null;
}

function getSupportedAssetList() {
  return Object.values(SUPPORTED_LENDING_ASSETS).map(asset => ({ ...asset }));
}

function getNativeLendingContract(signerOrProvider) {
  const address = getArcLendingPoolAddress();
  if (!address) throw new Error('ARC_LENDING_POOL_ADDRESS is not configured');
  return new ethers.Contract(address, ARC_LENDING_POOL_ABI, signerOrProvider);
}

function getReadProvider() {
  return new ethers.JsonRpcProvider(getArcRpcUrl());
}

function resolveLendingAsset(asset) {
  const normalized = String(asset || '').trim();
  const bySymbol = SUPPORTED_LENDING_ASSETS[normalized.toUpperCase()];
  if (bySymbol) return bySymbol;

  return getSupportedAssetList().find(entry => entry.address.toLowerCase() === normalized.toLowerCase()) || null;
}

function formatUnits(value, decimals) {
  try {
    return ethers.formatUnits(value, decimals);
  } catch {
    return null;
  }
}

async function approveIfNeeded(tokenAddress, signer, spender, amountRaw, txSecurity = {}) {
  const token = new ethers.Contract(tokenAddress, ERC20_APPROVE_ABI, signer);
  const allowance = await token.allowance(signer.address, spender);
  if (allowance < amountRaw) {
    await sendProtectedContractTx({
      contract: token,
      methodName: 'approve',
      args: [spender, amountRaw],
      chainName: 'Arc Testnet',
      walletAddress: txSecurity.walletAddress || signer.address,
      agentId: txSecurity.agentId || null,
      operation: txSecurity.operation || 'native_lending_approve',
      replayFingerprint: txSecurity.replayFingerprint || [tokenAddress, spender, amountRaw.toString()],
    });
  }
}

async function readConfiguredReserveSnapshots(contract) {
  const contractAddress = getArcLendingPoolAddress();
  const now = Date.now();

  if (
    reserveSnapshotCache.contractAddress === contractAddress
    && reserveSnapshotCache.value
    && reserveSnapshotCache.expiresAt > now
  ) {
    return reserveSnapshotCache.value;
  }

  if (
    reserveSnapshotCache.contractAddress === contractAddress
    && reserveSnapshotCache.inflight
  ) {
    return reserveSnapshotCache.inflight;
  }

  const loadPromise = (async () => {
  const count = Number(await contract.supportedAssetCount());
  const reserves = [];

  for (let index = 0; index < count; index += 1) {
    const assetAddress = await contract.supportedAssetAt(index);
    const knownAsset = resolveLendingAsset(assetAddress);
    const config = await contract.getReserveConfig(assetAddress);
    const state = await contract.getReserveState(assetAddress);
    const decimals = Number(config.decimals || knownAsset?.decimals || 18);

    reserves.push({
      symbol: knownAsset?.symbol || assetAddress,
      assetAddress,
      decimals,
      collateralEnabled: Boolean(config.collateralEnabled),
      borrowEnabled: Boolean(config.borrowEnabled),
      paused: Boolean(config.paused),
      collateralFactorBps: Number(config.collateralFactorBps || 0),
      liquidationThresholdBps: Number(config.liquidationThresholdBps || 0),
      liquidationBonusBps: Number(config.liquidationBonusBps || 0),
      reserveFactorBps: Number(config.reserveFactorBps || 0),
      supplyCap: formatUnits(config.supplyCap, decimals),
      borrowCap: formatUnits(config.borrowCap, decimals),
      totalSupplied: formatUnits(state.totalSupplied, decimals),
      totalBorrowed: formatUnits(state.totalBorrowed, decimals),
      supplyIndexRay: state.supplyIndexRay?.toString?.() || String(state.supplyIndexRay || '0'),
      borrowIndexRay: state.borrowIndexRay?.toString?.() || String(state.borrowIndexRay || '0'),
      lastAccrualTimestamp: Number(state.lastAccrualTimestamp || 0),
    });
  }

  return reserves;
  })();

  reserveSnapshotCache = {
    contractAddress,
    expiresAt: reserveSnapshotCache.expiresAt,
    value: reserveSnapshotCache.value,
    inflight: loadPromise,
  };

  try {
    const reserves = await loadPromise;
    reserveSnapshotCache = {
      contractAddress,
      expiresAt: Date.now() + RESERVE_SNAPSHOT_CACHE_TTL_MS,
      value: reserves,
      inflight: null,
    };
    return reserves;
  } catch (error) {
    reserveSnapshotCache = {
      contractAddress,
      expiresAt: 0,
      value: null,
      inflight: null,
    };
    throw error;
  }
}

async function getNativeLendingOverview() {
  const contractAddress = getArcLendingPoolAddress();
  if (!contractAddress) {
    return {
      source: 'arc_native_scaffold',
      live: false,
      contractAddress: null,
      buildState: 'scaffold_only',
      actions: ['supply', 'withdraw', 'borrow', 'repay', 'deleverage', 'liquidate'],
      supportedAssets: getSupportedAssetList(),
      notes: [
        'Arc-native lending is being built as an isolated stable lane.',
        'USDC and EURC are the only planned v1 assets.',
        'No live lending contract address is configured yet.',
      ],
    };
  }

  const provider = getReadProvider();
  const contract = getNativeLendingContract(provider);
  const [treasury, globalPaused, buildState, reserves] = await Promise.all([
    contract.treasury(),
    contract.globalPaused(),
    contract.implementationStatus(),
    readConfiguredReserveSnapshots(contract),
  ]);

  return {
    source: 'arc_native_lending_contract',
    live: buildState !== 'scaffold_only',
    contractAddress,
    treasury,
    globalPaused,
    buildState,
    actions: ['supply', 'withdraw', 'borrow', 'repay', 'deleverage', 'liquidate'],
    reserves,
  };
}

async function getNativeLendingAccountOverview(account) {
  const contractAddress = getArcLendingPoolAddress();
  if (!contractAddress) {
    return {
      source: 'arc_native_scaffold',
      live: false,
      contractAddress: null,
      account,
      liquidity: null,
      positions: [],
    };
  }

  const provider = getReadProvider();
  const contract = getNativeLendingContract(provider);
  const reserves = await readConfiguredReserveSnapshots(contract);
  const liquidity = await contract.previewAccountLiquidity(account);
  const positions = await Promise.all(reserves.map(async reserve => {
    const position = await contract.getUserPosition(account, reserve.assetAddress);
    return {
      symbol: reserve.symbol,
      assetAddress: reserve.assetAddress,
      suppliedPrincipal: formatUnits(position.suppliedPrincipal, reserve.decimals),
      borrowPrincipal: formatUnits(position.borrowPrincipal, reserve.decimals),
      useAsCollateral: Boolean(position.useAsCollateral),
    };
  }));

  return {
    source: 'arc_native_lending_contract',
    live: true,
    contractAddress,
    account,
    liquidity: {
      collateralValueUsd18: ethers.formatUnits(liquidity.collateralValueUsd18, 18),
      borrowValueUsd18: ethers.formatUnits(liquidity.borrowValueUsd18, 18),
      availableBorrowUsd18: ethers.formatUnits(liquidity.availableBorrowUsd18, 18),
    },
    positions,
  };
}

async function executeNativeLendingSupply({ assetAddress, amount, agentPrivateKey, onBehalfOf, decimals }) {
  const asset = resolveLendingAsset(assetAddress);
  if (!asset) throw new Error('Unsupported native lending asset');
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider = getReadProvider();
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const contract = getNativeLendingContract(signer);
  const amountRaw = ethers.parseUnits(String(amount), Number(decimals || asset.decimals));
  await approveIfNeeded(asset.address, signer, await contract.getAddress(), amountRaw, {
    operation: 'native_lending_supply_approve',
    replayFingerprint: [asset.address, amountRaw.toString()],
  });
  const { receipt } = await sendProtectedContractTx({
    contract,
    methodName: 'supply',
    args: [asset.address, amountRaw, onBehalfOf || signer.address],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'native_lending_supply',
    replayFingerprint: [asset.address, amountRaw.toString(), onBehalfOf || signer.address],
  });
  return { txHash: receipt.hash };
}

async function executeNativeLendingWithdraw({ assetAddress, amount, agentPrivateKey, to, decimals }) {
  const asset = resolveLendingAsset(assetAddress);
  if (!asset) throw new Error('Unsupported native lending asset');
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider = getReadProvider();
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const contract = getNativeLendingContract(signer);
  const amountRaw = ethers.parseUnits(String(amount), Number(decimals || asset.decimals));
  const { receipt } = await sendProtectedContractTx({
    contract,
    methodName: 'withdraw',
    args: [asset.address, amountRaw, to || signer.address],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'native_lending_withdraw',
    replayFingerprint: [asset.address, amountRaw.toString(), to || signer.address],
  });
  return { txHash: receipt.hash, amountWithdrawn: String(amount) };
}

async function executeNativeLendingBorrow({ assetAddress, amount, agentPrivateKey, to, decimals }) {
  const asset = resolveLendingAsset(assetAddress);
  if (!asset) throw new Error('Unsupported native lending asset');
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider = getReadProvider();
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const contract = getNativeLendingContract(signer);
  const amountRaw = ethers.parseUnits(String(amount), Number(decimals || asset.decimals));
  const { receipt } = await sendProtectedContractTx({
    contract,
    methodName: 'borrow',
    args: [asset.address, amountRaw, to || signer.address],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'native_lending_borrow',
    replayFingerprint: [asset.address, amountRaw.toString(), to || signer.address],
  });
  return { txHash: receipt.hash };
}

async function executeNativeLendingRepay({ assetAddress, amount, agentPrivateKey, onBehalfOf, decimals }) {
  const asset = resolveLendingAsset(assetAddress);
  if (!asset) throw new Error('Unsupported native lending asset');
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');

  const provider = getReadProvider();
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const contract = getNativeLendingContract(signer);
  const amountRaw = ethers.parseUnits(String(amount), Number(decimals || asset.decimals));
  await approveIfNeeded(asset.address, signer, await contract.getAddress(), amountRaw, {
    operation: 'native_lending_repay_approve',
    replayFingerprint: [asset.address, amountRaw.toString(), onBehalfOf || signer.address],
  });
  const { receipt } = await sendProtectedContractTx({
    contract,
    methodName: 'repay',
    args: [asset.address, amountRaw, onBehalfOf || signer.address],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'native_lending_repay',
    replayFingerprint: [asset.address, amountRaw.toString(), onBehalfOf || signer.address],
  });
  return { txHash: receipt.hash, amountRepaid: String(amount) };
}

async function executeNativeLendingLiquidation({ borrower, debtAssetAddress, collateralAssetAddress, amount, agentPrivateKey, debtAssetDecimals }) {
  const debtAsset = resolveLendingAsset(debtAssetAddress);
  const collateralAsset = resolveLendingAsset(collateralAssetAddress);
  if (!debtAsset) throw new Error('Unsupported native lending debt asset');
  if (!collateralAsset) throw new Error('Unsupported native lending collateral asset');
  if (!agentPrivateKey) throw new Error('agentPrivateKey is required');
  if (!borrower) throw new Error('borrower is required');

  const provider = getReadProvider();
  const signer = new ethers.Wallet(agentPrivateKey, provider);
  const contract = getNativeLendingContract(signer);
  const amountRaw = ethers.parseUnits(String(amount), Number(debtAssetDecimals || debtAsset.decimals));
  await approveIfNeeded(debtAsset.address, signer, await contract.getAddress(), amountRaw, {
    operation: 'native_lending_liquidation_approve',
    replayFingerprint: [debtAsset.address, amountRaw.toString(), borrower],
  });
  const { receipt } = await sendProtectedContractTx({
    contract,
    methodName: 'liquidate',
    args: [borrower, debtAsset.address, amountRaw, collateralAsset.address],
    chainName: 'Arc Testnet',
    walletAddress: signer.address,
    operation: 'native_lending_liquidation',
    replayFingerprint: [borrower, debtAsset.address, collateralAsset.address, amountRaw.toString()],
  });
  return {
    txHash: receipt.hash,
    amountLiquidated: String(amount),
  };
}

module.exports = {
  getArcLendingPoolAddress,
  getNativeLendingOverview,
  getNativeLendingAccountOverview,
  executeNativeLendingLiquidation,
  executeNativeLendingSupply,
  executeNativeLendingWithdraw,
  executeNativeLendingBorrow,
  executeNativeLendingRepay,
  SUPPORTED_LENDING_ASSETS,
};