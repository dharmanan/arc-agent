/**
 * useBridgeKit — Real Circle CCTP V2 cross-chain USDC bridge
 * Uses @circle-fin/bridge-kit + @circle-fin/adapter-viem-v2
 * Ported from dharmanan/Arc-Testnet-Bridge-Swap
 */
import { useState, useCallback, useRef } from 'react';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import { createAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import {
  BridgeKit,
  ArcTestnet,
  EthereumSepolia,
  BaseSepolia,
  OptimismSepolia,
  ArbitrumSepolia,
} from '@circle-fin/bridge-kit';

// Chain name (as displayed in UI) → { chainId, bridgeChain }
export const BRIDGE_CHAINS = {
  'Sepolia':           { chainId: 11155111, bridgeChain: EthereumSepolia },
  'Arc Testnet':       { chainId: 5042002,  bridgeChain: ArcTestnet },
  'Base Sepolia':      { chainId: 84532,    bridgeChain: BaseSepolia },
  'Optimism Sepolia':  { chainId: 11155420, bridgeChain: OptimismSepolia },
  'Arbitrum Sepolia':  { chainId: 421614,   bridgeChain: ArbitrumSepolia },
};

// Explorer URLs per chainId
const EXPLORERS = {
  11155111: 'https://sepolia.etherscan.io',
  5042002:  'https://testnet.arcscan.app',
  84532:    'https://sepolia.basescan.org',
  11155420: 'https://sepolia-optimism.etherscan.io',
  421614:   'https://sepolia.arbiscan.io',
};

export function useBridgeKit() {
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  const kitRef = useRef(null);

  const [steps, setSteps] = useState([]);
  const [bridgeResult, setBridgeResult] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sourceTxHash, setSourceTxHash] = useState(null);
  const [receiveTxHash, setReceiveTxHash] = useState(null);

  const getAdapter = useCallback(async () => {
    if (!walletClient) throw new Error('Wallet not connected');
    // Wrap wagmi walletClient in EIP-1193 interface
    const provider = {
      request: async ({ method, params }) =>
        walletClient.transport.request({ method, params }),
    };
    return await createAdapterFromProvider({ provider });
  }, [walletClient]);

  const bridge = useCallback(
    async ({ amount, fromChainName, toChainName }) => {
      if (!address) throw new Error('Wallet not connected');
      if (!walletClient) throw new Error('Wallet client not ready');

      const fromInfo = BRIDGE_CHAINS[fromChainName];
      const toInfo   = BRIDGE_CHAINS[toChainName];
      if (!fromInfo) throw new Error(`Unsupported source chain: ${fromChainName}`);
      if (!toInfo)   throw new Error(`Unsupported destination chain: ${toChainName}`);
      if (fromChainName === toChainName) throw new Error('Source and destination must differ');

      setError(null);
      setSteps([]);
      setBridgeResult(null);
      setSourceTxHash(null);
      setReceiveTxHash(null);
      setIsLoading(true);

      try {
        // Switch to source chain first
        if (chainId !== fromInfo.chainId) {
          await switchChain({ chainId: fromInfo.chainId });
          // Give wallet time to settle after chain switch
          await new Promise(r => setTimeout(r, 1500));
        }

        const adapter = await getAdapter();

        // Create or reuse BridgeKit singleton
        if (!kitRef.current) {
          kitRef.current = new BridgeKit();
        }
        const kit = kitRef.current;

        // Listen to per-step events from CCTP provider
        // Each action has shape: { method: 'approve'|'burn'|'fetchAttestation'|'mint', values: BridgeStep }
        const handleAction = (action) => {
          if (!action?.values) return;
          const step = action.values;
          setSteps(prev => {
            const idx = prev.findIndex(s => s.name === step.name);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = step;
              return next;
            }
            return [...prev, step];
          });
          if (action.method === 'burn' && step.txHash) {
            setSourceTxHash(step.txHash);
          }
          if (action.method === 'mint' && step.txHash) {
            setReceiveTxHash(step.txHash);
          }
        };

        kit.on('*', handleAction);

        try {
          const result = await kit.bridge({
            from: { adapter, chain: fromInfo.bridgeChain, address },
            to:   { adapter, chain: toInfo.bridgeChain,   address },
            amount: String(amount),
          });

          setBridgeResult(result);

          // Extract hashes from result steps as fallback
          if (result?.steps) {
            const burnStep = result.steps.find(
              s => s.name?.toLowerCase().includes('burn')
            );
            const mintStep = result.steps.find(
              s => s.name?.toLowerCase().includes('mint')
            );
            if (burnStep?.txHash) setSourceTxHash(burnStep.txHash);
            if (mintStep?.txHash) setReceiveTxHash(mintStep.txHash);
          }

          return result;
        } finally {
          kit.off('*', handleAction);
        }
      } catch (e) {
        setError(e?.message ?? String(e));
        throw e;
      } finally {
        setIsLoading(false);
      }
    },
    [address, chainId, walletClient, switchChain, getAdapter],
  );

  const reset = useCallback(() => {
    setSteps([]);
    setBridgeResult(null);
    setError(null);
    setSourceTxHash(null);
    setReceiveTxHash(null);
  }, []);

  function getExplorer(chainName, txHash) {
    const info = BRIDGE_CHAINS[chainName];
    if (!info || !txHash) return null;
    return `${EXPLORERS[info.chainId]}/tx/${txHash}`;
  }

  return {
    bridge,
    reset,
    steps,
    bridgeResult,
    error,
    isLoading,
    sourceTxHash,
    receiveTxHash,
    supportedChains: Object.keys(BRIDGE_CHAINS),
    getExplorer,
  };
}
