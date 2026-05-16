import React, { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { useAgent } from '../providers/AgentProvider';
import { agents, transactions } from '../lib/api.js';
import { authenticatePasskey } from '../lib/passkey.js';
import { fetchAgentPortfolio } from '../lib/agentBalances.js';
import { Card, Badge, Button, AddressBox, Alert, Spinner } from './ui/index.jsx';
import PaymentModal from './PaymentModal.jsx';
import { Wallet, Activity, ArrowRight, ArrowUpRight, ArrowDownLeft, Repeat2, Zap, LogIn, ExternalLink, RefreshCw, QrCode, Send } from 'lucide-react';
import { CHAINS } from '../lib/chains.js';

function formatAddress(address, startChars = 8, endChars = 6) {
  if (!address || address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}....${address.slice(-endChars)}`;
}

function getTxMeta(tx) {
  return tx?.meta && typeof tx.meta === 'object' ? tx.meta : {};
}

function isRealHash(hash) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash || '');
}

function formatTokenAmount(amount, token) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const digits = token === 'cirBTC' ? 8 : 4;
  return `${numeric.toFixed(digits).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')} ${token}`;
}

function formatTokenAmountWithZero(amount, token) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  if (numeric === 0) return `0 ${token}`;
  return formatTokenAmount(numeric, token);
}

function summarizeActivityError(error) {
  const raw = String(error || '').trim();
  if (!raw) return null;

  if (/nonce too low|nonce has already been used|NONCE_EXPIRED/i.test(raw)) {
    return 'Another transaction already used this wallet nonce before this swap was submitted.';
  }

  if (/ERC20:\s*transfer amount exceeds balance/i.test(raw)) {
    return 'Agent wallet balance was too low for this trade.';
  }

  if ((/transaction execution reverted/i.test(raw) || /CALL_EXCEPTION/i.test(raw)) && /reason=null/i.test(raw)) {
    return 'The on-chain swap reverted, but the RPC node did not return a decoded contract reason.';
  }

  if (/exceeds agent auto-approve limit/i.test(raw)) {
    return 'Trade size was above the current auto-approve limit.';
  }

  if (/Daily limit exceeded/i.test(raw)) {
    return 'Daily spend limit blocked this autonomous trade.';
  }

  const compact = raw.replace(/\s+/g, ' ').trim();
  const quotedReason = compact.match(/reason[=:]\s*["']([^"']+)["']/i)?.[1];
  const primary = quotedReason || compact.split(' (action=')[0] || compact;

  return primary.length > 180 ? `${primary.slice(0, 177)}...` : primary;
}

function getOracleStrategyFailureContext(meta, inputToken) {
  const attemptedAmount = Number(meta.amountIn);
  const requestedAmount = Number(meta.requestedAmountIn);
  const availableAmount = Number(meta.availableBalanceUsdc);
  const tradableAmount = Number(meta.availableToTradeUsdc);
  const reservedAmount = Number(meta.walletReserveUsdc);
  const attemptedAmountLabel = formatTokenAmountWithZero(meta.amountIn, inputToken);
  const requestedAmountLabel = formatTokenAmount(meta.requestedAmountIn, inputToken);
  const availableAmountLabel = formatTokenAmountWithZero(meta.availableBalanceUsdc, inputToken);
  const tradableAmountLabel = formatTokenAmountWithZero(meta.availableToTradeUsdc, inputToken);
  const reservedAmountLabel = formatTokenAmountWithZero(meta.walletReserveUsdc, inputToken);

  if (/nonce too low|nonce has already been used|NONCE_EXPIRED/i.test(String(meta.error || ''))) {
    return attemptedAmountLabel
      ? ` The failed on-chain attempt size was ${attemptedAmountLabel}.`
      : '';
  }

  if (
    Number.isFinite(requestedAmount)
    && Number.isFinite(attemptedAmount)
    && Number.isFinite(tradableAmount)
    && requestedAmount > attemptedAmount
    && Math.abs(tradableAmount - attemptedAmount) < 0.000001
    && /transaction execution reverted|CALL_EXCEPTION/i.test(String(meta.error || ''))
  ) {
    if (Number.isFinite(reservedAmount) && reservedAmount > 0) {
      return ` The loop had already reduced the trade from ${requestedAmountLabel || `${requestedAmount} ${inputToken}`} to ${attemptedAmountLabel || `${attemptedAmount} ${inputToken}`} based on the wallet's tradable balance (${tradableAmountLabel || `${tradableAmount} ${inputToken}`}) after keeping ${reservedAmountLabel || `${reservedAmount} ${inputToken}`} reserved, so this was not blocked by the pre-trade balance guard.`;
    }

    return ` The loop had already reduced the trade from ${requestedAmountLabel || `${requestedAmount} ${inputToken}`} to ${attemptedAmountLabel || `${attemptedAmount} ${inputToken}`} based on the wallet's available balance (${availableAmountLabel || `${availableAmount} ${inputToken}`}), so this was not blocked by the pre-trade balance guard.`;
  }

  return attemptedAmountLabel
    ? ` The failed on-chain attempt size was ${attemptedAmountLabel}.`
    : '';
}

function formatPositionAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '0';
  if (Math.abs(numeric) < 0.000001) return numeric.toExponential(6);
  if (Math.abs(numeric) < 0.01) return numeric.toFixed(10).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
  return numeric.toFixed(6).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function formatLpAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric === 0) return '0';
  if (Math.abs(numeric) < 0.001) return '<0.001';
  return numeric.toFixed(3).replace(/\.0+$|(?<=\.\d*?)0+$/g, '');
}

function formatPositionVenue(position) {
  const chain = position?.chain || 'Arc Testnet';
  const protocol = String(position?.protocol || '').toLowerCase();
  const poolModel = String(position?.poolModel || '').toLowerCase();

  let venueLabel = 'Liquidity pool';
  if (protocol === 'curve') {
    venueLabel = 'Curve stable pool';
  } else if (protocol === 'uniswap_v2_like' && poolModel === 'constant_product') {
    venueLabel = 'Direct liquidity pool';
  } else if (protocol === 'uniswap_v2_like') {
    venueLabel = 'Direct swap pool';
  }

  return `${chain} · ${venueLabel}`;
}

function getExplorerTxUrl(chainName, txHash) {
  const explorerBase = CHAINS[chainName]?.explorerUrl;
  if (!explorerBase || !isRealHash(txHash)) return null;
  return `${explorerBase}/tx/${txHash}`;
}

function getOracleStrategyLabel(meta) {
  return meta.signal?.strategy === 'stablecoin_fx'
    ? 'EURC/USDC oracle strategy'
    : 'Oracle strategy';
}

function getOracleSignalKey(meta) {
  const timestamp = meta.signal?.timestamp;
  if (!timestamp) return null;

  return [
    meta.signal?.strategy || 'oracle',
    timestamp,
    Number(meta.signal?.opportunity?.amountUsdc || 0),
  ].join(':');
}

function getOracleSignalFollowUp(tx, allTxs) {
  const signalKey = getOracleSignalKey(getTxMeta(tx));
  if (!signalKey) return null;

  return allTxs.find(candidate => {
    if (!['defi_loop_swap', 'defi_loop_dry'].includes(candidate?.type)) return false;
    return getOracleSignalKey(getTxMeta(candidate)) === signalKey;
  }) || null;
}

function getTxDisplay(tx, { allTxs = [], agentStatus = null } = {}) {
  const meta = getTxMeta(tx);
  const isOracleSignal = tx.type === 'oracle_signal';
  const isOracleStrategyExecution = tx.type === 'defi_loop_swap';
  const isOracleStrategyDryRun = tx.type === 'defi_loop_dry';
  const isSwap = tx.type === 'swap';
  const isDirectLpAdd = tx.type === 'direct_lp_add';
  const isDirectLpRemove = tx.type === 'direct_lp_remove';
  const isCurveLpAdd = tx.type === 'curve_lp_add';
  const isCurveLpRemove = tx.type === 'curve_lp_remove';
  const isTaskArb = tx.type === 'task_arb';
  const isRebalance = tx.type === 'rebalance';
  const isGasFanout = tx.type === 'gas_topup' && Array.isArray(meta.targets) && meta.targets.length > 0;

  if (isOracleSignal) {
    const strategy = meta.signal?.strategy === 'stablecoin_fx'
      ? 'EURC/USDC oracle signal'
      : 'Oracle signal';
    const isDailyCapReached = meta.executionState === 'daily_cap_reached';
    const followUpTx = getOracleSignalFollowUp(tx, allTxs);
    const signalCreatedAtMs = Date.parse(tx.created_at || meta.signal?.timestamp || '');
    const lastDefiRunAtMs = Date.parse(agentStatus?.automation?.defiLoop?.lastRunAt || '');

    let signalReason = meta.signalOnlyReason
      || (meta.executionPermissionGranted
        ? 'Autonomous execution is enabled, but this row is only the oracle snapshot. A separate oracle strategy row appears only when the DeFi loop records a result for this exact signal.'
        : 'Signal only — this agent does not currently have permission to auto-execute oracle strategies.');

    if (followUpTx) {
      const followUpMeta = getTxMeta(followUpTx);
      if (followUpMeta.executionState === 'daily_cap_reached') {
        signalReason = `This signal later hit the daily DeFi loop cap at ${Number(followUpMeta.dailyCapCount || 0)}/${Number(followUpMeta.dailyCap || 10)}. See the matching oracle strategy hold row.`;
      } else if (followUpMeta.executionState === 'insufficient_balance') {
        const tradableAmountLabel = formatTokenAmountWithZero(followUpMeta.availableToTradeUsdc, 'USDC');
        const reservedAmountLabel = formatTokenAmountWithZero(followUpMeta.walletReserveUsdc, 'USDC');
        signalReason = tradableAmountLabel && reservedAmountLabel && Number(followUpMeta.walletReserveUsdc) > 0
          ? `This signal later reached the DeFi loop, but only ${tradableAmountLabel} was tradable after keeping ${reservedAmountLabel} reserved in the agent wallet. See the matching oracle strategy hold row.`
          : 'This signal later reached the DeFi loop, but the agent wallet did not have enough balance. See the matching oracle strategy hold row.';
      } else if (followUpTx.status === 'confirmed') {
        signalReason = 'This signal later produced the executed oracle strategy row below.';
      } else if (followUpTx.status === 'failed') {
        signalReason = 'This signal later produced a failed oracle strategy row below.';
      } else {
        signalReason = 'This signal later produced a separate DeFi loop result row below.';
      }
    } else if (meta.executionPermissionGranted) {
      signalReason = Number.isFinite(signalCreatedAtMs) && Number.isFinite(lastDefiRunAtMs) && lastDefiRunAtMs < signalCreatedAtMs
        ? 'Autonomous execution was approved, but the latest recorded DeFi loop run happened before this signal arrived. No execution result has been recorded for this exact opportunity yet.'
        : 'Autonomous execution was approved for this signal, but no separate DeFi loop result was recorded for this exact opportunity.';
    }

    return {
      title: isDailyCapReached ? 'oracle opportunity not executed' : 'oracle opportunity',
      routeLabel: `Arc Testnet · ${strategy}`,
      amountLabel: Number(tx.amount_usdc) > 0
        ? `${parseFloat(tx.amount_usdc).toFixed(2)} ${tx.token || 'USDC'}`
        : null,
      phase: signalReason,
      links: [],
    };
  }

  if (isOracleStrategyExecution || isOracleStrategyDryRun) {
    const inputToken = meta.fromToken || 'USDC';
    const outputToken = meta.toToken || tx.token || 'EURC';
    const inputAmountLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, inputToken);
    const outputAmountLabel = formatTokenAmount(meta.amountOut, outputToken);
    const requestedAmountLabel = formatTokenAmountWithZero(meta.requestedAmountIn, inputToken);
    const availableBalanceLabel = formatTokenAmountWithZero(meta.availableBalanceUsdc, inputToken);
    const tradableBalanceLabel = formatTokenAmountWithZero(meta.availableToTradeUsdc, inputToken);
    const reservedBalanceLabel = formatTokenAmountWithZero(meta.walletReserveUsdc, inputToken);
    const summarizedError = summarizeActivityError(meta.error);
    const txHash = tx.tx_hash || tx.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);

    let phase = null;
    if (meta.executionState === 'daily_cap_reached') {
      phase = `Autonomous execution did not run because this agent already used ${Number(meta.dailyCapCount || 0)}/${Number(meta.dailyCap || 10)} daily DeFi loop runs. No on-chain trade was submitted.`;
    } else if (meta.executionState === 'insufficient_balance') {
      phase = tradableBalanceLabel && reservedBalanceLabel && Number(meta.walletReserveUsdc) > 0
        ? `Skipped before execution. Requested ${requestedAmountLabel || inputAmountLabel || `1 ${inputToken}`}, the wallet held ${availableBalanceLabel || `0 ${inputToken}`}, but ${reservedBalanceLabel} was kept reserved, leaving ${tradableBalanceLabel} available for autonomous trading. No on-chain trade was submitted.`
        : availableBalanceLabel
        ? `Skipped before execution. Requested ${requestedAmountLabel || inputAmountLabel || `1 ${inputToken}`}, but the agent wallet only had ${availableBalanceLabel}. No on-chain trade was submitted.`
        : 'Skipped before execution because the agent wallet did not have enough balance for this trade.';
    } else if (isOracleStrategyDryRun || meta.executionState === 'dry_run') {
      phase = 'Autonomous execution is enabled, but this run stayed in dry-run mode and did not submit an on-chain trade.';
    } else if (tx.status === 'confirmed') {
      phase = outputAmountLabel
        ? `Executed autonomously — received ${outputAmountLabel}`
        : 'Executed autonomously on-chain';
    } else if (tx.status === 'failed') {
      phase = summarizedError
        ? `Autonomous execution failed: ${summarizedError}${getOracleStrategyFailureContext(meta, inputToken)}`
        : 'Autonomous execution failed before confirmation';
    }

    return {
      title: meta.executionState === 'daily_cap_reached'
        ? 'oracle strategy hold'
        : meta.executionState === 'insufficient_balance'
        ? 'oracle strategy hold'
        : isOracleStrategyDryRun
          ? 'oracle strategy dry run'
          : 'executed oracle strategy',
      routeLabel: `Arc Testnet · ${getOracleStrategyLabel(meta)}`,
      amountLabel: inputAmountLabel || requestedAmountLabel,
      phase,
      links: txUrl
        ? [{
            key: `${tx.id}-oracle-strategy`,
            label: 'Tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
    };
  }

  if (isSwap) {
    const fromToken = meta.fromToken || tx.token || 'USDC';
    const toToken = meta.toToken || 'USDC';
    const inputAmountLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, fromToken);
    const outputAmountLabel = formatTokenAmount(meta.amountOut, toToken);
    const swapTxHash = tx.tx_hash || tx.txHash || null;
    const swapUrl = getExplorerTxUrl('Arc Testnet', swapTxHash);

    return {
      title: 'swap',
      routeLabel: `Arc Testnet · ${fromToken} → ${toToken}`,
      amountLabel: inputAmountLabel,
      phase: outputAmountLabel
        ? `${tx.status === 'confirmed' ? 'Received' : 'Estimated out'}: ${outputAmountLabel}`
        : (tx.status === 'executing' ? 'Awaiting on-chain confirmation' : null),
      links: swapUrl
        ? [{
            key: `${tx.id}-swap`,
            label: 'Tx',
            hash: swapTxHash,
            url: swapUrl,
          }]
        : [],
    };
  }

  if (isDirectLpAdd) {
    const stableToken = meta.stableToken || tx.token || 'USDC';
    const volatileToken = meta.volatileToken || 'cirBTC';
    const amountInLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, stableToken);
    const swappedLabel = meta.swappedAmountIn && meta.amountOut
      ? `${formatTokenAmount(meta.swappedAmountIn, stableToken)} -> ${formatTokenAmount(meta.amountOut, volatileToken)}`
      : null;
    const lpMintedLabel = meta.lpAmount ? `${formatLpAmount(meta.lpAmount)} LP minted` : null;
    const lpUsedLabel = meta.liquidityStableAmountUsed && meta.liquidityVolatileAmountUsed
      ? `LP leg used ${formatTokenAmount(meta.liquidityStableAmountUsed, stableToken)} + ${formatTokenAmount(meta.liquidityVolatileAmountUsed, volatileToken)}`
      : null;
    const leftoverParts = [
      Number(meta.liquidityStableAmountRemaining || 0) > 0 ? formatTokenAmount(meta.liquidityStableAmountRemaining, stableToken) : null,
      Number(meta.liquidityVolatileAmountRemaining || 0) > 0 ? formatTokenAmount(meta.liquidityVolatileAmountRemaining, volatileToken) : null,
    ].filter(Boolean);
    const primaryHash = meta.mintTxHash || tx.tx_hash || null;
    const swapUrl = getExplorerTxUrl('Arc Testnet', meta.swapTxHash);
    const mintUrl = getExplorerTxUrl('Arc Testnet', primaryHash);

    return {
      title: 'direct pair lp add',
      routeLabel: `Arc Testnet · ${stableToken}/${volatileToken} direct pair`,
      amountLabel: amountInLabel,
      phase: swappedLabel
        ? `Swap leg ${swappedLabel}${meta.swapRouteStrategy ? ` via ${meta.swapRouteStrategy}` : ''}. ${lpUsedLabel || lpMintedLabel || 'LP minted.'}${leftoverParts.length > 0 ? ` Wallet kept ${leftoverParts.join(' + ')} unmatched to the pair ratio.` : ''}`
        : (meta.summary || lpMintedLabel || 'Direct-pair LP minted on-chain'),
      links: [
        swapUrl ? {
          key: `${tx.id}-direct-lp-add-swap`,
          label: 'Swap tx',
          hash: meta.swapTxHash,
          url: swapUrl,
        } : null,
        mintUrl ? {
          key: `${tx.id}-direct-lp-add-mint`,
          label: 'Mint tx',
          hash: primaryHash,
          url: mintUrl,
        } : null,
      ].filter(Boolean),
    };
  }

  if (isDirectLpRemove) {
    const stableToken = meta.stableToken || tx.token || 'USDC';
    const volatileToken = meta.volatileToken || 'cirBTC';
    const burnHash = meta.burnTxHash || tx.tx_hash || null;
    const burnUrl = getExplorerTxUrl('Arc Testnet', burnHash);
    const returnedStable = meta.token0Symbol === stableToken
      ? formatTokenAmount(meta.token0Amount, stableToken)
      : meta.token1Symbol === stableToken
        ? formatTokenAmount(meta.token1Amount, stableToken)
        : null;
    const returnedVolatile = meta.token0Symbol === volatileToken
      ? formatTokenAmount(meta.token0Amount, volatileToken)
      : meta.token1Symbol === volatileToken
        ? formatTokenAmount(meta.token1Amount, volatileToken)
        : null;

    return {
      title: 'direct pair lp exit',
      routeLabel: `Arc Testnet · ${stableToken}/${volatileToken} direct pair`,
      amountLabel: meta.lpAmount ? `${formatLpAmount(meta.lpAmount)} LP burned` : null,
      phase: [
        Number(meta.withdrawPct) > 0 ? `Withdrew ${Number(meta.withdrawPct).toFixed(0)}% of the position.` : null,
        returnedStable ? `Returned ${returnedStable}` : null,
        returnedVolatile ? `Returned ${returnedVolatile}` : null,
      ].filter(Boolean).join(' '),
      links: burnUrl ? [{
        key: `${tx.id}-direct-lp-remove-burn`,
        label: 'Burn tx',
        hash: burnHash,
        url: burnUrl,
      }] : [],
    };
  }

  if (isCurveLpAdd) {
    const tokenIn = meta.tokenIn || tx.token || 'USDC';
    const amountInLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, tokenIn);
    const lpMintedLabel = meta.lpAmount ? `${formatLpAmount(meta.lpAmount)} LP minted` : null;
    const txHash = tx.tx_hash || tx.txHash || meta.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);

    return {
      title: 'curve liquidity add',
      routeLabel: `Arc Testnet · ${tokenIn} -> Curve stable pool`,
      amountLabel: amountInLabel,
      phase: tx.status === 'dry_run'
        ? 'Simulation only. No on-chain liquidity add was submitted.'
        : tx.status === 'skipped'
          ? (meta.summary || 'No on-chain liquidity add was submitted.')
          : meta.minLpAmount
            ? `${lpMintedLabel || 'LP minted.'} Minimum protected LP: ${formatLpAmount(meta.minLpAmount)}.`
            : (lpMintedLabel || meta.summary || 'Curve liquidity added on-chain'),
      links: txUrl
        ? [{
            key: `${tx.id}-curve-lp-add`,
            label: 'Add tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
    };
  }

  if (isCurveLpRemove) {
    const tokenOut = meta.tokenOut || tx.token || 'USDC';
    const burnLabel = meta.lpAmount ? `${formatLpAmount(meta.lpAmount)} LP burned` : null;
    const returnedLabel = formatTokenAmount(meta.amountOut, tokenOut);
    const txHash = tx.tx_hash || tx.txHash || meta.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);

    return {
      title: 'curve liquidity remove',
      routeLabel: `Arc Testnet · Curve stable pool -> ${tokenOut}`,
      amountLabel: burnLabel,
      phase: tx.status === 'dry_run'
        ? 'Simulation only. No on-chain liquidity removal was submitted.'
        : tx.status === 'skipped'
          ? (meta.summary || 'No on-chain liquidity removal was submitted.')
          : [
              burnLabel,
              returnedLabel ? `Returned ${returnedLabel}` : null,
              meta.minAmountOut ? `Minimum protected output ${formatTokenAmount(meta.minAmountOut, tokenOut)}` : null,
            ].filter(Boolean).join('. '),
      links: txUrl
        ? [{
            key: `${tx.id}-curve-lp-remove`,
            label: 'Withdraw tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
    };
  }

  if (isTaskArb) {
    const fromToken = meta.fromToken || 'USDC';
    const toToken = meta.toToken || 'EURC';
    const amountLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, fromToken);
    const outputAmountLabel = formatTokenAmount(meta.amountOut, toToken);
    const txHash = meta.swapTxHash || tx.tx_hash || tx.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);

    let phase = meta.summary || null;
    if (tx.status === 'confirmed') {
      phase = outputAmountLabel
        ? `Executed the Curve entry leg and received ${outputAmountLabel}.`
        : 'Executed the Curve entry leg on-chain.';
    } else if (tx.status === 'dry_run') {
      phase = 'Simulation only. No on-chain trade was submitted.';
    }

    return {
      title: 'signal trade',
      routeLabel: `Arc Testnet · ${fromToken} -> ${toToken} Curve entry`,
      amountLabel,
      phase,
      links: txUrl
        ? [{
            key: `${tx.id}-task-arb`,
            label: 'Swap tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
    };
  }

  if (isRebalance) {
    const fromToken = meta.fromToken || tx.token || 'USDC';
    const toToken = meta.toToken || 'EURC';
    const amountLabel = formatTokenAmount(meta.amountIn ?? tx.amount_usdc, fromToken);
    const outputAmountLabel = formatTokenAmount(meta.amountOut, toToken);
    const txHash = tx.tx_hash || tx.txHash || meta.txHash || null;
    const txUrl = getExplorerTxUrl('Arc Testnet', txHash);

    return {
      title: 'rebalance',
      routeLabel: `Arc Testnet · ${fromToken} -> ${toToken}`,
      amountLabel,
      phase: tx.status === 'dry_run'
        ? 'Simulation only. No on-chain rebalance was submitted.'
        : tx.status === 'skipped'
          ? (meta.summary || 'No on-chain rebalance was submitted.')
          : outputAmountLabel
            ? `Received ${outputAmountLabel}${meta.executionRail ? ` via ${getExecutionRailLabel(meta.executionRail)}` : ''}`
            : (meta.summary || 'Portfolio rebalanced on-chain'),
      links: txUrl
        ? [{
            key: `${tx.id}-rebalance`,
            label: 'Swap tx',
            hash: txHash,
            url: txUrl,
          }]
        : [],
    };
  }

  if (isGasFanout) {
    const sourceChain = tx.from_chain || meta.fromChain || 'Sepolia';
    const amountEach = meta.amountEth ? `${Number(meta.amountEth).toFixed(4).replace(/\.0+$|(?<=\.\d*?)0+$/g, '')} ETH each` : null;
    const targetChains = meta.targets.map(target => target.toChain).filter(Boolean);

    return {
      title: 'gas fanout',
      routeLabel: `${sourceChain} -> ${targetChains.join(', ')}`,
      amountLabel: amountEach,
      phase: tx.status === 'dry_run'
        ? 'Simulation only. No on-chain gas top-ups were submitted.'
        : `Confirmed native gas top-ups for ${targetChains.join(', ')}.`,
      links: meta.targets.map((target, index) => {
        const url = getExplorerTxUrl(target.toChain, target.topUpTxHash);
        if (!url) return null;

        return {
          key: `${tx.id}-gas-fanout-${index}`,
          label: `${target.toChain} tx`,
          hash: target.topUpTxHash,
          url,
        };
      }).filter(Boolean),
    };
  }

  const fromChain = tx.from_chain || tx.fromChain || meta.fromChain || '';
  const toChain = tx.to_chain || tx.toChain || meta.toChain || '';
  const bridgeKind = meta.bridgeType || meta.kind || null;
  const isNativeBridge = bridgeKind === 'native'
    || tx.type === 'gas_topup'
    || ['native_gas_topup', 'native_eth_bridge'].includes(meta.kind);
  const token = tx.token || (isNativeBridge ? 'ETH' : 'USDC');
  const isBridge = tx.type === 'bridge' || isNativeBridge;

  const sourceTxHash = meta.sourceTxHash || meta.burnTxHash || meta.topUpTxHash || (isBridge ? tx.tx_hash || tx.txHash : null);
  const destinationTxHash = meta.destinationTxHash || meta.mintTxHash || null;
  const amountValue = token === 'ETH'
    ? meta.amountEth
    : (tx.amount_usdc ?? tx.amountUsdc ?? 0);

  const amountLabel = token === 'ETH'
    ? (amountValue ? `${parseFloat(amountValue).toFixed(4)} ETH` : null)
    : (Number(amountValue) > 0 ? `${parseFloat(amountValue).toFixed(2)} ${token}` : null);

  const routeLabel = fromChain && toChain && fromChain !== toChain
    ? `${fromChain} → ${toChain}`
    : fromChain || toChain || null;
  const sourceLabel = `${isNativeBridge ? 'Source tx' : 'Burn tx'}${fromChain ? ` (${fromChain})` : ''}`;
  const destinationLabel = `${isNativeBridge ? 'Destination tx' : 'Mint tx'}${toChain ? ` (${toChain})` : ''}`;

  let title = tx.type;
  if (isBridge) title = `${token} bridge`;
  else if (tx.type === 'nano_payment') title = 'nano payment';

  let phase = null;
  if (isBridge) {
    if (meta.bridgeCompletionStatus === 'source_submitted' || meta.bridgeStep === 'source_submitted') {
      phase = fromChain ? `Submitting on ${fromChain}` : 'Submitting source bridge';
    } else if (meta.bridgeCompletionStatus === 'destination_pending' || meta.bridgeStep === 'destination_pending') {
      phase = toChain ? `Awaiting ${toChain} receipt` : 'Awaiting destination receipt';
    }
    else if (meta.bridgeStep === 'attesting') phase = 'Awaiting attestation';
    else if (meta.bridgeStep === 'ready_to_mint') phase = 'Ready to mint';
    else if (meta.bridgeCompletionStatus === 'complete' || meta.bridgeStep === 'complete') phase = 'Destination received';
  }

  const links = [
    sourceTxHash && getExplorerTxUrl(fromChain, sourceTxHash)
      ? {
          key: `${tx.id}-source`,
          label: isBridge ? sourceLabel : 'Tx',
          hash: sourceTxHash,
          url: getExplorerTxUrl(fromChain, sourceTxHash),
        }
      : null,
    destinationTxHash && getExplorerTxUrl(toChain, destinationTxHash)
      ? {
          key: `${tx.id}-destination`,
          label: destinationLabel,
          hash: destinationTxHash,
          url: getExplorerTxUrl(toChain, destinationTxHash),
        }
      : null,
    // For send/receive/swap — use tx_hash directly if no bridge links
    (!isBridge && !sourceTxHash && !destinationTxHash && isRealHash(tx.tx_hash || tx.txHash))
      ? {
          key: `${tx.id}-tx`,
          label: 'Tx',
          hash: tx.tx_hash || tx.txHash,
          url: getExplorerTxUrl(fromChain || 'Arc Testnet', tx.tx_hash || tx.txHash),
        }
      : null,
  ].filter(Boolean);

  return { title, routeLabel, amountLabel, phase, links };
}

export default function DashboardTab({ onNavigate }) {
  const { address: ownerAddress } = useAccount();
  const { agent, setAgent, setJwt, isAuthenticated } = useAgent();
  const [portfolio, setPortfolio]         = useState([]);
  const [loadingPortfolio, setLoadingPortfolio] = useState(false);
  const [portfolioError, setPortfolioError] = useState('');
  const [positions, setPositions] = useState([]);
  const [loadingPositions, setLoadingPositions] = useState(false);
  const [positionsError, setPositionsError] = useState('');
  const [positionWarnings, setPositionWarnings] = useState([]);
  const [txs, setTxs]             = useState([]);
  const [loadingTxs, setLoadingTxs] = useState(false);
  const [txError, setTxError]     = useState('');
  const [agentStatus, setAgentStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [paymentMode, setPaymentMode] = useState(null); // 'send' | 'receive' | null
  const agentWalletAddress = agent?.walletAddress || agent?.wallet_address;

  const arcPortfolio = portfolio.find(entry => entry.chainName === 'Arc Testnet');
  const sepoliaPortfolio = portfolio.find(entry => entry.chainName === 'Sepolia');

  function getGasLabel(entry) {
    const symbol = entry?.nativeSymbol || 'ETH';
    return `${symbol} gas`;
  }

  function shouldShowNativeBalance(entry) {
    return entry?.chainName !== 'Arc Testnet';
  }

  async function handleReconnect() {
    if (!ownerAddress) return;
    setConnectError('');
    setConnecting(true);
    try {
      const result = await authenticatePasskey(ownerAddress);
      setJwt(result.token);
      const list = await agents.list();
      if (list.length > 0) setAgent(list[0]);
    } catch (e) {
      setConnectError(e.message);
    } finally {
      setConnecting(false);
    }
  }

  const loadPortfolio = useCallback(async (targetAddress = agentWalletAddress) => {
    if (!targetAddress) return;

    setLoadingPortfolio(true);
    setPortfolioError('');
    try {
      const data = await fetchAgentPortfolio(targetAddress);
      setPortfolio(data);
    } catch (e) {
      setPortfolioError(e.message || 'Failed to load balances');
    } finally {
      setLoadingPortfolio(false);
    }
  }, [agentWalletAddress]);

  const loadPositions = useCallback(async ({ silent = false } = {}) => {
    if (!agent?.id || !isAuthenticated) {
      setPositions([]);
      setPositionWarnings([]);
      return;
    }

    if (!silent) setLoadingPositions(true);
    setPositionsError('');
    try {
      const data = await agents.positions(agent.id);
      setPositions(Array.isArray(data.positions) ? data.positions : []);
      setPositionWarnings(Array.isArray(data.warnings) ? data.warnings : []);
    } catch (e) {
      setPositionsError(e.message || 'Failed to load live protocol positions');
    } finally {
      if (!silent) setLoadingPositions(false);
    }
  }, [agent?.id, isAuthenticated]);

  const loadTransactions = useCallback(async ({ silent = false } = {}) => {
    if (!agent?.id || !isAuthenticated) {
      setTxs([]);
      return;
    }

    if (!silent) setLoadingTxs(true);
    setTxError('');
    try {
      const data = await transactions.list(agent.id);
      setTxs(Array.isArray(data) ? data.slice(0, 20) : []);
    } catch (e) {
      setTxError(e.message || 'Failed to load recent activity');
    } finally {
      if (!silent) setLoadingTxs(false);
    }
  }, [agent?.id, isAuthenticated]);

  const loadAgentStatus = useCallback(async () => {
    if (!agent?.id || !isAuthenticated) {
      setAgentStatus(null);
      return;
    }

    try {
      const data = await agents.status(agent.id);
      setAgentStatus(data || null);
    } catch {
      setAgentStatus(null);
    }
  }, [agent?.id, isAuthenticated]);

  useEffect(() => {
    loadPortfolio(agentWalletAddress);
  }, [agentWalletAddress, loadPortfolio]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  useEffect(() => {
    if (!agentWalletAddress) return;

    const intervalId = setInterval(() => {
      loadPortfolio(agentWalletAddress);
    }, 30_000);

    return () => clearInterval(intervalId);
  }, [agentWalletAddress, loadPortfolio]);

  useEffect(() => {
    if (!agent?.id || !isAuthenticated) return undefined;

    const intervalId = setInterval(() => {
      loadPositions({ silent: true });
    }, 30_000);

    return () => clearInterval(intervalId);
  }, [agent?.id, isAuthenticated, loadPositions]);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  useEffect(() => {
    loadAgentStatus();
  }, [loadAgentStatus]);

  useEffect(() => {
    if (!agent?.id || !isAuthenticated) return undefined;

    const intervalId = setInterval(() => {
      loadTransactions({ silent: true });
    }, 15_000);

    return () => clearInterval(intervalId);
  }, [agent?.id, isAuthenticated, loadTransactions]);

  useEffect(() => {
    if (!agent?.id || !isAuthenticated) return undefined;

    const intervalId = setInterval(() => {
      loadAgentStatus();
    }, 30_000);

    return () => clearInterval(intervalId);
  }, [agent?.id, isAuthenticated, loadAgentStatus]);

  if (!ownerAddress) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-card">
          <Wallet size={28} className="text-slate-400" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-slate-900">Connect Your Wallet</h2>
        <p className="max-w-sm text-sm text-slate-500">
          Connect your MetaMask or another wallet to start using Arc Machina. Your agent wallet will be a separate EOA managed by the backend.
        </p>
      </div>
    );
  }

  if (!agent || !isAuthenticated) {
    return (
      <div className="space-y-6">
        {/* Quick-start guide */}
        <Card>
          <h2 className="mb-1 text-lg font-bold text-slate-900">Get Started with Arc Machina</h2>
          <p className="mb-6 text-sm text-slate-500">Follow these steps to set up your autonomous agent wallet.</p>
          <div className="flex flex-col gap-4 sm:flex-row">
            {[
              { step: 1, title: 'Connect Wallet', desc: 'Use the button in the top-right corner to connect MetaMask or another EVM wallet.' },
              { step: 2, title: 'Create Agent', desc: 'Go to the Agent tab, name your agent, then configure limits and task access.' },
              { step: 3, title: 'Fund Agent', desc: 'Send ARC or ETH to the agent wallet address shown after creation.' },
              { step: 4, title: 'Bridge & Swap', desc: 'Use the Bridge and Swap tabs to move assets cross-chain.' },
            ].map(({ step, title, desc }) => (
              <div key={step} className="flex flex-1 gap-3 rounded-xl border border-slate-100 bg-slate-50 p-4">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-arc-green text-sm font-bold text-white">
                  {step}
                </div>
                <div>
                  <p className="font-semibold text-slate-800">{title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={() => onNavigate('agent')}>
              Create Agent Wallet <ArrowRight size={16} />
            </Button>
            {ownerAddress && (
              <Button variant="outline" onClick={handleReconnect} loading={connecting}>
                <LogIn size={14} className="mr-2" />
                Reconnect Existing Agent
              </Button>
            )}
          </div>
          {connectError && <Alert type="error" className="mt-3">{connectError}</Alert>}
        </Card>

        <Card>
          <div className="flex items-center gap-3 text-slate-500">
            <Wallet size={18} />
            <span className="text-sm font-medium">Your owner wallet:</span>
            <span className="font-mono text-sm text-slate-700">{formatAddress(ownerAddress)}</span>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Payment modal */}
      {paymentMode && (
        <PaymentModal mode={paymentMode} onClose={() => setPaymentMode(null)} />
      )}

      {/* Agent wallet card */}
      <Card className="border-[#66D121]/30 bg-gradient-to-br from-arc-greenBg to-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Badge variant="green">Active Agent</Badge>
              <span className="text-sm font-semibold text-slate-700">{agent.name}</span>
            </div>
            <p className="text-xs text-slate-500">Independent EOA — runs autonomously on your behalf</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-arc-green">
              {arcPortfolio?.usdcBalance !== null && arcPortfolio?.usdcBalance !== undefined ? `${arcPortfolio.usdcBalance} USDC` : '— USDC'}
            </div>
            <div className="rounded-xl border border-[#627eea]/30 bg-white px-4 py-2 text-sm font-bold text-[#627eea]">
              {sepoliaPortfolio?.nativeBalance !== null && sepoliaPortfolio?.nativeBalance !== undefined ? `${sepoliaPortfolio.nativeBalance} ETH (Sepolia)` : '— ETH'}
            </div>
            {/* Send / Receive */}
            <Button
              variant="outline"
              className="px-4 py-2 text-sm"
              onClick={() => setPaymentMode('send')}
            >
              <Send size={14} /> Send
            </Button>
            <Button
              className="px-4 py-2 text-sm"
              onClick={() => setPaymentMode('receive')}
            >
              <QrCode size={14} /> Receive
            </Button>
          </div>
        </div>
        <div className="mt-4">
          <AddressBox address={agent.walletAddress} label="Agent Wallet Address" compact />
        </div>
        <div className="mt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Balances By Network</p>
            <div className="flex items-center gap-2">
              {loadingPortfolio && <span className="text-xs text-slate-400">Loading balances…</span>}
              <Button
                variant="outline"
                className="px-3 py-2 text-xs"
                onClick={() => loadPortfolio()}
                loading={loadingPortfolio}
              >
                <RefreshCw size={13} /> Refresh
              </Button>
            </div>
          </div>

          {portfolioError && <Alert type="error">{portfolioError}</Alert>}

          {!portfolioError && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {portfolio.map(entry => (
                <div key={entry.chainId} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">{entry.chainName}</p>
                    <span className="text-[11px] font-medium text-slate-400">Agent wallet</span>
                  </div>
                  <div className="mt-3 space-y-1.5 text-sm">
                    {shouldShowNativeBalance(entry) && (
                      <div className="flex items-center justify-between gap-3 text-slate-600">
                        <span>{getGasLabel(entry)}</span>
                        <span className="font-semibold text-slate-900">
                          {entry.nativeBalance ?? '—'}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3 text-slate-600">
                      <span>USDC</span>
                      <span className="font-semibold text-slate-900">{entry.usdcBalance ?? '—'}</span>
                    </div>
                    {entry.eurcBalance !== null && entry.eurcBalance !== undefined && (
                      <div className="flex items-center justify-between gap-3 text-slate-600">
                        <span>EURC</span>
                        <span className="font-semibold text-slate-900">{entry.eurcBalance}</span>
                      </div>
                    )}
                    {entry.cirbtcBalance !== null && entry.cirbtcBalance !== undefined && (
                      <div className="flex items-center justify-between gap-3 text-slate-600">
                        <span>cirBTC</span>
                        <span className="font-semibold text-slate-900">{entry.cirbtcBalance}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Fund this address with USDC on Arc Testnet and gas tokens on the EVM testnets you plan to use.
        </p>
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-slate-400" />
            <div>
              <h3 className="font-semibold text-slate-800">Agent Positions</h3>
              <p className="text-xs text-slate-500">Live DeFi LP positions currently held by the agent wallet.</p>
            </div>
          </div>
          <Button
            variant="outline"
            className="px-3 py-2 text-xs"
            onClick={() => loadPositions()}
            loading={loadingPositions}
          >
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>

        {positionsError && <Alert type="error">{positionsError}</Alert>}

        {!positionsError && positionWarnings.length > 0 && (
          <Alert type="warning" className="mb-3">
            {positionWarnings[0].message}
          </Alert>
        )}

        {loadingPositions ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : positions.length === 0 ? (
          <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-sm text-slate-500">
            No live DeFi LP position is currently detected for this agent wallet.
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {positions.map(position => (
              <div key={`${position.protocol}-${position.poolAddress}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{position.poolKey}</p>
                    <p className="mt-1 text-xs text-slate-500">{formatPositionVenue(position)}</p>
                  </div>
                  <Badge variant="slate">{position.sharePct}% share</Badge>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">LP Balance</p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">{formatLpAmount(position.lpToken?.balance || 0)}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{position.lpToken?.symbol}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {position.protocol === 'curve' ? 'Virtual Price' : 'Pool Model'}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {position.protocol === 'curve'
                        ? (position.virtualPrice ? Number(position.virtualPrice).toFixed(6) : '—')
                        : String(position.poolModel || 'constant_product').replace(/_/g, ' ')}
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      {position.protocol === 'curve'
                        ? position.liquidityState
                        : `${Number(position.feePct || 0.3).toFixed(1)}% fee tier`}
                    </p>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-slate-200 bg-white px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Underlying Assets</p>
                  <div className="mt-2 space-y-1.5 text-sm text-slate-600">
                    {position.underlying.map(asset => (
                      <div key={`${position.poolAddress}-${asset.symbol}`} className="flex items-center justify-between gap-3">
                        <span>{asset.symbol}</span>
                        <span className="font-semibold text-slate-900">{formatPositionAmount(asset.amount || 0)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Owner wallet */}
      <Card>
        <div className="flex items-center gap-3">
          <Wallet size={18} className="text-slate-400" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Owner Wallet (MetaMask)</p>
            <p className="font-mono text-sm text-slate-700">{formatAddress(ownerAddress)}</p>
          </div>
        </div>
      </Card>

      {/* Recent activity */}
      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-slate-400" />
            <h3 className="font-semibold text-slate-800">Recent Activity</h3>
          </div>
          <Button
            variant="outline"
            className="px-3 py-2 text-xs"
            onClick={() => loadTransactions()}
            loading={loadingTxs}
          >
            <RefreshCw size={13} /> Refresh
          </Button>
        </div>
        {loadingTxs ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : txError ? (
          <Alert type="error">{txError}</Alert>
        ) : txs.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">No transactions yet. Your agent activity will appear here.</div>
        ) : (
          <div className="space-y-2">
            {txs.map(tx => {
              const { title, routeLabel, amountLabel, phase, links } = getTxDisplay(tx, { allTxs: txs, agentStatus });
              const isReceive = tx.type === 'receive';
              const isSend    = tx.type === 'send' || tx.type === 'nano_payment';
              const isSwap    = tx.type === 'swap';
              const isDirectLpAdd = tx.type === 'direct_lp_add';
              const isDirectLpRemove = tx.type === 'direct_lp_remove';
              const isCurveLpAdd = tx.type === 'curve_lp_add';
              const isCurveLpRemove = tx.type === 'curve_lp_remove';
              const isTaskArb = tx.type === 'task_arb';
              const isRebalance = tx.type === 'rebalance';
              const isOracleSignal = tx.type === 'oracle_signal';
              const isOracleStrategy = tx.type === 'defi_loop_swap' || tx.type === 'defi_loop_dry';
              const isBridge  = tx.type === 'bridge' || tx.type === 'gas_topup';

              const TxIcon = isReceive ? ArrowDownLeft
                : isSend    ? ArrowUpRight
                : isSwap || isTaskArb || isRebalance ? Repeat2
                : isDirectLpAdd || isDirectLpRemove || isCurveLpAdd || isCurveLpRemove ? Zap
                : isOracleSignal || isOracleStrategy ? Activity
                : Zap;

              const iconColor = isReceive ? 'text-arc-green'
                : isSend    ? 'text-blue-500'
                : isSwap || isTaskArb || isRebalance ? 'text-purple-500'
                : isDirectLpAdd ? 'text-emerald-600'
                : isDirectLpRemove ? 'text-amber-600'
                : isCurveLpAdd ? 'text-emerald-600'
                : isCurveLpRemove ? 'text-amber-600'
                : isOracleSignal ? 'text-sky-500'
                : isOracleStrategy ? 'text-indigo-500'
                : 'text-slate-400';

              const displayTitle = isReceive ? 'Received'
                : isSend && tx.type === 'nano_payment' ? 'Nano payment'
                : isSend ? 'Sent'
                : isDirectLpAdd ? 'Direct Pair LP Add'
                : isDirectLpRemove ? 'Direct Pair LP Exit'
                : isCurveLpAdd ? 'Curve LP Add'
                : isCurveLpRemove ? 'Curve LP Exit'
                : isTaskArb ? 'Signal Trade'
                : isRebalance ? 'Rebalance'
                : title;

              const statusLabel = isOracleSignal ? 'signal' : tx.status;
              const statusVariant = isOracleSignal
                ? 'slate'
                : tx.status === 'confirmed'
                  ? 'green'
                  : tx.status === 'failed'
                    ? 'red'
                    : 'yellow';

              const meta = getTxMeta(tx);
              const counterpart = isReceive
                ? (tx.from_address || meta.from || null)
                : (tx.to_address   || meta.toAddress || null);

              return (
                <div key={tx.id} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm">
                  <div className="flex items-center gap-3">
                    <TxIcon size={15} className={`shrink-0 ${iconColor}`} />
                    <span className="font-semibold text-slate-800 capitalize">{displayTitle}</span>
                    {amountLabel && (
                      <span className={`font-semibold ${isReceive ? 'text-arc-green' : isOracleSignal ? 'text-sky-700' : 'text-slate-700'}`}>
                        {isReceive ? '+' : isSend ? '-' : ''}{amountLabel}
                      </span>
                    )}
                    <Badge variant={statusVariant} className="ml-auto">
                      {statusLabel}
                    </Badge>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[23px] text-xs text-slate-500">
                    {routeLabel && <span>{routeLabel}</span>}
                    {counterpart && (
                      <span className="font-mono">
                        {isReceive ? 'from ' : 'to '}
                        {counterpart.slice(0, 8)}…{counterpart.slice(-5)}
                      </span>
                    )}
                    {phase && <span className="min-w-0 break-all">{phase}</span>}
                    {links.map(link => (
                      <a key={link.key} href={link.url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-arc-green hover:underline font-mono">
                        <span>{link.label}</span>
                        <span>{link.hash.slice(0, 10)}…</span>
                        <ExternalLink size={10} />
                      </a>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {[
          { label: 'Bridge Assets', tab: 'bridge' },
          { label: 'Swap Tokens',   tab: 'swap'   },
          { label: 'Agent Settings',tab: 'agent'  },
        ].map(({ label, tab }) => (
          <Button key={tab} variant="outline" onClick={() => onNavigate(tab)} className="w-full">
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}
