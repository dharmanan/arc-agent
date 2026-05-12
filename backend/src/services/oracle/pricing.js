'use strict';
/**
 * Oracle-as-a-Service — per-request price table (x402 nanopayment model).
 * External agents pay per call; no account or subscription needed.
 * Amounts are in USDC (string to avoid float precision issues).
 */

const ORACLE_PRICES = {
  'stablecoin-fx': '0.001',
  'pool-state':    '0.001',
  'yield-rank':    '0.002',
  'arb-signal':    '0.005',
};

/**
 * Returns the USDC price for the given oracle endpoint key.
 * @param {string} endpointKey  e.g. 'stablecoin-fx'
 * @returns {string|null}  USDC amount as string, or null if unknown
 */
function getPrice(endpointKey) {
  return ORACLE_PRICES[endpointKey] ?? null;
}

module.exports = { ORACLE_PRICES, getPrice };
