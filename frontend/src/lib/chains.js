/**
 * Arc Machina — Chain & Contract Configuration
 */

export const ARC_TESTNET_ID = 5042002;
export const SEPOLIA_ID     = 11155111;

export const CHAINS = {
  'Arc Testnet': {
    chainId:     ARC_TESTNET_ID,
    color:       '#2F6E0C',
    rpcUrl:      'https://rpc.testnet.arc.network',
    explorerUrl: 'https://testnet.arcscan.app',
    // Adresler: Circle SDK'dan (@circle-fin/bridge-kit → ArcTestnet)
    usdcAddress: '0x3600000000000000000000000000000000000000',
    eurcAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    // Adres: @circle-fin/swap-kit built-in CIRBTC locator for Blockchain.Arc_Testnet
    cirbtcAddress: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
    // Circle CCTP V2 kontratları
    cctpTokenMessenger:    '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    cctpMessageTransmitter:'0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
  },
  Sepolia: {
    chainId:     SEPOLIA_ID,
    color:       '#627eea',
    rpcUrl:      'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    eurcAddress: '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  Base: {
    chainId:     8453,
    color:       '#0052ff',
    rpcUrl:      'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  Optimism: {
    chainId:     10,
    color:       '#ff0420',
    rpcUrl:      'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  Arbitrum: {
    chainId:     42161,
    color:       '#28a0f0',
    rpcUrl:      'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  'Base Sepolia': {
    chainId:     84532,
    color:       '#0052ff',
    rpcUrl:      'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    eurcAddress: '0x808456652fdb597867f38412077A9182bf77359F',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  'Optimism Sepolia': {
    chainId:     11155420,
    color:       '#ff0420',
    rpcUrl:      'https://sepolia.optimism.io',
    explorerUrl: 'https://sepolia-optimism.etherscan.io',
    usdcAddress: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  'Arbitrum Sepolia': {
    chainId:     421614,
    color:       '#28a0f0',
    rpcUrl:      'https://sepolia-rollup.arbitrum.io/rpc',
    explorerUrl: 'https://sepolia.arbiscan.io',
    usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
};

export const UNISWAP_V2_ROUTER_SEPOLIA = '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008';
export const WETH_SEPOLIA              = '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9';

export const AGENT_PERMISSIONS = [
  { key: 'defi_scan',        label: 'DeFi Protocol Scanner',  desc: 'Auto-scan yield opportunities' },
  { key: 'arbitrage',        label: 'Arbitrage',              desc: 'Cross-chain price differences' },
  { key: 'testnet_explorer', label: 'Testnet Explorer',       desc: 'ArcScan on-chain data reads' },
  { key: 'contract_scanner', label: 'New Contract Scanner',   desc: 'Watch newly deployed contracts' },
  { key: 'liquidations',     label: 'Liquidation Monitor',    desc: 'Watch liquidation events' },
  { key: 'aggressive_mode',  label: 'Aggressive Mode',        desc: 'High risk / high reward strategies' },
];

export function getExplorerUrl(chainId, txHash) {
  const chain = Object.values(CHAINS).find(c => c.chainId === chainId);
  if (!chain) return '#';
  return `${chain.explorerUrl}/tx/${txHash}`;
}

export function getAddressExplorerUrl(chainId, address) {
  const chain = Object.values(CHAINS).find(c => c.chainId === chainId);
  if (!chain) return '#';
  return `${chain.explorerUrl}/address/${address}`;
}
