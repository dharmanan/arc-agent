/**
 * Arc Machina — Chain & Contract Configuration
 */
'use strict';

export const CHAINS = {
  'Arc Testnet': {
    chainId:     5042002,
    color:       '#3d7eff',
    rpcUrl:      'https://rpc.testnet.arc.network',
    explorerUrl: 'https://testnet.arcscan.app',
    usdcAddress: '0x3600000000000000000000000000000000000000',
    nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
  },
  'Sepolia': {
    chainId:     11155111,
    color:       '#627eea',
    rpcUrl:      'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  'Base': {
    chainId:     8453,
    color:       '#0052ff',
    rpcUrl:      'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  'Optimism': {
    chainId:     10,
    color:       '#ff0420',
    rpcUrl:      'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  'Arbitrum': {
    chainId:     42161,
    color:       '#28a0f0',
    rpcUrl:      'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  'Solana': {
    chainId:     'solana',
    color:       '#9945ff',
    rpcUrl:      'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://explorer.solana.com',
    usdcAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
  },
};

// EIP-681 chain IDs for payment URI generation
export const CHAIN_IDS = {
  'Arc Testnet': '5042002',
  'Sepolia':     '11155111',
  'Base':        '8453',
  'Optimism':    '10',
  'Arbitrum':    '42161',
  'Solana':      'solana',
};

export const UNISWAP_V2_ROUTER_SEPOLIA = '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008';
export const WETH_SEPOLIA              = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9';

export const AGENT_PERMISSIONS = [
  { key: 'defi_scan',        label: 'DeFi Protocol Scanner',   desc: 'Auto-scan yield opportunities' },
  { key: 'arbitrage',        label: 'Arbitrage',               desc: 'Cross-chain price differences' },
  { key: 'testnet_explorer', label: 'Testnet Explorer',        desc: 'ArcScan on-chain data reads' },
  { key: 'contract_scanner', label: 'New Contract Scanner',    desc: 'Watch newly deployed contracts' },
  { key: 'liquidations',     label: 'Liquidation Monitor',     desc: 'Watch liquidation events' },
  { key: 'aggressive_mode',  label: 'Aggressive Mode',         desc: 'High risk / high reward strategies' },
];
