/**
 * agentBalances.js
 * Fetches native (ETH/ARC) and USDC ERC-20 balances for an agent wallet.
 */
import { CHAINS } from './chains.js';

// ERC-20 balanceOf(address) selector = 0x70a08231
function balanceOfCalldata(address) {
  return '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
}

function formatUnits(rawValue, decimals, fractionDigits) {
  const divisor = 10 ** decimals;
  return (Number(rawValue) / divisor).toFixed(fractionDigits);
}

/** Native ETH/ARC balance — returns string with 4 decimals */
export async function fetchAgentBalance(agentAddress, chainId) {
  const chainConfig = Object.values(CHAINS).find(c => c.chainId === chainId);
  if (!chainConfig || !agentAddress) return null;

  try {
    const res = await fetch(chainConfig.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [agentAddress, 'latest'],
      }),
    });
    const json = await res.json();
    if (!json.result) return '0.0000';
    const wei = BigInt(json.result);
    return formatUnits(wei, 18, 4);
  } catch {
    return null;
  }
}

export async function fetchTokenBalance(agentAddress, chainId, tokenAddress, decimals = 6, fractionDigits = 2) {
  const chainConfig = Object.values(CHAINS).find(c => c.chainId === chainId);
  if (!chainConfig || !tokenAddress || !agentAddress) return null;

  try {
    const res = await fetch(chainConfig.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_call',
        params: [
          { to: tokenAddress, data: balanceOfCalldata(agentAddress) },
          'latest',
        ],
      }),
    });
    const json = await res.json();
    if (!json.result || json.result === '0x') return (0).toFixed(fractionDigits);
    return formatUnits(BigInt(json.result), decimals, fractionDigits);
  } catch {
    return null;
  }
}

/** USDC ERC-20 balance — returns string with 2 decimals (USDC has 6 decimals on-chain) */
export async function fetchUsdcBalance(agentAddress, chainId) {
  const chainConfig = Object.values(CHAINS).find(c => c.chainId === chainId);
  return fetchTokenBalance(agentAddress, chainId, chainConfig?.usdcAddress, 6, 2);
}

export async function fetchEurcBalance(agentAddress, chainId) {
  const chainConfig = Object.values(CHAINS).find(c => c.chainId === chainId);
  return fetchTokenBalance(agentAddress, chainId, chainConfig?.eurcAddress, 6, 2);
}

export async function fetchCirbtcBalance(agentAddress, chainId) {
  const chainConfig = Object.values(CHAINS).find(c => c.chainId === chainId);
  return fetchTokenBalance(agentAddress, chainId, chainConfig?.cirbtcAddress, 8, 6);
}

export async function fetchAgentBalances(agentAddress) {
  const results = {};
  await Promise.allSettled(
    Object.entries(CHAINS).map(async ([name, cfg]) => {
      results[name] = await fetchAgentBalance(agentAddress, cfg.chainId);
    }),
  );
  return results;
}

export async function fetchAgentPortfolio(agentAddress, chainNames = ['Arc Testnet', 'Sepolia', 'Base Sepolia', 'Optimism Sepolia', 'Arbitrum Sepolia']) {
  const portfolio = await Promise.all(
    chainNames.map(async (chainName) => {
      const chainConfig = CHAINS[chainName];
      if (!chainConfig) return null;

      const [nativeBalance, usdcBalance, eurcBalance, cirbtcBalance] = await Promise.all([
        fetchAgentBalance(agentAddress, chainConfig.chainId),
        fetchUsdcBalance(agentAddress, chainConfig.chainId),
        fetchEurcBalance(agentAddress, chainConfig.chainId),
        fetchCirbtcBalance(agentAddress, chainConfig.chainId),
      ]);

      return {
        chainName,
        chainId: chainConfig.chainId,
        nativeSymbol: chainConfig.nativeCurrency?.symbol || 'ETH',
        nativeBalance,
        usdcBalance,
        eurcBalance,
        cirbtcBalance,
      };
    }),
  );

  return portfolio.filter(Boolean);
}
