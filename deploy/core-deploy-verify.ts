import { ethers, run, network } from "hardhat";
import { Contract, ContractFactory } from "ethers";

const MULTI_SIG_GRIZZLY_ETH = "0xcE88F73FAA2C8de5fdE0951A6b80583af4C14265";

async function main() {
  console.log(new Date().toUTCString());

  const deployerWallet = (await ethers.getSigners())[0];
  console.log(`deployer address: ${deployerWallet.address}`);

  console.log(`networkId: ${network.config.chainId}`);

  console.log(
    `deployerETHBalance before: ${await ethers.provider.getBalance(
      deployerWallet.address
    )}`
  );

  console.log("gasPrice: ", (await ethers.provider.getGasPrice()).toNumber());

  // Deploy contracts
  const grizzlyVaultFactory = await ethers.getContractFactory("GrizzlyVault");
  const zapContractFactory = await ethers.getContractFactory("ZapContract");

  const grizzlyVault = await deploy(grizzlyVaultFactory, "GrizzlyVault");
  const zapContract = await deploy(zapContractFactory, "ZapContract");

  // Verification
  if (network.config.chainId === 5 && process.env.ETHERSCAN_API_KEY) {
    console.log("Waiting for block confirmations...");
    await zapContract.deployTransaction.wait(5);
    await verify(grizzlyVault.address, []);
    await verify(zapContract.address, []);
  }
}

async function deploy(factory: ContractFactory, name: string, params = []) {
  console.log(`Deploying ${name}...`);
  const contract = await factory.deploy(...params);
  await contract.deployed();
  await contract.deployTransaction.wait(1);
  console.log(`Deployed ${name} contract to: ${contract.address}`);

  return contract;
}

const verify = async (contractAddress: string, args: any) => {
  console.log("Verifying contract...");
  try {
    await run("verify:verify", {
      address: contractAddress,
      constructorArguments: args,
    });
  } catch (e: any) {
    if (e.message.toLowerCase().includes("already verified")) {
      console.log("Already Verified!");
    } else {
      console.log(e);
    }
  }
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
