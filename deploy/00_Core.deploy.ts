import { deployments, getNamedAccounts } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log(`Deploying Core Vault and Zap to ${hre.network.name}...`);
  await deploy("GrizzlyVault", {
    from: deployer,
    log: true,
    autoMine: true,
  });
  await deploy("ZapContract", {
    from: deployer,
    log: true,
    autoMine: true,
  });

  console.log(`Initializing Core Vault and Zap...`);
};

func.tags = ["Core", "local", "mainnet"];

export default func;
