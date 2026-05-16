'use strict';

const DEFAULT_REVENUE_POOL_ADDRESS = '0x7E84fFFAA5f0524CD55b13B6AEC7eE0785c07e5e';

function getRevenuePoolAddress() {
  return process.env.REVENUE_POOL_ADDRESS || DEFAULT_REVENUE_POOL_ADDRESS;
}

function getRevenuePoolSource() {
  return process.env.REVENUE_POOL_ADDRESS ? 'env' : 'verified_default';
}

module.exports = {
  DEFAULT_REVENUE_POOL_ADDRESS,
  getRevenuePoolAddress,
  getRevenuePoolSource,
};