'use strict';
/**
 * Protocol adapters — ARC Testnet
 * Barrel export for all on-chain protocol interactions.
 */
const curveSwap  = require('./curveSwap');
const constantProductSwap = require('./constantProductSwap');
const aaveSupply = require('./aaveSupply');
const nativeLending = require('./nativeLending');

module.exports = {
  // Curve Finance
  getCurveQuote: curveSwap.getCurveQuote,
  executeCurveSwap: curveSwap.executeCurveSwap,
  executeCurveAddLiquidity: curveSwap.executeCurveAddLiquidity,
  executeCurveAddLiquidityBalanced: curveSwap.executeCurveAddLiquidityBalanced,
  executeCurveRemoveLiquidity: curveSwap.executeCurveRemoveLiquidity,
  executeCurveRemoveLiquidityOneCoin: curveSwap.executeCurveRemoveLiquidityOneCoin,
  buildCurveRemoveLiquidityOneCoinPreflight: curveSwap.buildCurveRemoveLiquidityOneCoinPreflight,

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

  // Arc-native Lending
  getNativeLendingOverview: nativeLending.getNativeLendingOverview,
  getNativeLendingAccountOverview: nativeLending.getNativeLendingAccountOverview,
  executeNativeLendingLiquidation: nativeLending.executeNativeLendingLiquidation,
  executeNativeLendingSupply: nativeLending.executeNativeLendingSupply,
  executeNativeLendingWithdraw: nativeLending.executeNativeLendingWithdraw,
  executeNativeLendingBorrow: nativeLending.executeNativeLendingBorrow,
  executeNativeLendingRepay: nativeLending.executeNativeLendingRepay,
};
