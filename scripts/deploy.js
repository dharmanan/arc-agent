const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // 1. Deploy AgentWalletFactory
  console.log("\n→ Deploying AgentWalletFactory...");
  const Factory = await ethers.getContractFactory("AgentWalletFactory");
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("  AgentWalletFactory:", factoryAddress);

  // 2. Verify factory is live
  const code = await ethers.provider.getCode(factoryAddress);
  if (code === "0x") throw new Error("Factory deployment failed — no bytecode");

  console.log("\n✅ Deployment complete!");
  console.log("──────────────────────────────────────────");
  console.log("FACTORY_ADDRESS=" + factoryAddress);
  console.log("──────────────────────────────────────────");
  console.log("\nAdd these to your .env file:");
  console.log(`FACTORY_ADDRESS=${factoryAddress}`);
  console.log(`CHAIN_ID=${(await ethers.provider.getNetwork()).chainId}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
