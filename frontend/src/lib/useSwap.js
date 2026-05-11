/**
 * useSwap — Real ETH↔USDC swap on Sepolia via Uniswap V2
 * Ported from dharmanan/Arc-Testnet-Bridge-Swap
 */
import { useState, useCallback, useEffect } from 'react';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import { ethers } from 'ethers';

const SEPOLIA_CHAIN_ID = 11155111;

const SEPOLIA_CONFIG = {
  chainId: SEPOLIA_CHAIN_ID,
  UNISWAP_V2_ROUTER: '0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008',
  USDC_ADDRESS:      '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  WETH_ADDRESS:      '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
};

const ROUTER_ABI = [
  'function WETH() external pure returns (address)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const SEPOLIA_ERROR = 'Switch your wallet to Ethereum Sepolia to use swap.';

export function useSwap() {
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  const [state, setState] = useState({
    inputAmount:    '',
    outputAmount:   '',
    isEthToUsdc:    true,
    error:          null,
    status:         null,
    txHash:         null,
    isLoading:      false,
    ethBalance:     null,
    usdcBalance:    null,
    isLoadingBalance: false,
  });

  const getWalletProvider = useCallback(async () => {
    if (!walletClient) return null;
    return new ethers.BrowserProvider(
      {
        request: async ({ method, params }) =>
          walletClient.transport.request({ method, params }),
      },
      { chainId: walletClient.chain.id, name: walletClient.chain.name },
    );
  }, [walletClient]);

  const getReadProvider = useCallback(async () => {
    const p = await getWalletProvider();
    if (!p) throw new Error('Wallet not connected');
    if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(SEPOLIA_ERROR);
    return p;
  }, [chainId, getWalletProvider]);

  // Auto-clear Sepolia error when chain changes
  useEffect(() => {
    if (!address) return;
    if (chainId !== SEPOLIA_CHAIN_ID) {
      setState(prev => ({ ...prev, ethBalance: null, usdcBalance: null, error: SEPOLIA_ERROR }));
    } else {
      setState(prev => (prev.error === SEPOLIA_ERROR ? { ...prev, error: null } : prev));
    }
  }, [address, chainId]);

  const fetchBalances = useCallback(async () => {
    if (!address) return;
    setState(prev => ({ ...prev, isLoadingBalance: true }));
    try {
      const provider = await getReadProvider();
      const ethBal  = await provider.getBalance(address);
      const usdc    = new ethers.Contract(SEPOLIA_CONFIG.USDC_ADDRESS, ERC20_ABI, provider);
      const usdcBal = await usdc.balanceOf(address);
      setState(prev => ({
        ...prev,
        ethBalance:  parseFloat(ethers.formatEther(ethBal)).toFixed(4),
        usdcBalance: parseFloat(ethers.formatUnits(usdcBal, 6)).toFixed(2),
        error: null,
        isLoadingBalance: false,
      }));
    } catch (e) {
      setState(prev => ({ ...prev, error: e.message, isLoadingBalance: false }));
    }
  }, [address, getReadProvider]);

  const estimateOutput = useCallback(async (amount) => {
    if (!amount || parseFloat(amount) <= 0) {
      setState(prev => ({ ...prev, outputAmount: '' }));
      return;
    }
    try {
      const provider = await getReadProvider();
      const router = new ethers.Contract(SEPOLIA_CONFIG.UNISWAP_V2_ROUTER, ROUTER_ABI, provider);
      const isEth = state.isEthToUsdc;
      const path = isEth
        ? [SEPOLIA_CONFIG.WETH_ADDRESS, SEPOLIA_CONFIG.USDC_ADDRESS]
        : [SEPOLIA_CONFIG.USDC_ADDRESS, SEPOLIA_CONFIG.WETH_ADDRESS];
      const amountIn = isEth ? ethers.parseEther(amount) : ethers.parseUnits(amount, 6);
      const amounts = await router.getAmountsOut(amountIn, path);
      const out = ethers.formatUnits(amounts[1], isEth ? 6 : 18);
      setState(prev => ({ ...prev, outputAmount: parseFloat(out).toFixed(isEth ? 2 : 6), error: null }));
    } catch (e) {
      setState(prev => ({ ...prev, outputAmount: '', error: e.message }));
    }
  }, [getReadProvider, state.isEthToUsdc]);

  const setInputAmount = useCallback((amount) => {
    setState(prev => ({ ...prev, inputAmount: amount }));
    estimateOutput(amount);
  }, [estimateOutput]);

  const toggleDirection = useCallback(() => {
    setState(prev => ({ ...prev, isEthToUsdc: !prev.isEthToUsdc, inputAmount: '', outputAmount: '' }));
  }, []);

  const executeSwap = useCallback(async () => {
    if (!address) { setState(prev => ({ ...prev, error: 'Connect your wallet first' })); return; }
    if (chainId !== SEPOLIA_CHAIN_ID) {
      try { await switchChain({ chainId: SEPOLIA_CHAIN_ID }); }
      catch { setState(prev => ({ ...prev, error: 'Failed to switch to Sepolia' })); return; }
    }
    if (!state.inputAmount || parseFloat(state.inputAmount) <= 0) {
      setState(prev => ({ ...prev, error: 'Enter a valid amount' })); return;
    }
    setState(prev => ({ ...prev, error: null, status: 'Initiating swap…', txHash: null, isLoading: true }));
    try {
      const provider = await getWalletProvider();
      const signer   = await provider.getSigner();
      const router   = new ethers.Contract(SEPOLIA_CONFIG.UNISWAP_V2_ROUTER, ROUTER_ABI, signer);
      const weth     = await router.WETH();
      const isEth    = state.isEthToUsdc;
      const path     = isEth ? [weth, SEPOLIA_CONFIG.USDC_ADDRESS] : [SEPOLIA_CONFIG.USDC_ADDRESS, weth];
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const amountIn = isEth
        ? ethers.parseEther(state.inputAmount)
        : ethers.parseUnits(state.inputAmount, 6);
      const amounts = await router.getAmountsOut(amountIn, path);
      const minOut  = amounts[1] * BigInt(95) / BigInt(100); // 5% slippage
      let tx;
      if (isEth) {
        setState(prev => ({ ...prev, status: 'Swapping ETH → USDC…' }));
        tx = await router.swapExactETHForTokens(minOut, path, address, deadline, { value: amountIn });
      } else {
        setState(prev => ({ ...prev, status: 'Approving USDC…' }));
        const usdc = new ethers.Contract(SEPOLIA_CONFIG.USDC_ADDRESS, ERC20_ABI, signer);
        const allowance = await usdc.allowance(address, SEPOLIA_CONFIG.UNISWAP_V2_ROUTER);
        if (allowance < amountIn) {
          const approveTx = await usdc.approve(SEPOLIA_CONFIG.UNISWAP_V2_ROUTER, amountIn);
          await approveTx.wait();
        }
        setState(prev => ({ ...prev, status: 'Swapping USDC → ETH…' }));
        tx = await router.swapExactTokensForETH(amountIn, minOut, path, address, deadline);
      }
      setState(prev => ({ ...prev, status: 'Waiting for confirmation…', txHash: tx.hash }));
      await tx.wait();
      setState(prev => ({ ...prev, status: 'Swap successful!', isLoading: false, inputAmount: '', outputAmount: '' }));
      fetchBalances();
      setTimeout(() => setState(prev => ({ ...prev, status: null, txHash: null })), 6000);
    } catch (e) {
      const msg = e?.message?.includes('user rejected') || e?.message?.includes('ACTION_REJECTED')
        ? 'Transaction rejected by user'
        : e?.message || 'Swap failed';
      setState(prev => ({ ...prev, error: msg, status: null, isLoading: false }));
    }
  }, [address, chainId, switchChain, state.inputAmount, state.isEthToUsdc, getWalletProvider, fetchBalances]);

  return { state, setInputAmount, toggleDirection, executeSwap, fetchBalances };
}
