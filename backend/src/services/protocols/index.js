'use strict';
/**
 * Protocol adapters — ARC Testnet
 * Barrel export for all on-chain protocol interactions.
 */
const curveSwap  = require('./curveSwap');
const constantProductSwap = require('./constantProductSwap');
const aaveSupply = require('./aaveSupply');

module.exports = {
  // Curve Finance
  getCurveQuote: curveSwap.getCurveQuote,
  executeCurveSwap: curveSwap.executeCurveSwap,
  executeCurveAddLiquidity: curveSwap.executeCurveAddLiquidity,
  executeCurveRemoveLiquidityOneCoin: curveSwap.executeCurveRemoveLiquidityOneCoin,

  // V2-style constant-product pools
  getConstantProductQuote: constantProductSwap.getConstantProductQuote,
  executeConstantProductAddLiquidity: constantProductSwap.executeConstantProductAddLiquidity,
  executeConstantProductRemoveLiquidity: constantProductSwap.executeConstantProductRemoveLiquidity,
  executeConstantProductSwap: constantProductSwap.executeConstantProductSwap,
  executeConstantProductZapIn: constantProductSwap.executeConstantProductZapIn,

  // Aave V3
  getAaveApy:          aaveSupply.getAaveApy,
  executeAaveSupply:   aaveSupply.executeAaveSupply,
  executeAaveWithdraw: aaveSupply.executeAaveWithdraw,
};
