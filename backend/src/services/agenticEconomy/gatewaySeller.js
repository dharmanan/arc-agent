'use strict';

const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { GatewayEvmScheme } = require('@circle-fin/x402-batching/server');
const { getGatewayConfig, getGatewayConfigSummary } = require('./gatewayConfig');
const { getGatewayFacilitatorClient } = require('./gatewayFacilitator');

function assertSellerAddress(address) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || '')) {
    throw new Error('A valid sellerAddress is required for Circle Gateway x402 routes');
  }
}

function createPaymentOptions({ sellerAddress, price, networks, maxTimeoutSeconds = 60 }) {
  assertSellerAddress(sellerAddress);

  return networks.map(network => ({
    scheme: 'exact',
    payTo: sellerAddress,
    price,
    network,
    maxTimeoutSeconds,
  }));
}

function createGatewayRouteConfig({
  sellerAddress,
  price,
  description,
  resource,
  mimeType = 'application/json',
  unpaidResponseBody,
  settlementFailedResponseBody,
  extensions,
  maxTimeoutSeconds,
  networks,
}) {
  const gatewayConfig = getGatewayConfig();
  const scopedNetworks = Array.isArray(networks) && networks.length > 0
    ? networks
    : gatewayConfig.networks;

  return {
    accepts: createPaymentOptions({
      sellerAddress,
      price,
      networks: scopedNetworks,
      maxTimeoutSeconds,
    }),
    description,
    resource,
    mimeType,
    unpaidResponseBody,
    settlementFailedResponseBody,
    extensions,
  };
}

function createGatewayResourceServer(options = {}) {
  const gatewayConfig = getGatewayConfig();
  const networks = Array.isArray(options.networks) && options.networks.length > 0
    ? options.networks
    : gatewayConfig.networks;

  const server = new x402ResourceServer(getGatewayFacilitatorClient());
  for (const network of networks) {
    server.register(network, new GatewayEvmScheme());
  }

  return server;
}

function createGatewaySellerMiddleware(routes, options = {}) {
  const server = createGatewayResourceServer({ networks: options.networks });

  return paymentMiddleware(
    routes,
    server,
    options.paywallConfig,
    options.paywall,
    options.syncFacilitatorOnStart !== false,
  );
}

function getGatewaySellerSummary() {
  return {
    ...getGatewayConfigSummary(),
    mode: 'gateway-seller',
  };
}

module.exports = {
  createGatewayRouteConfig,
  createGatewaySellerMiddleware,
  createGatewayResourceServer,
  createPaymentOptions,
  getGatewaySellerSummary,
};