import { expect } from "chai";
import bn from "bignumber.js";
import { BigNumber, BigNumberish } from "ethers";
import { ethers, deployments, getNamedAccounts } from "hardhat";
import {
  IERC20,
  IUniswapV3Factory,
  IUniswapV3Pool,
  GrizzlyVault,
  GrizzlyVaultFactory,
} from "../typechain";

bn.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 });

// returns the sqrt price as a 64x96
export function encodePriceSqrt(
  reserve1: BigNumberish,
  reserve0: BigNumberish
): BigNumber {
  return BigNumber.from(
    new bn(reserve1.toString())
      .div(reserve0.toString())
      .sqrt()
      .multipliedBy(new bn(2).pow(96))
      .integerValue(3)
      .toString()
  );
}

describe("ZapContract", () => {
  const UNISWAP_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
  let uniswapFactory: IUniswapV3Factory;
  let uniswapPool: IUniswapV3Pool;

  let token0: IERC20;
  let token1: IERC20;
  let grizzlyCoreVault: GrizzlyVault;
  let grizzlyFactory: GrizzlyVaultFactory;
  let uniswapPoolAddress: string;

  let user: string;
  let deployerGrizzly: string;
  let manager: string;

  before(async () => {
    const accounts = await getNamedAccounts();
    deployerGrizzly = accounts.deployer;
    manager = accounts.manager;
  });

  beforeEach(async () => {
    // We connect to Uniswap v3 on Mainnet
    uniswapFactory = (await ethers.getContractAt(
      "IUniswapV3Factory",
      UNISWAP_ADDRESS
    )) as IUniswapV3Factory;

    // We load the deplyment fixtures
    await deployments.fixture(["local"]);
    grizzlyCoreVault = await ethers.getContract(
      "GrizzlyVault",
      deployerGrizzly
    );
    grizzlyFactory = await ethers.getContract(
      "GrizzlyVaultFactory",
      deployerGrizzly
    );

    token0 = await ethers.getContract("Token0", deployerGrizzly);
    token1 = await ethers.getContract("Token1", deployerGrizzly);

    // Sort token0 & token1 so it follows the same order as Uniswap & the GrizzlyVaultFactory
    if (BigNumber.from(token0.address).gt(BigNumber.from(token1.address))) {
      const tmp = token0;
      token0 = token1;
      token1 = tmp;
    }

    // We create a UniswapV3 pool with the mock tokens
    await uniswapFactory.createPool(token0.address, token1.address, "3000");
    uniswapPoolAddress = await uniswapFactory.getPool(
      token0.address,
      token1.address,
      "3000"
    );

    uniswapPool = (await ethers.getContractAt(
      "IUniswapV3Pool",
      uniswapPoolAddress
    )) as IUniswapV3Pool;

    await uniswapPool.initialize(encodePriceSqrt("1", "1"));
    await uniswapPool.increaseObservationCardinalityNext("5");
  });

  describe("Creates a pool", () => {
    it("Should correctly clone a pool ", async () => {
      expect(await grizzlyFactory.numVaults(deployerGrizzly)).to.be.eq(
        BigNumber.from(0)
      );
      await grizzlyFactory.cloneGrizzlyVault(
        token0.address,
        token1.address,
        3000,
        0,
        -887220,
        887220,
        manager
      );
      expect(await grizzlyFactory.numVaults(deployerGrizzly)).to.be.eq(
        BigNumber.from(1)
      );
    });
  });
});
