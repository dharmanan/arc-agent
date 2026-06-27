'use strict';

const { ethers } = require('ethers');

const ARC_TESTNET_NETWORK = Object.freeze({
  chainId: 5042002,
  name: 'Arc Testnet',
});
const ARC_TESTNET_STATIC_NETWORK = ethers.Network.from(ARC_TESTNET_NETWORK);

const providerCache = new Map();

function getArcRpcUrl() {
  return process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
}

function normalizeRpcUrl(rpcUrl = getArcRpcUrl()) {
  return String(rpcUrl || '').trim() || getArcRpcUrl();
}

function createArcRpcProvider(rpcUrl = getArcRpcUrl()) {
  const normalizedRpcUrl = normalizeRpcUrl(rpcUrl);
  let provider = providerCache.get(normalizedRpcUrl);
  if (!provider) {
    provider = new ethers.JsonRpcProvider(
      normalizedRpcUrl,
      ARC_TESTNET_NETWORK,
      { staticNetwork: ARC_TESTNET_STATIC_NETWORK },
    );
    providerCache.set(normalizedRpcUrl, provider);
  }
  return provider;
}

function clearArcRpcProviderCache() {
  providerCache.clear();
}

module.exports = {
  ARC_TESTNET_NETWORK,
  createArcRpcProvider,
  getArcRpcUrl,
  clearArcRpcProviderCache,
};
