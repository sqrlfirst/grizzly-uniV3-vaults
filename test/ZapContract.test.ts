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
  ZapContract,
} from "../typechain";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

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
  let grizzlyVault: GrizzlyVault;
  let grizzlyFactory: GrizzlyVaultFactory;
  let zapContract: ZapContract;

  let uniswapPoolAddress: string;
  let vaultAddress: string;

  let user: SignerWithAddress;
  let deployerGrizzly: string;
  let manager: string;

  before(async () => {
    const accounts = await getNamedAccounts();
    deployerGrizzly = accounts.deployer;
    manager = accounts.manager;
    user = (await ethers.getSigners())[2];
  });

  beforeEach(async () => {
    // We connect to Uniswap v3 on Mainnet
    uniswapFactory = (await ethers.getContractAt(
      "IUniswapV3Factory",
      UNISWAP_ADDRESS
    )) as IUniswapV3Factory;

    // We load the deployment fixtures of hardhat-deploy
    await deployments.fixture(["local"]);
    grizzlyCoreVault = await ethers.getContract(
      "GrizzlyVault",
      deployerGrizzly
    );
    grizzlyFactory = await ethers.getContract(
      "GrizzlyVaultFactory",
      deployerGrizzly
    );
    zapContract = await ethers.getContract("ZapContract", user);

    token0 = await ethers.getContract("Token0", deployerGrizzly);
    token1 = await ethers.getContract("Token1", deployerGrizzly);

    // We charge user account with some tokens
    token0.transfer(user.address, ethers.utils.parseEther("10"));
    token1.transfer(user.address, ethers.utils.parseEther("10"));

    // Sort token0 & token1 so it follows the same order as Uniswap & the GrizzlyVaultFactory
    if (BigNumber.from(token0.address).gt(BigNumber.from(token1.address))) {
      const tmp = token0;
      token0 = token1;
      token1 = tmp;
    }
  });

  // describe("Creates a pool", () => {
  //   it("Should correctly clone a pool ", async () => {
  //     expect(await grizzlyFactory.numVaults(deployerGrizzly)).to.be.eq(
  //       BigNumber.from(0)
  //     );
  //     await grizzlyFactory.cloneGrizzlyVault(
  //       token0.address,
  //       token1.address,
  //       3000,
  //       0,
  //       -887220,
  //       887220,
  //       manager
  //     );
  //     expect(await grizzlyFactory.numVaults(deployerGrizzly)).to.be.eq(
  //       BigNumber.from(1)
  //     );
  //   });
  // });
  describe("ZapIn in a balanced small pool", () => {
    beforeEach(async () => {
      // We create a UniswapV3 pool with the mock tokens
      await uniswapFactory.createPool(token0.address, token1.address, "3000");
      uniswapPoolAddress = await uniswapFactory.getPool(
        token0.address,
        token1.address,
        "3000" // 0.3%
      );

      uniswapPool = (await ethers.getContractAt(
        "IUniswapV3Pool",
        uniswapPoolAddress
      )) as IUniswapV3Pool;

      await uniswapPool.initialize(encodePriceSqrt("1", "1"));
      await uniswapPool.increaseObservationCardinalityNext("5");

      // We create a Grizzly vault
      await grizzlyFactory.cloneGrizzlyVault(
        token0.address,
        token1.address,
        3000,
        0,
        -887220,
        887220,
        manager
      );

      vaultAddress = (await grizzlyFactory.getVaults(deployerGrizzly))[0];

      grizzlyVault = await ethers.getContractAt("GrizzlyVault", vaultAddress);
    });
    describe("Reverts ZapIn when not correctly done", () => {
      it("Should revert ZapIn when vault and pool do not correspond", async () => {
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("0");
        const maxSwapSlippage = BigNumber.from(10); // 0.1%

        expect(
          zapContract.zapIn(
            ethers.constants.AddressZero,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("wrong pool");
      });

      it("Should revert ZapIn when token not approved", async () => {
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("0");
        const maxSwapSlippage = BigNumber.from(10); // 0.1%

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });

      it("Should revert ZapIn when pool has no funds", async () => {
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("0");
        const maxSwapSlippage = BigNumber.from(10); // 0.1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("mint 0");
      });
    });
    describe("Reverts ZapIn when using out of range values", () => {
      beforeEach(async () => {
        // Deployer loads the pool with some tokens
        const amount0Max = ethers.utils.parseEther("100");
        const amount1Max = ethers.utils.parseEther("100");

        const amounts = await grizzlyVault.getMintAmounts(
          amount0Max,
          amount1Max
        );

        token0.approve(grizzlyVault.address, amounts.amount0);
        token1.approve(grizzlyVault.address, amounts.amount1);

        grizzlyVault.mint(amounts.mintAmount, deployerGrizzly);
      });

      it("Should revert ZapIn when not enough allowance", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("10");
        const amount1Desired = ethers.utils.parseEther("10");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            ethers.utils.parseEther("11"),
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("ERC20: insufficient allowance");

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            ethers.utils.parseEther("11"),
            maxSwapSlippage
          )
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });

      it("Should revert ZapIn when price gets out of liquidity range", async () => {
        // We charge user account with more tokens
        token0.transfer(user.address, ethers.utils.parseEther("100"));
        token1.transfer(user.address, ethers.utils.parseEther("100"));

        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("100");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(1000000); // 100%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("SPL");

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount1Desired,
            amount0Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("SPL");
      });
    });
    describe("Correctly ZapIn with different amounts", () => {
      beforeEach(async () => {
        // Deployer loads the pool with some tokens
        const amount0Max = ethers.utils.parseEther("100");
        const amount1Max = ethers.utils.parseEther("100");

        const amounts = await grizzlyVault.getMintAmounts(
          amount0Max,
          amount1Max
        );

        token0.approve(grizzlyVault.address, amounts.amount0);
        token1.approve(grizzlyVault.address, amounts.amount1);

        grizzlyVault.mint(amounts.mintAmount, deployerGrizzly);
      });

      it("Should ZapIn when user gives token0 = token 1 > 0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("0.999999999999999999");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("9.000000000000000001")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("9.000000000000000001")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn when user gives token0 > 0 = token1", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("0");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);

        const mintAmount = ethers.utils.parseEther("0.496770988574267262");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("9.001497753369945084")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("10.000977515753211757")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn when user gives token1 > 0 = token0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("0");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("0.496770988574267262");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("10.000977515753211757")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("9.001497753369945084")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn when user gives token0 > token1 > 0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("2");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("1.491803278688524589");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("8.001497753369945083")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("9.010873501734693138")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn when user gives token1 > token0 > 0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("4.2");
        const amount1Desired = ethers.utils.parseEther("10");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("5.151340615690168819");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("5.889761766643397209")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("3.793981945837512535")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn with default slipagge if maxSwapSlippage = 0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("10");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(0);

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("1.496481998766317457");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("7.991950726551513837")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("9.01100041122751413")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });
    });
  });
  describe("ZapIn in an unbalanced small pool", () => {
    beforeEach(async () => {
      // We create a UniswapV3 pool with the mock tokens
      await uniswapFactory.createPool(token0.address, token1.address, "3000");
      uniswapPoolAddress = await uniswapFactory.getPool(
        token0.address,
        token1.address,
        "10000" // 1%
      );

      uniswapPool = (await ethers.getContractAt(
        "IUniswapV3Pool",
        uniswapPoolAddress
      )) as IUniswapV3Pool;

      await uniswapPool.initialize(encodePriceSqrt("1", "1"));
      await uniswapPool.increaseObservationCardinalityNext("5");

      // We create a Grizzly vault
      await grizzlyFactory.cloneGrizzlyVault(
        token0.address,
        token1.address,
        10000,
        0,
        -887220,
        887220,
        manager
      );

      vaultAddress = (await grizzlyFactory.getVaults(deployerGrizzly))[0];

      grizzlyVault = await ethers.getContractAt("GrizzlyVault", vaultAddress);
    });
    describe("Reverts ZapIn when not correctly done", () => {
      it("Should revert ZapIn when vault and pool do not correspond", async () => {
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("0");
        const maxSwapSlippage = BigNumber.from(10); // 0.1%

        expect(
          zapContract.zapIn(
            ethers.constants.AddressZero,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("wrong pool");
      });

      it("Should revert ZapIn when token not approved", async () => {
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("0");
        const maxSwapSlippage = BigNumber.from(10); // 0.1%

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });

      it("Should revert ZapIn when pool has no funds", async () => {
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("0");
        const maxSwapSlippage = BigNumber.from(10); // 0.1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("mint 0");
      });
    });
    describe("Reverts ZapIn when using out of range values", () => {
      beforeEach(async () => {
        // Deployer loads the pool with some tokens
        const amount0Max = ethers.utils.parseEther("100");
        const amount1Max = ethers.utils.parseEther("100");

        const amounts = await grizzlyVault.getMintAmounts(
          amount0Max,
          amount1Max
        );

        token0.approve(grizzlyVault.address, amounts.amount0);
        token1.approve(grizzlyVault.address, amounts.amount1);

        grizzlyVault.mint(amounts.mintAmount, deployerGrizzly);
      });

      it("Should revert ZapIn when not enough allowance", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("10");
        const amount1Desired = ethers.utils.parseEther("10");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            ethers.utils.parseEther("11"),
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("ERC20: insufficient allowance");

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            ethers.utils.parseEther("11"),
            maxSwapSlippage
          )
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });

      it("Should revert ZapIn when price gets out of liquidity range", async () => {
        // We charge user account with more tokens
        token0.transfer(user.address, ethers.utils.parseEther("100"));
        token1.transfer(user.address, ethers.utils.parseEther("100"));

        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("100");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(1000000); // 100%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("SPL");

        expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount1Desired,
            amount0Desired,
            maxSwapSlippage
          )
        ).to.be.revertedWith("SPL");
      });

      // it("Should ZapIn when user gives token1 > token0 > 0", async () => {
      //   // We let user to ZapIn
      //   const amount0Desired = ethers.utils.parseEther("1");
      //   const amount1Desired = ethers.utils.parseEther("1");
      //   const maxSwapSlippage = BigNumber.from(1000000); // 100%

      //   await token0.connect(user).approve(zapContract.address, amount0Desired);
      //   await token1.connect(user).approve(zapContract.address, amount1Desired);

      //   const mintAmount = ethers.utils.parseEther("5.151340615690168819");

      //   await zapContract.zapIn(
      //     uniswapPoolAddress,
      //     vaultAddress,
      //     amount0Desired,
      //     amount1Desired,
      //     maxSwapSlippage
      //   );

      //   // await expect(
      //   //   zapContract.zapIn(
      //   //     uniswapPoolAddress,
      //   //     vaultAddress,
      //   //     amount0Desired,
      //   //     amount1Desired,
      //   //     maxSwapSlippage
      //   //   )
      //   // )
      //   //   .to.emit(zapContract, "ZapInVault")
      //   //   .withArgs(user.address, vaultAddress, mintAmount);

      //   // We check token balances after zap
      //   const balance0After = await token0.balanceOf(user.address);
      //   const balance1After = await token1.balanceOf(user.address);
      //   const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

      //   // expect(balance0After).to.be.eq(
      //   //   ethers.utils.parseEther("5.889761766643397209")
      //   // );
      //   // expect(balance1After).to.be.eq(
      //   //   ethers.utils.parseEther("3.793981945837512535")
      //   // );
      //   //expect(balanceTokenVault).to.be.eq(mintAmount);
      //   console.log("BALANCE 0 AFTER", ethers.utils.formatEther(balance0After));
      //   console.log("BALANCE 1 AFTER", ethers.utils.formatEther(balance1After));
      // });
    });
    describe("Correctly ZapIn with different amounts", () => {
      beforeEach(async () => {
        // Deployer loads the pool with some tokens
        const amount0Max = ethers.utils.parseEther("100");
        const amount1Max = ethers.utils.parseEther("100");

        const amounts = await grizzlyVault.getMintAmounts(
          amount0Max,
          amount1Max
        );

        token0.approve(grizzlyVault.address, amounts.amount0);
        token1.approve(grizzlyVault.address, amounts.amount1);

        grizzlyVault.mint(amounts.mintAmount, deployerGrizzly);
      });

      it("Should ZapIn when user gives token0 = token 1 > 0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("0.999999999999999999");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("9.000000000000000001")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("9.000000000000000001")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn when user gives token0 > 0 = token1", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("1");
        const amount1Desired = ethers.utils.parseEther("0");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);

        const mintAmount = ethers.utils.parseEther("0.496770988574267262");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("9.001497753369945084")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("10.000977515753211757")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn when user gives token1 > 0 = token0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("0");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("0.496770988574267262");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("10.000977515753211757")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("9.001497753369945084")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn when user gives token0 > token1 > 0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("2");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("1.491803278688524589");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("8.001497753369945083")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("9.010873501734693138")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn when user gives token1 > token0 > 0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("4.2");
        const amount1Desired = ethers.utils.parseEther("10");
        const maxSwapSlippage = BigNumber.from(10000); // 1%

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("5.151340615690168819");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("5.889761766643397209")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("3.793981945837512535")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });

      it("Should ZapIn with default slipagge if maxSwapSlippage = 0", async () => {
        // We let user to ZapIn
        const amount0Desired = ethers.utils.parseEther("10");
        const amount1Desired = ethers.utils.parseEther("1");
        const maxSwapSlippage = BigNumber.from(0);

        await token0.connect(user).approve(zapContract.address, amount0Desired);
        await token1.connect(user).approve(zapContract.address, amount1Desired);

        const mintAmount = ethers.utils.parseEther("1.496481998766317457");

        await expect(
          zapContract.zapIn(
            uniswapPoolAddress,
            vaultAddress,
            amount0Desired,
            amount1Desired,
            maxSwapSlippage
          )
        )
          .to.emit(zapContract, "ZapInVault")
          .withArgs(user.address, vaultAddress, mintAmount);

        // We check token balances after zap
        const balance0After = await token0.balanceOf(user.address);
        const balance1After = await token1.balanceOf(user.address);
        const balanceTokenVault = await grizzlyVault.balanceOf(user.address);

        expect(balance0After).to.be.eq(
          ethers.utils.parseEther("7.991950726551513837")
        );
        expect(balance1After).to.be.eq(
          ethers.utils.parseEther("9.01100041122751413")
        );
        expect(balanceTokenVault).to.be.eq(mintAmount);
      });
    });
  });
});
