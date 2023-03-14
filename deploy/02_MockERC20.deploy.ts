import { deployments, getNamedAccounts } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  if (hre.network.name === "mainnet") {
    console.log(
      `!! Deploying MockERC20 to ${hre.network.name}. Hit ctrl + c to abort`
    );
    await new Promise((r) => setTimeout(r, 20000));
  }

  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy("TokenA", {
    contract: "MockERC20",
    from: deployer,
    proxy: {
      execute: {
        methodName: "initialize",
        args: ["Token A", "TOKENA"],
      },
    },
    log: true,
    autoMine: true,
  });

  await deploy("TokenB", {
    contract: "MockERC20",
    from: deployer,
    proxy: {
      execute: {
        methodName: "initialize",
        args: ["Token B", "TOKENB"],
      },
    },
    log: true,
    autoMine: true,
  });
};

func.skip = async (hre: HardhatRuntimeEnvironment) => {
  const shouldSkip =
    hre.network.name === "mainnet" || hre.network.name === "goerli";
  return shouldSkip ? true : false;
};

func.tags = ["MockERC20", "local"];

export default func;
