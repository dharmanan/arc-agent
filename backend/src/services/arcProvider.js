'use strict';

const { ethers } = require('ethers');

const ARC_TESTNET_NETWORK = Object.freeze({
  chainId: 5042002,
  name: 'Arc Testnet',
});
const ARC_TESTNET_STATIC_NETWORK = ethers.Network.from(ARC_TESTNET_NETWORK);

function getArcRpcUrl() {
  return process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || 'https://rpc.testnet.arc.network';
}

function createArcRpcProvider(rpcUrl = getArcRpcUrl()) {
  return new ethers.JsonRpcProvider(
    rpcUrl,
    ARC_TESTNET_NETWORK,
    { staticNetwork: ARC_TESTNET_STATIC_NETWORK },
  );
}

module.exports = {
  ARC_TESTNET_NETWORK,
  createArcRpcProvider,
  getArcRpcUrl,
};