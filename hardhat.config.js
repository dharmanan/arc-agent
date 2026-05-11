require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || "0x" + "0".repeat(64);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    arc: {
      url: process.env.ARC_TESTNET_RPC || "https://rpc.arc-testnet.io",
      chainId: 5042002,
      accounts: [RELAYER_PRIVATE_KEY],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: [RELAYER_PRIVATE_KEY],
    },
    base_sepolia: {
      url: process.env.BASE_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts: [RELAYER_PRIVATE_KEY],
    },
  },
  paths: {
    sources: "./contracts",
    scripts: "./scripts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
