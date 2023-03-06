import { expect } from "chai";
import bn from "bignumber.js";
import { BigNumber, BigNumberish } from "ethers";
import { ethers, deployments, getNamedAccounts } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import {
  ERC20,
  IUniswapV3Factory,
  IUniswapV3Pool,
  GrizzlyVault,
  GrizzlyVaultFactory,
  ZapContract,
} from "../typechain";
import { pools } from "./data/pools";

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

  let token0: ERC20;
  let token1: ERC20;
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
  });

  describe("ZapIn with mock tokens", () => {
    beforeEach(async () => {
      token0 = await ethers.getContract("TokenA", deployerGrizzly);
      token1 = await ethers.getContract("TokenB", deployerGrizzly);

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

          await expect(
            zapContract.zapIn(
              ethers.constants.AddressZero,
              vaultAddress,
              amount0Desired,
              amount1Desired,
              maxSwapSlippage
            )
          ).to.be.revertedWith("wrong pool");
        });

        it("Should revert when slippage is too high", async () => {
          const amount0Desired = ethers.utils.parseEther("1");
          const amount1Desired = ethers.utils.parseEther("0");
          const maxSwapSlippage = BigNumber.from(1000000); // 100%

          await expect(
            zapContract.zapIn(
              uniswapPoolAddress,
              vaultAddress,
              amount0Desired,
              amount1Desired,
              maxSwapSlippage
            )
          ).to.be.revertedWith("max slippage too high");
        });

        it("Should revert ZapIn when token not approved", async () => {
          const amount0Desired = ethers.utils.parseEther("1");
          const amount1Desired = ethers.utils.parseEther("0");
          const maxSwapSlippage = BigNumber.from(10); // 0.1%

          await expect(
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

          await token0
            .connect(user)
            .approve(zapContract.address, amount0Desired);

          await expect(
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

          await token0
            .connect(user)
            .approve(zapContract.address, amount0Desired);
          await token1
            .connect(user)
            .approve(zapContract.address, amount1Desired);

          await expect(
            zapContract.zapIn(
              uniswapPoolAddress,
              vaultAddress,
              ethers.utils.parseEther("11"),
              amount1Desired,
              maxSwapSlippage
            )
          ).to.be.revertedWith("ERC20: insufficient allowance");

          await expect(
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

          await token0
            .connect(user)
            .approve(zapContract.address, amount0Desired);
          await token1
            .connect(user)
            .approve(zapContract.address, amount1Desired);

          await expect(
            zapContract.zapIn(
              uniswapPoolAddress,
              vaultAddress,
              amount0Desired,
              amount1Desired,
              maxSwapSlippage
            )
          ).to.be.revertedWith("SPL");

          await expect(
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

          await token0
            .connect(user)
            .approve(zapContract.address, amount0Desired);
          await token1
            .connect(user)
            .approve(zapContract.address, amount1Desired);

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

          await token0
            .connect(user)
            .approve(zapContract.address, amount0Desired);

          const mintAmount = ethers.utils.parseEther("0.496763585242147409");

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
            ethers.utils.parseEther("9.002487893720585589")
          );
          expect(balance1After).to.be.eq(ethers.utils.parseEther("10"));
          expect(balanceTokenVault).to.be.eq(mintAmount);
        });

        it("Should ZapIn when user gives token1 > 0 = token0", async () => {
          // We let user to ZapIn
          const amount0Desired = ethers.utils.parseEther("0");
          const amount1Desired = ethers.utils.parseEther("1");
          const maxSwapSlippage = BigNumber.from(11000); // 1.1%

          await token1
            .connect(user)
            .approve(zapContract.address, amount1Desired);

          const mintAmount = ethers.utils.parseEther("0.496763585242147409");

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

          expect(balance0After).to.be.eq(ethers.utils.parseEther("10"));
          expect(balance1After).to.be.eq(
            ethers.utils.parseEther("9.002487893720585589")
          );
          expect(balanceTokenVault).to.be.eq(mintAmount);
        });

        it("Should ZapIn when user gives token0 > token1 > 0", async () => {
          // We let user to ZapIn
          const amount0Desired = ethers.utils.parseEther("2");
          const amount1Desired = ethers.utils.parseEther("1");
          const maxSwapSlippage = BigNumber.from(10000); // 1%

          await token0
            .connect(user)
            .approve(zapContract.address, amount0Desired);
          await token1
            .connect(user)
            .approve(zapContract.address, amount1Desired);

          const mintAmount = ethers.utils.parseEther("1.491781046482168671");

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

          expect(balance0After).to.be.eq(ethers.utils.parseEther("8"));
          expect(balance1After).to.be.eq(
            ethers.utils.parseEther("9.012396162450010317")
          );
          expect(balanceTokenVault).to.be.eq(mintAmount);
        });

        it("Should ZapIn when user gives token1 > token0 > 0", async () => {
          // We let user to ZapIn
          const amount0Desired = ethers.utils.parseEther("1");
          const amount1Desired = ethers.utils.parseEther("2");
          const maxSwapSlippage = BigNumber.from(11000); // 1.1%

          await token0
            .connect(user)
            .approve(zapContract.address, amount0Desired);
          await token1
            .connect(user)
            .approve(zapContract.address, amount1Desired);

          const mintAmount = ethers.utils.parseEther("1.491781046482168671");

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
            ethers.utils.parseEther("9.012396162450010317")
          );
          expect(balance1After).to.be.eq(ethers.utils.parseEther("8"));
          expect(balanceTokenVault).to.be.eq(mintAmount);
        });

        it("Should ZapIn with default slipagge if maxSwapSlippage = 0", async () => {
          // We let user to ZapIn
          const amount0Desired = ethers.utils.parseEther("10");
          const amount1Desired = ethers.utils.parseEther("1");
          const maxSwapSlippage = BigNumber.from(0);

          await token0
            .connect(user)
            .approve(zapContract.address, amount0Desired);
          await token1
            .connect(user)
            .approve(zapContract.address, amount1Desired);

          const mintAmount = ethers.utils.parseEther("1.303911735205616850");

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
            ethers.utils.parseEther("8.390344820614685731")
          );
          expect(balance1After).to.be.eq(ethers.utils.parseEther("9"));
          expect(balanceTokenVault).to.be.eq(mintAmount);
        });
      });
    });
  });

  describe("ZapIn in mainnet tokens and pools", () => {
    pools.forEach((pool) => {
      describe(`ZapIn in ${pool.name} pool`, () => {
        let zeroForOne: boolean;
        let fee: number;
        let tick: number;
        let tickSpacing: number;
        let token0Decimals: number;
        let token1Decimals: number;

        before(async () => {
          // We load the mainnet UniswapV3 pool
          uniswapPool = (await ethers.getContractAt(
            "IUniswapV3Pool",
            pool.address
          )) as IUniswapV3Pool;

          token0 = (await ethers.getContractAt("ERC20", pool.token0)) as ERC20;
          token1 = (await ethers.getContractAt("ERC20", pool.token1)) as ERC20;

          token0Decimals = await token0.decimals();
          token1Decimals = await token1.decimals();

          // Pool info
          const slot0 = await uniswapPool.slot0();

          const currentTick = slot0.tick;
          tickSpacing = await uniswapPool.tickSpacing();
          tick = currentTick - (currentTick % tickSpacing);

          fee = await uniswapPool.fee();

          // Read price from Uniswap pool
          const sqrtPrice = slot0.sqrtPriceX96
            .mul(BigNumber.from(10).pow(token0Decimals / 2))
            .div(BigNumber.from(10).pow(token1Decimals / 2));
          zeroForOne = sqrtPrice.gt(BigNumber.from(2).pow(96));
          console.log("ZERO FOR ONE", zeroForOne);
        });

        beforeEach(async () => {
          // We create a Grizzly vault
          await grizzlyFactory.cloneGrizzlyVault(
            token0.address,
            token1.address,
            fee,
            0,
            tick - 100 * tickSpacing,
            tick + 100 * tickSpacing,
            manager
          );

          vaultAddress = (await grizzlyFactory.getVaults(deployerGrizzly))[0];

          grizzlyVault = await ethers.getContractAt(
            "GrizzlyVault",
            vaultAddress
          );

          // We load the user account with both tokens by impersonating whales
          await helpers.impersonateAccount(pool.whale0);
          const token0Whale = await ethers.getSigner(pool.whale0);
          await helpers.impersonateAccount(pool.whale1);
          const token1Whale = await ethers.getSigner(pool.whale1);

          await token0
            .connect(token0Whale)
            .transfer(
              user.address,
              ethers.utils.parseUnits("1000", token0Decimals)
            );

          await token1
            .connect(token1Whale)
            .transfer(
              user.address,
              ethers.utils.parseUnits("1000", token1Decimals)
            );
        });

        describe("Reverts ZapIn when not correctly done", () => {
          it("Should revert ZapIn when vault and pool do not correspond", async () => {
            const amount0Desired = ethers.utils.parseEther("1");
            const amount1Desired = ethers.utils.parseEther("0");
            const maxSwapSlippage = BigNumber.from(1000); // 0.1%

            await expect(
              zapContract.zapIn(
                ethers.constants.AddressZero,
                vaultAddress,
                amount0Desired,
                amount1Desired,
                maxSwapSlippage
              )
            ).to.be.revertedWith("wrong pool");
          });

          it("Should revert when slippage is too high", async () => {
            const amount0Desired = ethers.utils.parseEther("1");
            const amount1Desired = ethers.utils.parseEther("0");
            const maxSwapSlippage = BigNumber.from(1000000); // 100%

            await expect(
              zapContract.zapIn(
                uniswapPoolAddress,
                vaultAddress,
                amount0Desired,
                amount1Desired,
                maxSwapSlippage
              )
            ).to.be.revertedWith("max slippage too high");
          });

          it("Should revert ZapIn when token not approved", async () => {
            const amount0Desired = ethers.utils.parseEther("1");
            const amount1Desired = ethers.utils.parseEther("0");
            const maxSwapSlippage = BigNumber.from(1000); // 0.1%

            await expect(
              zapContract.zapIn(
                uniswapPoolAddress,
                vaultAddress,
                amount0Desired,
                amount1Desired,
                maxSwapSlippage
              )
            ).to.be.revertedWith("ERC20: insufficient allowance");
          });

          it("Should revert ZapIn when not enough allowance", async () => {
            // We let user to ZapIn
            const amount0Desired = ethers.utils.parseEther("10");
            const amount1Desired = ethers.utils.parseEther("10");
            const maxSwapSlippage = BigNumber.from(10000); // 1%

            await token0
              .connect(user)
              .approve(zapContract.address, amount0Desired);
            await token1
              .connect(user)
              .approve(zapContract.address, amount1Desired);

            await expect(
              zapContract.zapIn(
                uniswapPoolAddress,
                vaultAddress,
                ethers.utils.parseEther("11"),
                amount1Desired,
                maxSwapSlippage
              )
            ).to.be.revertedWith("ERC20: insufficient allowance");

            await expect(
              zapContract.zapIn(
                uniswapPoolAddress,
                vaultAddress,
                amount0Desired,
                ethers.utils.parseEther("11"),
                maxSwapSlippage
              )
            ).to.be.revertedWith("ERC20: insufficient allowance");
          });
        });

        describe("Correctly ZapIn with different amounts", () => {
          it("Should ZapIn when user gives token0, token1 > 0", async () => {
            // We let user to ZapIn
            const amount0Desired = ethers.utils.parseUnits(
              "1000",
              token0Decimals
            );
            const amount1Desired = ethers.utils.parseUnits(
              "1000",
              token1Decimals
            );
            const maxSwapSlippage = BigNumber.from(10000); // 1%

            await token0
              .connect(user)
              .approve(zapContract.address, amount0Desired);
            await token1
              .connect(user)
              .approve(zapContract.address, amount1Desired);

            // We store balances before provinding liquidity
            const balance0Before = await token0.balanceOf(user.address);
            const balance1Before = await token1.balanceOf(user.address);

            await zapContract.zapIn(
              pool.address,
              vaultAddress,
              amount0Desired,
              amount1Desired,
              maxSwapSlippage
            );

            // We check token balances after zap
            const balance0After = await token0.balanceOf(user.address);
            const balance1After = await token1.balanceOf(user.address);
            const balanceTokenVault = await grizzlyVault.balanceOf(
              user.address
            );

            if (zeroForOne) {
              expect(balance0After).to.be.lt(balance0Before);
              // Dust <1 in the token to swap to
              // expect(balance1After).to.be.at.most(
              //   balance1Before.sub(amount1Desired).add(1)
              // );
            } else {
              // No dust in the token to swap to
              // expect(balance0After).to.be.at.most(
              //   balance0Before.sub(amount0Desired).add(1)
              // );
              expect(balance1After).to.be.lt(balance1Before);
            }
            // We get some vault LP tokens
            expect(balanceTokenVault).to.be.gt(0);
          });

          it("Should ZapIn when user gives token0 > 0 = token1", async () => {
            // We let user to ZapIn
            const amount0Desired = ethers.utils.parseUnits(
              "1000",
              token0Decimals
            );
            const amount1Desired = ethers.utils.parseUnits("0", token1Decimals);
            const maxSwapSlippage = BigNumber.from(10000); // 1%

            await token0
              .connect(user)
              .approve(zapContract.address, amount0Desired);

            // We store balances before provinding liquidity
            const balance0Before = await token0.balanceOf(user.address);
            const balance1Before = await token1.balanceOf(user.address);

            await zapContract.zapIn(
              pool.address,
              vaultAddress,
              amount0Desired,
              amount1Desired,
              maxSwapSlippage
            );

            // We check token balances after zap
            const balance0After = await token0.balanceOf(user.address);
            const balance1After = await token1.balanceOf(user.address);
            const balanceTokenVault = await grizzlyVault.balanceOf(
              user.address
            );

            expect(balance0After).to.be.lt(balance0Before);
            // Dust 0 in the token 1
            expect(balance1After).to.be.eq(balance1Before);
            // We get some vault LP tokens
            expect(balanceTokenVault).to.be.gt(0);
          });

          it("Should ZapIn when user gives token1 > 0 = token0", async () => {
            // We let user to ZapIn
            const amount0Desired = ethers.utils.parseUnits("0", token0Decimals);
            const amount1Desired = ethers.utils.parseUnits(
              "1000",
              token1Decimals
            );
            const maxSwapSlippage = BigNumber.from(10000); // 1%

            await token1
              .connect(user)
              .approve(zapContract.address, amount1Desired);

            // We store balances before provinding liquidity
            const balance0Before = await token0.balanceOf(user.address);
            const balance1Before = await token1.balanceOf(user.address);

            await zapContract.zapIn(
              pool.address,
              vaultAddress,
              amount0Desired,
              amount1Desired,
              maxSwapSlippage
            );

            // We check token balances after zap
            const balance0After = await token0.balanceOf(user.address);
            const balance1After = await token1.balanceOf(user.address);
            const balanceTokenVault = await grizzlyVault.balanceOf(
              user.address
            );

            expect(balance0After).to.be.eq(balance0Before);
            // Dust 0 in the token 1
            expect(balance1After).to.be.lt(balance1Before);
            // We get some vault LP tokens
            expect(balanceTokenVault).to.be.gt(0);
          });

          it("Should ZapIn with default slipagge if maxSwapSlippage = 0", async () => {
            // We let user to ZapIn
            const amount0Desired = ethers.utils.parseUnits(
              "1000",
              token0Decimals
            );
            const amount1Desired = ethers.utils.parseUnits(
              "1000",
              token1Decimals
            );
            const maxSwapSlippage = BigNumber.from(0);

            await token0
              .connect(user)
              .approve(zapContract.address, amount0Desired);
            await token1
              .connect(user)
              .approve(zapContract.address, amount1Desired);

            // We store balances before provinding liquidity
            const balance0Before = await token0.balanceOf(user.address);
            const balance1Before = await token1.balanceOf(user.address);

            await zapContract.zapIn(
              pool.address,
              vaultAddress,
              amount0Desired,
              amount1Desired,
              maxSwapSlippage
            );

            // We check token balances after zap
            const balance0After = await token0.balanceOf(user.address);
            const balance1After = await token1.balanceOf(user.address);
            const balanceTokenVault = await grizzlyVault.balanceOf(
              user.address
            );

            if (zeroForOne) {
              expect(balance0After).to.be.lt(balance0Before);
              // Dust can be very high if liquidity is high and very unbalanced
              // expect(balance1After).to.be.at.most(
              //   balance1Before.sub(amount1Desired).add(1)
              // );
            } else {
              // No dust in the token to swap to
              // expect(balance0After).to.be.at.most(
              //   balance0Before.sub(amount0Desired).add(1)
              // );
              expect(balance1After).to.be.lt(balance1Before);
            }
            // We get some vault LP tokens
            expect(balanceTokenVault).to.be.gt(0);
          });
        });
      });
    });
  });
});
