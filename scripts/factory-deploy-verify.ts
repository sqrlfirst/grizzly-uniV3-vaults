import { ethers, run, network } from "hardhat";

const IMPLEMENTATION = "0xfe136C80C898d4268c441Fa003d637893783d1bC";
const GRIZZLY_DEPLOYER = "0xfe136C80C898d4268c441Fa003d637893783d1bC";

async function main() {
  const grizzlyVaultFactoryFactory = await ethers.getContractFactory(
    "GrizzlyVaultFactory"
  );
  const deployArgs = [IMPLEMENTATION, GRIZZLY_DEPLOYER];

  const grizzlyVaultFactory = await grizzlyVaultFactoryFactory.deploy(
    ...deployArgs
  );
  console.log("Deploying GrizzlyVaultFactory...");
  await grizzlyVaultFactory.deployed();
  console.log("GrizzlyVaultFactory deployed to:", grizzlyVaultFactory.address);

  if (network.config.chainId === 1 && process.env.ETHERSCAN_API) {
    console.log("Waiting for block confirmations...");
    await grizzlyVaultFactory.deployTransaction.wait(5);
    await verify(grizzlyVaultFactory.address, deployArgs);
  }
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
