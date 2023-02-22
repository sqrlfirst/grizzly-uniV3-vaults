import { deployments, getNamedAccounts } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log(`Deploying Vault Factory to ${hre.network.name}`);
  const grizzlyVault = await deployments.get("GrizzlyVault");

  await deploy("GrizzlyVaultFactory", {
    from: deployer,
    args: [grizzlyVault.address, deployer],
    log: true,
    autoMine: true,
  });
};

func.tags = ["Factory", "local", "mainnet"];
func.dependencies = ["Core"];

export default func;
