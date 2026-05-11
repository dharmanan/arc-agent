import { http, createConfig } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { injected, metaMask } from 'wagmi/connectors';
import { connectorsForWallets, getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  metaMaskWallet,
  injectedWallet,
  braveWallet,
  coinbaseWallet,
  rainbowWallet,
} from '@rainbow-me/rainbowkit/wallets';

// Arc Testnet custom chain definition
export const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'ARC', symbol: 'ARC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
    public:  { http: ['https://rpc.testnet.arc.network'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
};

const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

// Build connector list — injected wallets work without a projectId
const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [injectedWallet, metaMaskWallet, braveWallet, coinbaseWallet],
    },
    ...(PROJECT_ID ? [{ groupName: 'More', wallets: [rainbowWallet] }] : []),
  ],
  {
    appName: 'Arc Machina',
    projectId: PROJECT_ID || 'arc-machina-placeholder',
  },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [arcTestnet, sepolia],
  transports: {
    [arcTestnet.id]: http('https://rpc.testnet.arc.network'),
    // Use publicnode — thirdweb's default RPC blocks Codespace origins (CORS)
    [sepolia.id]:    http('https://ethereum-sepolia-rpc.publicnode.com'),
  },
  ssr: false,
});

export const SUPPORTED_CHAINS = [arcTestnet, sepolia];
