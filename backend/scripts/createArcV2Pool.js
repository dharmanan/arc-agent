'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { ethers } = require('ethers');

const DEFAULT_FACTORY_ADDRESS = '0x9442cb5b2bBF2009b1933c762f5B89eDCD3eaE08';
const DEFAULT_RPC_URL = 'https://rpc.testnet.arc.network';

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
  'function createPair(address tokenA, address tokenB) returns (address pair)',
];

const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function mint(address to) returns (uint256 liquidity)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

function loadEnvFiles() {
  const candidates = [
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env.local'),
    path.resolve(__dirname, '../../.env'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
    }
  }
}

function printHelp() {
  console.log(`Arc V2 Pool Creator

Usage:
  node backend/scripts/createArcV2Pool.js --token-a <address> --token-b <address> [options]

Options:
  --token-a <address>        First ERC20 token address (required)
  --token-b <address>        Second ERC20 token address (required)
  --amount-a <amount>        Initial token A liquidity amount in human units
  --amount-b <amount>        Initial token B liquidity amount in human units
  --recipient <address>      LP token recipient (default: operator wallet)
  --factory <address>        V2 factory address (default: ${DEFAULT_FACTORY_ADDRESS})
  --rpc <url>                Arc RPC URL (default: ${DEFAULT_RPC_URL})
  --dry-run                  Simulate createPair and print the predicted pair address
  --help                     Show this message

Environment:
  ARC_POOL_OPERATOR_PRIVATE_KEY or RELAYER_PRIVATE_KEY

Notes:
  - Pair creation is permissionless on the tested Arc V2-style factory.
  - Initial liquidity is optional, but a pair without liquidity is not usable.
  - The first liquidity deposit sets the initial price ratio.
`);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    factoryAddress: DEFAULT_FACTORY_ADDRESS,
    rpcUrl: process.env.ARC_RPC_URL || process.env.ARC_TESTNET_RPC || DEFAULT_RPC_URL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    switch (current) {
      case '--token-a':
        args.tokenA = argv[index + 1];
        index += 1;
        break;
      case '--token-b':
        args.tokenB = argv[index + 1];
        index += 1;
        break;
      case '--amount-a':
        args.amountA = argv[index + 1];
        index += 1;
        break;
      case '--amount-b':
        args.amountB = argv[index + 1];
        index += 1;
        break;
      case '--recipient':
        args.recipient = argv[index + 1];
        index += 1;
        break;
      case '--factory':
        args.factoryAddress = argv[index + 1];
        index += 1;
        break;
      case '--rpc':
        args.rpcUrl = argv[index + 1];
        index += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function requireAddress(value, label) {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${label} must be a valid address`);
  }

  return ethers.getAddress(value);
}

function getOperatorPrivateKey() {
  return process.env.ARC_POOL_OPERATOR_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || '';
}

async function readTokenMetadata(provider, tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol(),
    token.decimals(),
  ]);

  return {
    address: tokenAddress,
    symbol,
    decimals,
    contract: token,
  };
}

async function ensurePair(factory, tokenA, tokenB, isDryRun) {
  const existingPairAddress = await factory.getPair(tokenA, tokenB);
  if (existingPairAddress && existingPairAddress !== ethers.ZeroAddress) {
    return {
      created: false,
      pairAddress: existingPairAddress,
      txHash: null,
    };
  }

  if (isDryRun) {
    const predictedPairAddress = await factory.createPair.staticCall(tokenA, tokenB);
    return {
      created: false,
      pairAddress: predictedPairAddress,
      txHash: null,
      dryRun: true,
    };
  }

  const createTx = await factory.createPair(tokenA, tokenB);
  const createReceipt = await createTx.wait();
  const pairAddress = await factory.getPair(tokenA, tokenB);

  return {
    created: true,
    pairAddress,
    txHash: createReceipt.hash,
  };
}

async function seedInitialLiquidity({ wallet, pairAddress, tokenA, tokenB, amountA, amountB, recipient }) {
  const parsedAmountA = ethers.parseUnits(amountA, tokenA.decimals);
  const parsedAmountB = ethers.parseUnits(amountB, tokenB.decimals);

  const [balanceA, balanceB] = await Promise.all([
    tokenA.contract.balanceOf(wallet.address),
    tokenB.contract.balanceOf(wallet.address),
  ]);

  if (balanceA < parsedAmountA) {
    throw new Error(`Insufficient ${tokenA.symbol} balance for initial liquidity`);
  }

  if (balanceB < parsedAmountB) {
    throw new Error(`Insufficient ${tokenB.symbol} balance for initial liquidity`);
  }

  const connectedTokenA = tokenA.contract.connect(wallet);
  const connectedTokenB = tokenB.contract.connect(wallet);
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, wallet);

  const transferATx = await connectedTokenA.transfer(pairAddress, parsedAmountA);
  const transferAReceipt = await transferATx.wait();

  const transferBTx = await connectedTokenB.transfer(pairAddress, parsedAmountB);
  const transferBReceipt = await transferBTx.wait();

  const mintTx = await pair.mint(recipient);
  const mintReceipt = await mintTx.wait();
  const reserves = await pair.getReserves();

  return {
    transferATxHash: transferAReceipt.hash,
    transferBTxHash: transferBReceipt.hash,
    mintTxHash: mintReceipt.hash,
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
  };
}

async function main() {
  loadEnvFiles();

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const tokenAAddress = requireAddress(args.tokenA, 'tokenA');
  const tokenBAddress = requireAddress(args.tokenB, 'tokenB');
  const factoryAddress = requireAddress(args.factoryAddress, 'factory');

  if (tokenAAddress === tokenBAddress) {
    throw new Error('tokenA and tokenB must be different addresses');
  }

  const hasLiquidityArgs = args.amountA != null || args.amountB != null;
  if ((args.amountA == null) !== (args.amountB == null)) {
    throw new Error('amountA and amountB must be provided together');
  }

  const provider = new ethers.JsonRpcProvider(args.rpcUrl, { chainId: 5042002, name: 'Arc Testnet' });
  const [tokenA, tokenB] = await Promise.all([
    readTokenMetadata(provider, tokenAAddress),
    readTokenMetadata(provider, tokenBAddress),
  ]);

  console.log(`Factory      : ${factoryAddress}`);
  console.log(`Token A      : ${tokenA.symbol} (${tokenA.address})`);
  console.log(`Token B      : ${tokenB.symbol} (${tokenB.address})`);
  console.log(`Mode         : ${args.dryRun ? 'dry-run' : 'write'}`);

  let wallet = null;
  if (!args.dryRun) {
    const privateKey = getOperatorPrivateKey();
    if (!privateKey) {
      throw new Error('ARC_POOL_OPERATOR_PRIVATE_KEY or RELAYER_PRIVATE_KEY is required for write mode');
    }

    wallet = new ethers.Wallet(privateKey, provider);
    console.log(`Operator     : ${wallet.address}`);
  }

  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, wallet || provider);
  const pairResult = await ensurePair(factory, tokenA.address, tokenB.address, args.dryRun);

  console.log(`Pair address : ${pairResult.pairAddress}`);
  if (pairResult.txHash) {
    console.log(`Create tx    : ${pairResult.txHash}`);
  }
  if (pairResult.created) {
    console.log('Pair status  : created');
  } else if (pairResult.dryRun) {
    console.log('Pair status  : creatable (simulated)');
  } else {
    console.log('Pair status  : already exists');
  }

  if (args.dryRun || !hasLiquidityArgs) {
    return;
  }

  const recipient = args.recipient ? requireAddress(args.recipient, 'recipient') : wallet.address;
  const liquidityResult = await seedInitialLiquidity({
    wallet,
    pairAddress: pairResult.pairAddress,
    tokenA,
    tokenB,
    amountA: args.amountA,
    amountB: args.amountB,
    recipient,
  });

  console.log(`Transfer A tx: ${liquidityResult.transferATxHash}`);
  console.log(`Transfer B tx: ${liquidityResult.transferBTxHash}`);
  console.log(`Mint tx      : ${liquidityResult.mintTxHash}`);
  console.log(`Reserves     : ${liquidityResult.reserve0} / ${liquidityResult.reserve1}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});