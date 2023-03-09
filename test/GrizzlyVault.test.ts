import { expect } from "chai";
import bn from "bignumber.js";
import { BigNumber, BigNumberish } from "ethers";
import { ethers, deployments } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

import {
  IERC20,
  IUniswapV3Factory,
  IUniswapV3Pool,
  GrizzlyVault,
  GrizzlyVaultFactory,
  SwapTest,
  ERC20Upgradeable,
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

describe("Grizzly Vault Contracts", () => {
  const UNISWAP_ADDRESS = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
  let uniswapFactory: IUniswapV3Factory;
  let uniswapPool: IUniswapV3Pool;

  let token0: ERC20Upgradeable;
  let token1: ERC20Upgradeable;
  let grizzlyCoreVault: GrizzlyVault;
  let grizzlyVault: GrizzlyVault;
  let grizzlyFactory: GrizzlyVaultFactory;
  let swapTest: SwapTest;

  let uniswapPoolAddress: string;
  let vaultAddress: string;
  let tokenName: string;

  let deployerGrizzly: SignerWithAddress;
  let manager: SignerWithAddress;
  let user: SignerWithAddress;
  let bot: SignerWithAddress;

  before(async () => {
    [deployerGrizzly, manager, user, bot] = await ethers.getSigners();

    await deployments.fixture(["local"]);
    swapTest = await ethers.getContract("SwapTest", deployerGrizzly);
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
  });

  describe("Test with mock tokens", () => {
    beforeEach(async () => {
      token0 = await ethers.getContract("TokenA", deployerGrizzly);
      token1 = await ethers.getContract("TokenB", deployerGrizzly);

      // We charge user account with some tokens
      token0.transfer(user.address, ethers.utils.parseEther("100"));
      token1.transfer(user.address, ethers.utils.parseEther("100"));

      // We increase allowance of swapTest
      await token0.approve(
        swapTest.address,
        ethers.utils.parseEther("10000000000000")
      );
      await token1.approve(
        swapTest.address,
        ethers.utils.parseEther("10000000000000")
      );

      // Sort token0 & token1 so it follows the same order as Uniswap & the GrizzlyVaultFactory
      if (BigNumber.from(token0.address).gt(BigNumber.from(token1.address))) {
        const tmp = token0;
        token0 = token1;
        token1 = tmp;
        tokenName = "TOKENB/TOKENA";
      } else {
        tokenName = "TOKENA/TOKENB";
      }

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
        manager.address
      );

      vaultAddress = (
        await grizzlyFactory.getVaults(deployerGrizzly.address)
      )[0];

      grizzlyVault = await ethers.getContractAt("GrizzlyVault", vaultAddress);
    });

    describe("Grizzly Vault Factory", () => {
      describe("External view functions", () => {
        it("Should get Token Name", async () => {
          const lpTokenName = await grizzlyFactory.getTokenName(
            token0.address,
            token1.address
          );
          expect(lpTokenName).to.be.eq(`Grizzly Uniswap ${tokenName} LP`);
        });
        it("Should get Grizzly vaults", async () => {
          await grizzlyFactory
            .connect(user)
            .cloneGrizzlyVault(
              token0.address,
              token1.address,
              3000,
              0,
              -887220,
              887220,
              manager.address
            );

          const vaults = await grizzlyFactory.getGrizzlyVaults();
          expect(vaults.length).to.be.eq(1);
          expect(vaults[0]).to.be.eq(grizzlyVault.address);
        });
        it("Should get vaults", async () => {
          const tx = await grizzlyFactory
            .connect(user)
            .cloneGrizzlyVault(
              token0.address,
              token1.address,
              3000,
              0,
              -887220,
              887220,
              manager.address
            );

          const receipt = await tx.wait();
          const events = receipt.events?.filter((x) => {
            return x.event == "VaultCreated";
          });
          if (!events) {
            throw new Error("No events when vault created");
          }
          const newVaultAddress = events[0].args?.vault;

          const vaults = await grizzlyFactory.getVaults(user.address);
          expect(vaults.length).to.be.eq(1);
          expect(vaults[0]).to.be.eq(newVaultAddress);
        });
        it("Should get number of vaults", async () => {
          await grizzlyFactory
            .connect(user)
            .cloneGrizzlyVault(
              token0.address,
              token1.address,
              3000,
              0,
              -887220,
              887220,
              manager.address
            );

          const nVaults = await grizzlyFactory.numVaults(user.address);
          expect(nVaults).to.be.eq(1);
        });
      });

      describe("Clone Grizzly Vault", () => {
        describe("Reverts with wrong parameters", () => {
          it("Should revert when pool does not exist", async () => {
            await expect(
              grizzlyFactory.cloneGrizzlyVault(
                token0.address,
                token1.address,
                10000,
                0,
                -887220,
                887220,
                manager.address
              )
            ).to.be.revertedWith("uniV3Pool does not exist");
          });

          it("Should revert when pool tickspace is not correct", async () => {
            await expect(
              grizzlyFactory.cloneGrizzlyVault(
                token0.address,
                token1.address,
                3000,
                0,
                -88722,
                887220,
                manager.address
              )
            ).to.be.revertedWith("tickSpacing mismatch");
          });
        });

        describe("Clones a Grizzly Vault", () => {
          it("Should correctly clone a vault", async () => {
            expect(
              await grizzlyFactory.numVaults(deployerGrizzly.address)
            ).to.be.eq(BigNumber.from(1));
            await grizzlyFactory.cloneGrizzlyVault(
              token0.address,
              token1.address,
              3000,
              0,
              -887220,
              887220,
              manager.address
            );
            expect(
              await grizzlyFactory.numVaults(deployerGrizzly.address)
            ).to.be.eq(BigNumber.from(2));
          });
        });
      });

      describe("Set implementation vault", () => {
        it("Should revert with 0 address", async () => {
          await expect(
            grizzlyFactory.setImplementationVault(ethers.constants.AddressZero)
          ).to.be.revertedWith("zeroAddress");
        });

        it("Should revert when not owner", async () => {
          await expect(
            grizzlyFactory
              .connect(user)
              .setImplementationVault(grizzlyVault.address)
          ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should set new implementation vault correctly", async () => {
          // Check old implementation
          expect(await grizzlyFactory.implementation()).to.be.eq(
            grizzlyCoreVault.address
          );

          // Change implementation
          await expect(
            grizzlyFactory.setImplementationVault(grizzlyVault.address)
          )
            .to.emit(grizzlyFactory, "ImplementationVaultChanged")
            .withArgs(grizzlyVault.address, grizzlyCoreVault.address);

          // Check new implementation
          expect(await grizzlyFactory.implementation()).to.be.eq(
            grizzlyVault.address
          );
        });
      });
    });

    describe("Grizzly Vault", () => {
      describe("External view functions", () => {
        describe("Get mint amounts", () => {
          it("Should provide the right mint amounts without initial liquidity", async () => {
            const APROX_ONE = ethers.utils.parseEther("0.999999999999999999");
            const ONE = ethers.utils.parseEther("1");
            const ZERO = ethers.utils.parseEther("0");

            // Equal amounts
            let amount0Max = ethers.utils.parseEther("1");
            let amount1Max = ethers.utils.parseEther("1");

            let amounts = await grizzlyVault.getMintAmounts(
              amount0Max,
              amount1Max
            );

            expect(amounts.amount0).to.be.eq(APROX_ONE);
            expect(amounts.amount1).to.be.eq(APROX_ONE);
            expect(amounts.mintAmount).to.be.eq(ONE);

            // Unbalanced amounts with token0 > token1
            amount0Max = ethers.utils.parseEther("10");
            amount1Max = ethers.utils.parseEther("1");

            amounts = await grizzlyVault.getMintAmounts(amount0Max, amount1Max);

            expect(amounts.amount0).to.be.eq(APROX_ONE);
            expect(amounts.amount1).to.be.eq(APROX_ONE);
            expect(amounts.mintAmount).to.be.eq(ONE);

            // Unbalanced amounts with token1 > token0
            amount0Max = ethers.utils.parseEther("1");
            amount1Max = ethers.utils.parseEther("10");

            amounts = await grizzlyVault.getMintAmounts(amount0Max, amount1Max);

            expect(amounts.amount0).to.be.eq(APROX_ONE);
            expect(amounts.amount1).to.be.eq(APROX_ONE);
            expect(amounts.mintAmount).to.be.eq(ONE);

            // Unbalanced amounts with 0 balance token1
            amount0Max = ethers.utils.parseEther("1");
            amount1Max = ethers.utils.parseEther("0");

            amounts = await grizzlyVault.getMintAmounts(amount0Max, amount1Max);

            expect(amounts.amount0).to.be.eq(ZERO);
            expect(amounts.amount1).to.be.eq(ZERO);
            expect(amounts.mintAmount).to.be.eq(ZERO);

            // Unbalanced amounts with 0 balance token1
            amount0Max = ethers.utils.parseEther("0");
            amount1Max = ethers.utils.parseEther("1");

            amounts = await grizzlyVault.getMintAmounts(amount0Max, amount1Max);

            expect(amounts.amount0).to.be.eq(ZERO);
            expect(amounts.amount1).to.be.eq(ZERO);
            expect(amounts.mintAmount).to.be.eq(ZERO);

            // Both balances equal to 0
            amount0Max = ethers.utils.parseEther("0");
            amount1Max = ethers.utils.parseEther("0");

            amounts = await grizzlyVault.getMintAmounts(amount0Max, amount1Max);

            expect(amounts.amount0).to.be.eq(ZERO);
            expect(amounts.amount1).to.be.eq(ZERO);
            expect(amounts.mintAmount).to.be.eq(ZERO);
          });

          it("Should provide the right mint amounts with initial liquidity", async () => {
            // Deployer loads the pool with some tokens
            const amount0MaxDep = ethers.utils.parseEther("100");
            const amount1MaxDep = ethers.utils.parseEther("100");

            const amountsDep = await grizzlyVault.getMintAmounts(
              amount0MaxDep,
              amount1MaxDep
            );

            token0.approve(grizzlyVault.address, amountsDep.amount0);
            token1.approve(grizzlyVault.address, amountsDep.amount1);

            await grizzlyVault.mint(
              amountsDep.mintAmount,
              deployerGrizzly.address
            );

            // Get Mint amounts for different max amounts
            const ONE = ethers.utils.parseEther("1");

            // Equal amounts
            let amount0Max = ethers.utils.parseEther("1");
            let amount1Max = ethers.utils.parseEther("1");

            let amounts = await grizzlyVault.getMintAmounts(
              amount0Max,
              amount1Max
            );
            expect(amounts.amount0).to.be.eq(ONE);
            expect(amounts.amount1).to.be.eq(ONE);
            expect(amounts.mintAmount).to.be.eq(ONE);

            // Unbalanced amounts with token0 > token1
            amount0Max = ethers.utils.parseEther("10");
            amount1Max = ethers.utils.parseEther("1");

            amounts = await grizzlyVault.getMintAmounts(amount0Max, amount1Max);

            expect(amounts.amount0).to.be.eq(ONE);
            expect(amounts.amount1).to.be.eq(ONE);
            expect(amounts.mintAmount).to.be.eq(ONE);

            // Unbalanced amounts with token1 > token0
            amount0Max = ethers.utils.parseEther("1");
            amount1Max = ethers.utils.parseEther("10");

            amounts = await grizzlyVault.getMintAmounts(amount0Max, amount1Max);

            expect(amounts.amount0).to.be.eq(ONE);
            expect(amounts.amount1).to.be.eq(ONE);
            expect(amounts.mintAmount).to.be.eq(ONE);

            // Unbalanced amounts with 0 balance token1
            amount0Max = ethers.utils.parseEther("1");
            amount1Max = ethers.utils.parseEther("0");

            await expect(
              grizzlyVault.getMintAmounts(amount0Max, amount1Max)
            ).to.be.revertedWith("mint 0");

            // Unbalanced amounts with 0 balance token1
            amount0Max = ethers.utils.parseEther("0");
            amount1Max = ethers.utils.parseEther("1");

            await expect(
              grizzlyVault.getMintAmounts(amount0Max, amount1Max)
            ).to.be.revertedWith("mint 0");

            // Both balances equal to 0
            amount0Max = ethers.utils.parseEther("0");
            amount1Max = ethers.utils.parseEther("0");

            await expect(
              grizzlyVault.getMintAmounts(amount0Max, amount1Max)
            ).to.be.revertedWith("mint 0");
          });
        });
        describe("Get underlying balances", () => {
          it("Should correctly get the balances with empty pool", async () => {
            const balances = await grizzlyVault.getUnderlyingBalances();

            expect(balances.amount0Current).to.be.eq(BigNumber.from(0));
            expect(balances.amount1Current).to.be.eq(BigNumber.from(0));
          });

          it("Should correctly get the balances with charged pool", async () => {
            // Deployer loads the pool with some tokens
            const amount0MaxDep = ethers.utils.parseEther("100");
            const amount1MaxDep = ethers.utils.parseEther("100");

            const amountsDep = await grizzlyVault.getMintAmounts(
              amount0MaxDep,
              amount1MaxDep
            );

            token0.approve(grizzlyVault.address, amountsDep.amount0);
            token1.approve(grizzlyVault.address, amountsDep.amount1);

            await grizzlyVault.mint(
              amountsDep.mintAmount,
              deployerGrizzly.address
            );

            // We check the balances
            const balances = await grizzlyVault.getUnderlyingBalances();

            expect(balances.amount0Current).to.be.eq(
              ethers.utils.parseEther("99.999999999999999998")
            );
            expect(balances.amount1Current).to.be.eq(
              ethers.utils.parseEther("99.999999999999999998")
            );
          });

          it("Should correctly get the balances after some swaps", async () => {
            // Deployer loads the pool with some tokens
            const amount0MaxDep = ethers.utils.parseEther("100");
            const amount1MaxDep = ethers.utils.parseEther("100");

            const amountsDep = await grizzlyVault.getMintAmounts(
              amount0MaxDep,
              amount1MaxDep
            );

            token0.approve(grizzlyVault.address, amountsDep.amount0);
            token1.approve(grizzlyVault.address, amountsDep.amount1);

            await grizzlyVault.mint(
              amountsDep.mintAmount,
              deployerGrizzly.address
            );

            // We check the balances before
            const balancesBefore = await grizzlyVault.getUnderlyingBalances();

            // We generate some asymmetric swaps
            await swapTest.washTrade(
              uniswapPool.address,
              ethers.utils.parseEther("0.5"),
              10000,
              10,
              0
            );

            // We check the balances
            const balances = await grizzlyVault.getUnderlyingBalances();

            expect(balances.amount0Current).to.be.gt(
              balancesBefore.amount0Current
            );
            expect(balances.amount1Current).to.be.lt(
              balancesBefore.amount1Current
            );
          });
        });
        describe("Get underlying balances at price", () => {
          //TODO: Not sure what this function will be used for
        });
        describe("Estimate Fees", () => {
          beforeEach(async () => {
            // Deployer loads the pool with some tokens
            const amount0MaxDep = ethers.utils.parseEther("100");
            const amount1MaxDep = ethers.utils.parseEther("100");

            const amountsDep = await grizzlyVault.getMintAmounts(
              amount0MaxDep,
              amount1MaxDep
            );

            token0.approve(grizzlyVault.address, amountsDep.amount0);
            token1.approve(grizzlyVault.address, amountsDep.amount1);

            await grizzlyVault.mint(
              amountsDep.mintAmount,
              deployerGrizzly.address
            );
          });
          it("Should provide 0 fees without swaps", async () => {
            const fees = await grizzlyVault.estimateFees();

            expect(fees.token0Fee).to.be.eq(0);
            expect(fees.token1Fee).to.be.eq(0);
          });

          it("Should gather token0 fees after 0 to 1 swaps", async () => {
            // We generate some swaps
            await swapTest.washTrade(uniswapPool.address, 50000, 10000, 10, 0);

            const fees = await grizzlyVault.estimateFees();

            expect(fees.token0Fee).to.be.gt(0);
            expect(fees.token1Fee).to.be.eq(0);
          });

          it("Should gather token1 fees after 1 to 0 swaps", async () => {
            // We generate some swaps
            await swapTest.washTrade(uniswapPool.address, 50000, 10000, 10, 1);

            const fees = await grizzlyVault.estimateFees();

            expect(fees.token0Fee).to.be.eq(0);
            expect(fees.token1Fee).to.be.gt(0);
          });

          it("Should gather both token fees after some swaps", async () => {
            // We generate some swaps
            await swapTest.washTrade(uniswapPool.address, 50000, 10000, 10, 2);

            const fees = await grizzlyVault.estimateFees();

            expect(fees.token0Fee).to.be.gt(0);
            expect(fees.token1Fee).to.be.gt(0);
          });
        });

        describe("Get position id", () => {
          it("Should get the correct id", async () => {
            const id = await grizzlyVault.getPositionID();

            // Manually calculate id
            const ticks = await grizzlyVault.baseTicks();
            const code = ethers.utils.solidityKeccak256(
              ["address", "int24", "int24"],
              [grizzlyVault.address, ticks.lowerTick, ticks.upperTick]
            );

            expect(id).to.be.eq(code);
          });
        });
      });

      describe("User Functions", () => {
        describe("Mint", () => {
          it("Should revert with wrong parameters", async () => {
            // revert when mint 0
            await expect(
              grizzlyVault.connect(user).mint(0, user.address)
            ).to.be.revertedWith("mint 0");

            const amount0Max = BigNumber.from("100000000");
            const amount1Max = BigNumber.from("100000000");
            const amounts = await grizzlyVault.getMintAmounts(
              amount0Max,
              amount1Max
            );

            await token0
              .connect(user)
              .approve(grizzlyVault.address, amounts.amount0);
            await token1
              .connect(user)
              .approve(grizzlyVault.address, amounts.amount1);

            // revert when first mint is too small
            await expect(
              grizzlyVault
                .connect(user)
                .mint(amounts.mintAmount, deployerGrizzly.address)
            ).to.be.revertedWith("min shares");
          });

          it("Should revert when missing approval", async () => {
            const amount0Max = ethers.utils.parseEther("10.0");
            const amount1Max = ethers.utils.parseEther("10.0");
            const amounts = await grizzlyVault.getMintAmounts(
              amount0Max,
              amount1Max
            );

            await token0
              .connect(user)
              .approve(grizzlyVault.address, amounts.amount0);

            expect(
              grizzlyVault.connect(user).mint(amounts.mintAmount, user.address)
            ).to.be.reverted;

            // We reduce allowance to 0 on token0 and approve token1
            await token0.connect(user).approve(grizzlyVault.address, 0);
            await token1
              .connect(user)
              .approve(grizzlyVault.address, amounts.amount1);

            await expect(
              grizzlyVault.connect(user).mint(amounts.mintAmount, user.address)
            ).to.be.reverted;
          });

          it("Should correctly mint", async () => {
            // Check user balances before mint
            const token0BalanceBefore = await token0.balanceOf(user.address);
            const token1BalanceBefore = await token1.balanceOf(user.address);

            // We mint the first LP tokens
            const amount0MaxFirst = ethers.utils.parseEther("1.0");
            const amount1MaxFirst = ethers.utils.parseEther("1.0");
            let amounts = await grizzlyVault.getMintAmounts(
              amount0MaxFirst,
              amount1MaxFirst
            );

            await token0
              .connect(user)
              .approve(grizzlyVault.address, amounts.amount0);
            await token1
              .connect(user)
              .approve(grizzlyVault.address, amounts.amount1);

            const tx = await grizzlyVault
              .connect(user)
              .mint(amounts.mintAmount, user.address);

            // Check that event was emitted
            const receipt = await tx.wait();
            const events = receipt.events?.filter((e) => {
              return e.event === "Minted";
            });
            if (!events) {
              throw new Error("No events emitted on mint");
            }
            const args = events[0].args;
            if (!args) {
              throw new Error("Event with no arguments");
            }
            expect(user.address).to.be.eq(args[0]);
            expect(amounts.mintAmount).to.be.eq(args[1]);
            expect(amounts.amount0).to.be.eq(args[2]);
            expect(amounts.amount1).to.be.eq(args[3]);

            // Check user balances after mint
            const token0BalanceAfter = await token0.balanceOf(user.address);
            const token1BalanceAfter = await token1.balanceOf(user.address);
            const lpBalanceAfter = await grizzlyVault.balanceOf(user.address);

            expect(lpBalanceAfter).to.be.eq(amounts.mintAmount);
            expect(token0BalanceAfter).to.be.eq(
              token0BalanceBefore.sub(amounts.amount0)
            );
            expect(token1BalanceAfter).to.be.eq(
              token1BalanceBefore.sub(amounts.amount1)
            );

            // We mint a second time from deployer to user
            amounts = await grizzlyVault.getMintAmounts(
              amount0MaxFirst,
              amount1MaxFirst
            );

            await token0.approve(grizzlyVault.address, amounts.amount0);
            await token1.approve(grizzlyVault.address, amounts.amount1);

            await grizzlyVault.mint(amounts.mintAmount, user.address);

            // We check user LP balance
            const lpBalanceAfter2 = await grizzlyVault.balanceOf(user.address);
            expect(lpBalanceAfter2).to.be.gt(lpBalanceAfter);
          });

          it("Should correctly mint after some swaps", async () => {
            // We generate some swaps
            await swapTest.washTrade(uniswapPool.address, 50000, 10000, 10, 3);

            // Check user balances before mint
            const token0BalanceBefore = await token0.balanceOf(user.address);
            const token1BalanceBefore = await token1.balanceOf(user.address);

            // We mint the first LP tokens
            const amount0MaxFirst = ethers.utils.parseEther("1.0");
            const amount1MaxFirst = ethers.utils.parseEther("1.0");
            let amounts = await grizzlyVault.getMintAmounts(
              amount0MaxFirst,
              amount1MaxFirst
            );

            await token0
              .connect(user)
              .approve(grizzlyVault.address, amounts.amount0);
            await token1
              .connect(user)
              .approve(grizzlyVault.address, amounts.amount1);

            await grizzlyVault
              .connect(user)
              .mint(amounts.mintAmount, user.address);

            // Check user balances after mint
            const token0BalanceAfter = await token0.balanceOf(user.address);
            const token1BalanceAfter = await token1.balanceOf(user.address);
            const lpBalanceAfter = await grizzlyVault.balanceOf(user.address);

            expect(lpBalanceAfter).to.be.eq(amounts.mintAmount);
            expect(token0BalanceAfter).to.be.eq(
              token0BalanceBefore.sub(amounts.amount0)
            );
            expect(token1BalanceAfter).to.be.eq(
              token1BalanceBefore.sub(amounts.amount1)
            );

            // We generate some more swaps
            await swapTest.washTrade(uniswapPool.address, 50000, 10000, 10, 3);

            // We mint a second time from deployer to user
            amounts = await grizzlyVault.getMintAmounts(
              amount0MaxFirst,
              amount1MaxFirst
            );

            await token0.approve(grizzlyVault.address, amounts.amount0);
            await token1.approve(grizzlyVault.address, amounts.amount1);

            await grizzlyVault.mint(amounts.mintAmount, user.address);

            // We check user LP balance
            const lpBalanceAfter2 = await grizzlyVault.balanceOf(user.address);
            expect(lpBalanceAfter2).to.be.gt(lpBalanceAfter);
          });
        });

        describe("Burn", () => {
          let mintAmount: BigNumber;
          let amount0: BigNumber;
          let amount1: BigNumber;
          let defaultMaxSlippage = BigNumber.from("5000");

          beforeEach(async () => {
            // Deployer loads the pool with some tokens
            const amount0MaxDep = ethers.utils.parseEther("100");
            const amount1MaxDep = ethers.utils.parseEther("100");

            const amountsDep = await grizzlyVault.getMintAmounts(
              amount0MaxDep,
              amount1MaxDep
            );

            token0.approve(grizzlyVault.address, amountsDep.amount0);
            token1.approve(grizzlyVault.address, amountsDep.amount1);

            await grizzlyVault.mint(
              amountsDep.mintAmount,
              deployerGrizzly.address
            );

            // We mint some tokens to be burned after
            const amount0Max = ethers.utils.parseEther("1.0");
            const amount1Max = ethers.utils.parseEther("1.0");
            const amounts = await grizzlyVault.getMintAmounts(
              amount0Max,
              amount1Max
            );
            mintAmount = amounts.mintAmount;
            amount0 = amounts.amount0;
            amount1 = amounts.amount1;

            await token0.connect(user).approve(grizzlyVault.address, amount0);
            await token1.connect(user).approve(grizzlyVault.address, amount1);

            await grizzlyVault.connect(user).mint(mintAmount, user.address);
          });

          it("Should revert if burn amount is 0", async () => {
            await expect(
              grizzlyVault.burn(
                BigNumber.from(0),
                defaultMaxSlippage,
                0,
                user.address
              )
            ).to.be.revertedWith("burn 0");
          });

          it("Should revert if user does not have enough LP tokens", async () => {
            const burnAmount = mintAmount.add(1);
            await expect(
              grizzlyVault
                .connect(user)
                .burn(burnAmount, defaultMaxSlippage, 0, user.address)
            ).to.be.revertedWith("ERC20: burn amount exceeds balance");
          });

          it("Should burn and receive both tokens", async () => {
            const token0BalanceBefore = await token0.balanceOf(user.address);
            const token1BalanceBefore = await token1.balanceOf(user.address);

            await grizzlyVault
              .connect(user)
              .burn(mintAmount, 0, 2, user.address);

            const lpBalanceAfter = await grizzlyVault.balanceOf(user.address);
            const token0BalanceAfter = await token0.balanceOf(user.address);
            const token1BalanceAfter = await token1.balanceOf(user.address);

            expect(lpBalanceAfter).to.be.eq(BigNumber.from(0));
            expect(token0BalanceAfter).to.be.gt(token0BalanceBefore);
            expect(token1BalanceAfter).to.be.gt(token1BalanceBefore);
          });

          it("Should burn and receive only token 0 with high slippage", async () => {
            const token0BalanceBefore = await token0.balanceOf(user.address);
            const token1BalanceBefore = await token1.balanceOf(user.address);

            const maxSlippage = BigNumber.from("50000"); //5%

            await grizzlyVault
              .connect(user)
              .burn(mintAmount, maxSlippage, 0, user.address);

            const lpBalanceAfter = await grizzlyVault.balanceOf(user.address);
            const token0BalanceAfter = await token0.balanceOf(user.address);
            const token1BalanceAfter = await token1.balanceOf(user.address);

            expect(lpBalanceAfter).to.be.eq(BigNumber.from(0));
            expect(token0BalanceAfter).to.be.gt(token0BalanceBefore);
            expect(token1BalanceAfter).to.be.eq(token1BalanceBefore);
          });

          it("Should burn and receive only token 1 with high slippage", async () => {
            const token0BalanceBefore = await token0.balanceOf(user.address);
            const token1BalanceBefore = await token1.balanceOf(user.address);

            const maxSlippage = BigNumber.from("50000"); //5%

            await grizzlyVault
              .connect(user)
              .burn(mintAmount, maxSlippage, 1, user.address);

            const lpBalanceAfter = await grizzlyVault.balanceOf(user.address);
            const token0BalanceAfter = await token0.balanceOf(user.address);
            const token1BalanceAfter = await token1.balanceOf(user.address);

            expect(lpBalanceAfter).to.be.eq(BigNumber.from(0));
            expect(token0BalanceAfter).to.be.eq(token0BalanceBefore);
            expect(token1BalanceAfter).to.be.gt(token1BalanceBefore);
          });

          it("Should burn and receive token 0 and some dust token 1 with low slippage", async () => {
            const token0BalanceBefore = await token0.balanceOf(user.address);
            const token1BalanceBefore = await token1.balanceOf(user.address);

            const maxSlippage = BigNumber.from("5000"); //0.5%

            await grizzlyVault
              .connect(user)
              .burn(mintAmount, maxSlippage, 0, user.address);

            const lpBalanceAfter = await grizzlyVault.balanceOf(user.address);
            const token0BalanceAfter = await token0.balanceOf(user.address);
            const token1BalanceAfter = await token1.balanceOf(user.address);

            expect(lpBalanceAfter).to.be.eq(BigNumber.from(0));
            expect(token0BalanceAfter).to.be.gt(token0BalanceBefore);
            expect(token1BalanceAfter).to.be.gt(token1BalanceBefore);
          });

          it("Should burn and receive token 1 and some dust token 0 with low slippage", async () => {
            const token0BalanceBefore = await token0.balanceOf(user.address);
            const token1BalanceBefore = await token1.balanceOf(user.address);

            const maxSlippage = BigNumber.from("5000"); //0.5%

            await grizzlyVault
              .connect(user)
              .burn(mintAmount, maxSlippage, 1, user.address);

            const lpBalanceAfter = await grizzlyVault.balanceOf(user.address);
            const token0BalanceAfter = await token0.balanceOf(user.address);
            const token1BalanceAfter = await token1.balanceOf(user.address);

            expect(lpBalanceAfter).to.be.eq(BigNumber.from(0));
            expect(token0BalanceAfter).to.be.gt(token0BalanceBefore);
            expect(token1BalanceAfter).to.be.gt(token1BalanceBefore);
          });
        });
      });

      describe("External manager functions", () => {
        describe("Update config parameters", () => {
          it("Should revert if not manager", async () => {
            const newOracleSlippage = 3000;
            const newOracleSlippageInterval = 10800; //3 minutes
            const newTreasury = deployerGrizzly.address;

            // run as deployer
            await expect(
              grizzlyVault.updateConfigParams(
                newOracleSlippage,
                newOracleSlippageInterval,
                newTreasury
              )
            ).to.be.revertedWith("Ownable: caller is not the manager");

            // run as user
            await expect(
              grizzlyVault
                .connect(user)
                .updateConfigParams(
                  newOracleSlippage,
                  newOracleSlippageInterval,
                  newTreasury
                )
            ).to.be.revertedWith("Ownable: caller is not the manager");
          });
          it("Should revert with wrong parameters", async () => {
            const newOracleSlippage = BigNumber.from("1000001");
            const newOracleSlippageInterval = 10800; //3 minutes
            const newTreasury = deployerGrizzly.address;

            await expect(
              grizzlyVault
                .connect(manager)
                .updateConfigParams(
                  newOracleSlippage,
                  newOracleSlippageInterval,
                  newTreasury
                )
            ).to.be.revertedWith("slippage too high");
          });
          it("Should correctly update parameters", async () => {
            const newOracleSlippage = 3000;
            const newOracleSlippageInterval = 10800; //3 minutes
            const newTreasury = deployerGrizzly.address;

            // update parameters and check event
            await expect(
              grizzlyVault
                .connect(manager)
                .updateConfigParams(
                  newOracleSlippage,
                  newOracleSlippageInterval,
                  newTreasury
                )
            )
              .to.be.emit(grizzlyVault, "UpdateGrizzlyParams")
              .withArgs(newOracleSlippage, newOracleSlippageInterval);

            // Check the parameters correctly changed
            const oracleSlippage = await grizzlyVault.oracleSlippage();
            const oracleSlippageInterval =
              await grizzlyVault.oracleSlippageInterval();
            const managerTreasury = await grizzlyVault.managerTreasury();

            expect(oracleSlippage).to.be.eq(newOracleSlippage);
            expect(oracleSlippageInterval).to.be.eq(newOracleSlippageInterval);
            expect(managerTreasury).to.be.eq(newTreasury);
          });
        });

        describe("Set manager fee", () => {
          it("Should revert if not manager", async () => {
            const managerFee = 3000;

            // run as deployer
            await expect(
              grizzlyVault.setManagerFee(managerFee)
            ).to.be.revertedWith("Ownable: caller is not the manager");

            // run as user
            await expect(
              grizzlyVault.connect(user).setManagerFee(managerFee)
            ).to.be.revertedWith("Ownable: caller is not the manager");
          });
          it("Should revert with wrong parameters", async () => {
            const managerFee = BigNumber.from("1000001");

            // try with fee 0
            await expect(
              grizzlyVault.connect(manager).setManagerFee(0)
            ).to.be.revertedWith("invalid manager fee");

            // try with fee too high
            await expect(
              grizzlyVault.connect(manager).setManagerFee(managerFee)
            ).to.be.revertedWith("invalid manager fee");
          });
          it("Should correctly update manager fee", async () => {
            const managerFee = 30000;

            // update fee and check event
            await expect(
              grizzlyVault.connect(manager).setManagerFee(managerFee)
            )
              .to.emit(grizzlyVault, "SetManagerFee")
              .withArgs(managerFee);

            // Check the fee correctly changed
            const fee = await grizzlyVault.managerFee();
            expect(fee).to.be.eq(managerFee);
          });
        });

        describe("Set keeper address", () => {
          it("Should revert if not manager", async () => {
            const keeperAddress = bot.address;

            // run as deployer
            await expect(
              grizzlyVault.setKeeperAddress(keeperAddress)
            ).to.be.revertedWith("Ownable: caller is not the manager");

            // run as user
            await expect(
              grizzlyVault.connect(user).setKeeperAddress(keeperAddress)
            ).to.be.revertedWith("Ownable: caller is not the manager");
          });

          it("Should revert with wrong parameters", async () => {
            const keeperAddress = ethers.constants.AddressZero;

            // try with addreess 0
            await expect(
              grizzlyVault.connect(manager).setKeeperAddress(keeperAddress)
            ).to.be.revertedWith("zeroAddress");
          });

          it("Should correctly sset keeper address", async () => {
            const keeperAddress = bot.address;

            // set new address
            await grizzlyVault.connect(manager).setKeeperAddress(keeperAddress);

            // Check the keeper address correctly changed
            const keeper = await grizzlyVault.keeperAddress();
            expect(keeper).to.be.eq(keeperAddress);
          });
        });

        describe("Set manager parameters", () => {
          it("Should revert if not manager", async () => {
            const slippageUserMax = 7000;
            const slippageRebalanceMax = 5550;

            // run as deployer
            await expect(
              grizzlyVault.setManagerParams(
                slippageUserMax,
                slippageRebalanceMax
              )
            ).to.be.revertedWith("Ownable: caller is not the manager");

            // run as user
            await expect(
              grizzlyVault
                .connect(user)
                .setManagerParams(slippageUserMax, slippageRebalanceMax)
            ).to.be.revertedWith("Ownable: caller is not the manager");
          });
          it("Should revert with wrong parameters", async () => {
            const slippageUserMax = BigNumber.from("1000001");
            const slippageRebalanceMax = BigNumber.from("1000001");

            await expect(
              grizzlyVault
                .connect(manager)
                .setManagerParams(slippageUserMax, 5550)
            ).to.be.revertedWith("wrong inputs");

            await expect(
              grizzlyVault
                .connect(manager)
                .setManagerParams(5550, slippageRebalanceMax)
            ).to.be.revertedWith("wrong inputs");

            await expect(
              grizzlyVault
                .connect(manager)
                .setManagerParams(slippageUserMax, slippageRebalanceMax)
            ).to.be.revertedWith("wrong inputs");
          });

          it("Should correctly update parameters", async () => {
            const slippageUserMax = 7000;
            const slippageRebalanceMax = 5550;

            // update parameters
            await grizzlyVault
              .connect(manager)
              .setManagerParams(slippageUserMax, slippageRebalanceMax);

            // Check the parameters correctly changed
            const slippageUser = await grizzlyVault.slippageUserMax();
            const slippageRebalance = await grizzlyVault.slippageRebalanceMax();

            expect(slippageRebalance).to.be.eq(slippageRebalanceMax);
            expect(slippageUser).to.be.eq(slippageUserMax);
          });
        });

        describe("Executive rebalance", () => {
          beforeEach(async () => {
            // Deployer loads the pool with some tokens
            const amount0MaxDep = ethers.utils.parseEther("100");
            const amount1MaxDep = ethers.utils.parseEther("100");

            const amountsDep = await grizzlyVault.getMintAmounts(
              amount0MaxDep,
              amount1MaxDep
            );

            await token0.approve(grizzlyVault.address, amountsDep.amount0);
            await token1.approve(grizzlyVault.address, amountsDep.amount1);

            await grizzlyVault.mint(
              amountsDep.mintAmount,
              deployerGrizzly.address
            );

            // We give bot manager authorization
            await grizzlyVault.connect(manager).setKeeperAddress(bot.address);

            // We first make the evm go some seconds forward
            await helpers.time.increase(300);
          });
          it("Should revert if not manager", async () => {
            // run as deployer
            await expect(
              grizzlyVault.executiveRebalance(-887220, 887220, 3000)
            ).to.be.revertedWith("Ownable: caller is not the manager");

            // run as user
            await expect(
              grizzlyVault
                .connect(user)
                .executiveRebalance(-887220, 887220, 3000)
            ).to.be.revertedWith("Ownable: caller is not the manager");

            // run as bot
            await expect(
              grizzlyVault
                .connect(bot)
                .executiveRebalance(-887220, 887220, 3000)
            ).to.be.revertedWith("Ownable: caller is not the manager");
          });

          it("Should revert with wrong parameters", async () => {
            const id = await grizzlyVault.getPositionID();
            const liquidity = (await uniswapPool.positions(id))._liquidity;

            await expect(
              grizzlyVault
                .connect(manager)
                .executiveRebalance(-30, 30, liquidity)
            ).to.be.revertedWith("tickSpacing mismatch");

            await expect(
              grizzlyVault
                .connect(manager)
                .executiveRebalance(-60, 60, liquidity.mul(1000))
            ).to.be.revertedWith("min liquidity");
          });

          it("Should revert when slippage is high", async () => {
            // We make some swaps to produce slippage
            await swapTest.washTrade(
              uniswapPool.address,
              ethers.utils.parseEther("10"),
              50000,
              10,
              0
            );

            const id = await grizzlyVault.getPositionID();
            const liquidity = (await uniswapPool.positions(id))._liquidity;

            await expect(
              grizzlyVault
                .connect(manager)
                .executiveRebalance(-60, 60, liquidity)
            ).to.be.revertedWith("high slippage");
          });

          it("Should correctly do an executive rebalance", async () => {
            // We check the tick spacing
            const tickSpacing = await uniswapPool.tickSpacing();

            // We read some values from the vault
            let id = await grizzlyVault.getPositionID();
            let liquidity = (await uniswapPool.positions(id))._liquidity;

            // We perform a rebalance on a tight interval
            const tx = await grizzlyVault
              .connect(manager)
              .executiveRebalance(-2 * tickSpacing, 2 * tickSpacing, liquidity);

            // Check event emission
            const receipt = await tx.wait();
            const events = receipt.events?.filter((x) => {
              return x.event == "Rebalance";
            });
            if (!events) {
              throw new Error("No events when rebalance");
            }

            // Read new values from the vault
            const ticks = await grizzlyVault.baseTicks();
            id = await grizzlyVault.getPositionID();
            const newLiquidity = (await uniswapPool.positions(id))._liquidity;

            // Check event parameters
            const args = events[0].args;
            if (!args) {
              throw new Error("Event has no args");
            }
            expect(ticks.lowerTick).to.be.eq(args[0]);
            expect(ticks.upperTick).to.be.eq(args[1]);
            expect(liquidity).to.be.eq(args[2]);
            expect(newLiquidity).to.be.eq(args[3]);

            //Check change in liquidity and ticks
            expect(newLiquidity).to.be.gt(liquidity);
            expect(ticks.lowerTick).to.be.eq(-2 * tickSpacing);
            expect(ticks.upperTick).to.be.eq(2 * tickSpacing);
          });
        });
      });

      describe("External authorized functions", () => {
        describe("Rebalance", () => {
          beforeEach(async () => {
            // Deployer loads the pool with some tokens
            const amount0MaxDep = ethers.utils.parseEther("100");
            const amount1MaxDep = ethers.utils.parseEther("100");

            const amountsDep = await grizzlyVault.getMintAmounts(
              amount0MaxDep,
              amount1MaxDep
            );

            await token0.approve(grizzlyVault.address, amountsDep.amount0);
            await token1.approve(grizzlyVault.address, amountsDep.amount1);

            await grizzlyVault.mint(
              amountsDep.mintAmount,
              deployerGrizzly.address
            );

            // We give bot manager authorization
            await grizzlyVault.connect(manager).setKeeperAddress(bot.address);

            // We first make the evm go some seconds forward
            await helpers.time.increase(300);
          });
          it("Should revert if not authorized", async () => {
            // run rebalance as deployer
            await expect(grizzlyVault.rebalance()).to.be.revertedWith(
              "not authorized"
            );

            // run rebalance as user
            await expect(
              grizzlyVault.connect(user).rebalance()
            ).to.be.revertedWith("not authorized");
          });

          it("Should revert when slippage is high", async () => {
            // We make some swaps to produce slippage
            await swapTest.washTrade(
              uniswapPool.address,
              ethers.utils.parseEther("10"),
              50000,
              10,
              0
            );

            await expect(
              grizzlyVault.connect(manager).rebalance()
            ).to.be.revertedWith("high slippage");
          });
          it("Should revert if liquidity did not increase", async () => {
            await expect(
              grizzlyVault.connect(manager).rebalance()
            ).to.be.revertedWith("liquidity must increase");
          });
          it("Should let bot and manager to rebalance", async () => {
            // We make some swaps to generate fees
            await swapTest.washTrade(
              uniswapPool.address,
              ethers.utils.parseEther("0.1"),
              10000,
              10,
              2
            );

            // We read some values from the vault
            const ticks = await grizzlyVault.baseTicks();
            const id = await grizzlyVault.getPositionID();
            const liquidity = (await uniswapPool.positions(id))._liquidity;

            const tx = await grizzlyVault.connect(manager).rebalance();

            // Check event emission
            const receipt = await tx.wait();
            const events = receipt.events?.filter((x) => {
              return x.event == "Rebalance";
            });
            if (!events) {
              throw new Error("No events when rebalance");
            }

            // Read new values
            const newLiquidity = (await uniswapPool.positions(id))._liquidity;

            // Check event parameters
            const args = events[0].args;
            if (!args) {
              throw new Error("Event has no args");
            }
            expect(ticks.lowerTick).to.be.eq(args[0]);
            expect(ticks.upperTick).to.be.eq(args[1]);
            expect(liquidity).to.be.eq(args[2]);
            expect(newLiquidity).to.be.eq(args[3]);

            //Check change in liquidity
            expect(newLiquidity).to.be.gt(liquidity);

            // Bot can perform the same operation without reverting
            await swapTest.washTrade(
              uniswapPool.address,
              ethers.utils.parseEther("0.1"),
              10000,
              10,
              2
            );

            await grizzlyVault.connect(bot).rebalance();
          });
        });
        describe("Withdraw manager balance", () => {
          beforeEach(async () => {
            // Deployer loads the pool with some tokens
            const amount0MaxDep = ethers.utils.parseEther("100");
            const amount1MaxDep = ethers.utils.parseEther("100");

            const amountsDep = await grizzlyVault.getMintAmounts(
              amount0MaxDep,
              amount1MaxDep
            );

            token0.approve(grizzlyVault.address, amountsDep.amount0);
            token1.approve(grizzlyVault.address, amountsDep.amount1);

            grizzlyVault.mint(amountsDep.mintAmount, deployerGrizzly.address);

            // We give bot manager authorization
            await grizzlyVault.connect(manager).setKeeperAddress(bot.address);

            // We first make the evm go some seconds forward
            await helpers.time.increase(300);

            // We make some swaps too generate fees
            await swapTest.washTrade(
              uniswapPool.address,
              ethers.utils.parseEther("0.1"),
              10000,
              100,
              2
            );
          });
          it("Should revert if not authorized", async () => {
            // run as deployer
            await expect(
              grizzlyVault.connect(user).withdrawManagerBalance()
            ).to.be.revertedWith("not authorized");

            // run as user
            await expect(
              grizzlyVault.connect(user).withdrawManagerBalance()
            ).to.be.revertedWith("not authorized");
          });

          it("Should get 0 manager fees with 0 parameter", async () => {
            // We rebalance to apply fees
            await grizzlyVault.connect(manager).rebalance();

            // We check manager balances before
            const balance0Before = await token0.balanceOf(manager.address);
            const balance1Before = await token1.balanceOf(manager.address);

            // Manager withdraws fees to default address = manager
            await grizzlyVault.connect(manager).withdrawManagerBalance();

            // We compare them afterwards
            const balance0After = await token0.balanceOf(manager.address);
            const balance1After = await token1.balanceOf(manager.address);

            expect(balance0After).to.be.eq(balance0Before);
            expect(balance1After).to.be.eq(balance1Before);
          });

          it("Should get 0 manager fees with no burns or rebalances", async () => {
            // Increase manager fee to 50%
            await grizzlyVault.connect(manager).setManagerFee(500000);

            // We check manager balances before
            const balance0Before = await token0.balanceOf(manager.address);
            const balance1Before = await token1.balanceOf(manager.address);

            // Manager withdraws fees to default address = manager
            await grizzlyVault.connect(manager).withdrawManagerBalance();

            // We compare them afterwards
            const balance0After = await token0.balanceOf(manager.address);
            const balance1After = await token1.balanceOf(manager.address);

            expect(balance0After).to.be.eq(balance0Before);
            expect(balance1After).to.be.eq(balance1Before);
          });

          it("Should get some manager fees after burn", async () => {
            // Increase manager fee to 50%
            await grizzlyVault.connect(manager).setManagerFee(500000);

            // We burn some liquidity to apply fees to
            const balanceLP = await grizzlyVault.balanceOf(
              deployerGrizzly.address
            );
            await grizzlyVault.approve(grizzlyVault.address, balanceLP);
            await grizzlyVault.burn(
              balanceLP,
              50000,
              1,
              deployerGrizzly.address
            );

            // We check manager balances before
            const balance0Before = await token0.balanceOf(manager.address);
            const balance1Before = await token1.balanceOf(manager.address);

            // Manager withdraws fees to default address = manager
            await grizzlyVault.connect(manager).withdrawManagerBalance();

            // We compare them afterwards
            const balance0After = await token0.balanceOf(manager.address);
            const balance1After = await token1.balanceOf(manager.address);

            expect(balance0After).to.be.gt(balance0Before);
            expect(balance1After).to.be.gt(balance1Before);
          });

          it("Should get some manager fees after rebalance", async () => {
            // Increase manager fee to 50%
            await grizzlyVault.connect(manager).setManagerFee(500000);

            // We rebalance to apply fees
            await grizzlyVault.connect(manager).rebalance();

            // We check manager balances before
            const balance0Before = await token0.balanceOf(manager.address);
            const balance1Before = await token1.balanceOf(manager.address);

            // Manager withdraws fees to default address = manager
            await grizzlyVault.connect(manager).withdrawManagerBalance();

            // We compare them afterwards
            const balance0After = await token0.balanceOf(manager.address);
            const balance1After = await token1.balanceOf(manager.address);

            expect(balance0After).to.be.gt(balance0Before);
            expect(balance1After).to.be.gt(balance1Before);

            // We repeat the operation with a bot
            await swapTest.washTrade(
              uniswapPool.address,
              ethers.utils.parseEther("0.1"),
              10000,
              100,
              2
            );
            await grizzlyVault.connect(manager).rebalance();
            await grizzlyVault.connect(bot).withdrawManagerBalance();

            const balance0AfterAfter = await token0.balanceOf(manager.address);
            const balance1AfterAfter = await token1.balanceOf(manager.address);

            expect(balance0AfterAfter).to.be.gt(balance0After);
            expect(balance1AfterAfter).to.be.gt(balance1After);
          });
        });
      });
    });
  });

  describe("Test with mainnet pools", () => {
    pools.slice(0, 1).forEach((pool) => {
      describe(`Testing in ${pool.name} pool`, () => {
        let zeroForOne: boolean;
        let fee: number;
        let tick: number;
        let tickSpacing: number;
        let token0Decimals: number;
        let token1Decimals: number;
        let defaultAmount0: BigNumber;
        let defaultAmount1: BigNumber;

        before(async () => {
          // We load the mainnet UniswapV3 pool
          uniswapPool = (await ethers.getContractAt(
            "IUniswapV3Pool",
            pool.address
          )) as IUniswapV3Pool;

          token0 = (await ethers.getContractAt(
            "ERC20",
            pool.token0
          )) as ERC20Upgradeable;
          token1 = (await ethers.getContractAt(
            "ERC20",
            pool.token1
          )) as ERC20Upgradeable;

          // We set default amounts
          token0Decimals = await token0.decimals();
          token1Decimals = await token1.decimals();
          defaultAmount0 = ethers.utils.parseUnits("100", token0Decimals);
          defaultAmount1 = ethers.utils.parseUnits("100", token1Decimals);

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
            manager.address
          );

          vaultAddress = (
            await grizzlyFactory.getVaults(deployerGrizzly.address)
          )[0];

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

          // We load deployer account
          await token0
            .connect(token0Whale)
            .transfer(
              deployerGrizzly.address,
              ethers.utils.parseUnits("1000", token0Decimals)
            );
          await token1
            .connect(token1Whale)
            .transfer(
              deployerGrizzly.address,
              ethers.utils.parseUnits("1000", token1Decimals)
            );

          // We increase allowance to swap test
          await token0.approve(
            swapTest.address,
            ethers.utils.parseUnits("1000", token0Decimals)
          );
          await token1.approve(
            swapTest.address,
            ethers.utils.parseUnits("1000", token1Decimals)
          );
        });

        describe("Grizzly Vault Factory", () => {
          describe("External view functions", () => {
            it("Should get Token Name", async () => {
              const lpTokenName = await grizzlyFactory.getTokenName(
                token0.address,
                token1.address
              );
              expect(lpTokenName).to.be.eq(`Grizzly Uniswap ${pool.name} LP`);
            });
            it("Should get Grizzly vaults", async () => {
              // We create a user vault
              await grizzlyFactory
                .connect(user)
                .cloneGrizzlyVault(
                  token0.address,
                  token1.address,
                  fee,
                  0,
                  tick - 100 * tickSpacing,
                  tick + 100 * tickSpacing,
                  manager.address
                );

              const vaults = await grizzlyFactory.getGrizzlyVaults();
              expect(vaults.length).to.be.eq(1);
              expect(vaults[0]).to.be.eq(grizzlyVault.address);
            });
            it("Should get vaults", async () => {
              const tx = await grizzlyFactory
                .connect(user)
                .cloneGrizzlyVault(
                  token0.address,
                  token1.address,
                  fee,
                  0,
                  tick - 100 * tickSpacing,
                  tick + 100 * tickSpacing,
                  manager.address
                );

              const receipt = await tx.wait();
              const events = receipt.events?.filter((x) => {
                return x.event == "VaultCreated";
              });
              if (!events) {
                throw new Error("No events when vault created");
              }
              const newVaultAddress = events[0].args?.vault;

              const vaults = await grizzlyFactory.getVaults(user.address);
              expect(vaults.length).to.be.eq(1);
              expect(vaults[0]).to.be.eq(newVaultAddress);
            });
            it("Should get number of vaults", async () => {
              await grizzlyFactory
                .connect(user)
                .cloneGrizzlyVault(
                  token0.address,
                  token1.address,
                  fee,
                  0,
                  tick - 100 * tickSpacing,
                  tick + 100 * tickSpacing,
                  manager.address
                );

              const nVaults = await grizzlyFactory.numVaults(user.address);
              expect(nVaults).to.be.eq(1);
            });
          });

          describe("Clone Grizzly Vault", () => {
            describe("Reverts with wrong parameters", () => {
              it("Should revert when pool does not exist", async () => {
                await expect(
                  grizzlyFactory
                    .connect(user)
                    .cloneGrizzlyVault(
                      token0.address,
                      token1.address,
                      6000,
                      0,
                      tick - 100 * tickSpacing,
                      tick + 100 * tickSpacing,
                      manager.address
                    )
                ).to.be.revertedWith("uniV3Pool does not exist");
              });

              it("Should revert when pool tickspace is not correct", async () => {
                await expect(
                  grizzlyFactory
                    .connect(user)
                    .cloneGrizzlyVault(
                      token0.address,
                      token1.address,
                      fee,
                      0,
                      tick - 100 * tickSpacing + 1,
                      tick + 100 * tickSpacing,
                      manager.address
                    )
                ).to.be.revertedWith("tickSpacing mismatch");
              });
            });

            describe("Clones a Grizzly Vault", () => {
              it("Should correctly clone a vault", async () => {
                expect(
                  await grizzlyFactory.numVaults(deployerGrizzly.address)
                ).to.be.eq(BigNumber.from(1));
                await grizzlyFactory.cloneGrizzlyVault(
                  token0.address,
                  token1.address,
                  fee,
                  0,
                  tick - 100 * tickSpacing,
                  tick + 100 * tickSpacing,
                  manager.address
                );
                expect(
                  await grizzlyFactory.numVaults(deployerGrizzly.address)
                ).to.be.eq(BigNumber.from(2));
              });
            });
          });

          describe("Set implementation vault", () => {
            it("Should revert with 0 address", async () => {
              await expect(
                grizzlyFactory.setImplementationVault(
                  ethers.constants.AddressZero
                )
              ).to.be.revertedWith("zeroAddress");
            });

            it("Should revert when not owner", async () => {
              await expect(
                grizzlyFactory
                  .connect(user)
                  .setImplementationVault(grizzlyVault.address)
              ).to.be.revertedWith("Ownable: caller is not the owner");
            });

            it("Should set new implementation vault correctly", async () => {
              // Check old implementation
              expect(await grizzlyFactory.implementation()).to.be.eq(
                grizzlyCoreVault.address
              );

              // Change implementation
              await expect(
                grizzlyFactory.setImplementationVault(grizzlyVault.address)
              )
                .to.emit(grizzlyFactory, "ImplementationVaultChanged")
                .withArgs(grizzlyVault.address, grizzlyCoreVault.address);

              // Check new implementation
              expect(await grizzlyFactory.implementation()).to.be.eq(
                grizzlyVault.address
              );
            });
          });
        });

        describe("Grizzly Vault", () => {
          describe("External view functions", () => {
            describe("Get mint amounts", () => {
              it("Should provide the right mint amounts without initial liquidity", async () => {
                const ZERO = BigNumber.from(0);

                // Equal amounts
                let amount0Max = ethers.utils.parseUnits("100", token0Decimals);
                let amount1Max = ethers.utils.parseUnits("100", token1Decimals);

                let amounts = await grizzlyVault.getMintAmounts(
                  amount0Max,
                  amount1Max
                );

                if (zeroForOne) {
                  expect(amounts.amount0).to.be.lt(amount0Max);
                  expect(amounts.amount1).to.be.at.most(amount1Max);
                } else {
                  expect(amounts.amount0).to.be.at.most(amount0Max);
                  expect(amounts.amount1).to.be.lt(amount1Max);
                }
                expect(amounts.mintAmount).to.be.gt(ZERO);

                // Unbalanced amounts with 0 balance token1
                amount0Max = ethers.utils.parseEther("1");
                amount1Max = ethers.utils.parseEther("0");

                amounts = await grizzlyVault.getMintAmounts(
                  amount0Max,
                  amount1Max
                );

                expect(amounts.amount0).to.be.eq(0);
                expect(amounts.amount1).to.be.eq(ZERO);
                expect(amounts.mintAmount).to.be.eq(ZERO);

                // Unbalanced amounts with 0 balance token1
                amount0Max = ethers.utils.parseEther("0");
                amount1Max = ethers.utils.parseEther("1");

                amounts = await grizzlyVault.getMintAmounts(
                  amount0Max,
                  amount1Max
                );

                expect(amounts.amount0).to.be.eq(ZERO);
                expect(amounts.amount1).to.be.eq(ZERO);
                expect(amounts.mintAmount).to.be.eq(ZERO);

                // Both balances equal to 0
                amount0Max = ethers.utils.parseEther("0");
                amount1Max = ethers.utils.parseEther("0");

                amounts = await grizzlyVault.getMintAmounts(
                  amount0Max,
                  amount1Max
                );

                expect(amounts.amount0).to.be.eq(ZERO);
                expect(amounts.amount1).to.be.eq(ZERO);
                expect(amounts.mintAmount).to.be.eq(ZERO);
              });

              it("Should provide the right mint amounts with initial liquidity", async () => {
                // Deployer loads the pool with some tokens
                const amount0MaxDep = defaultAmount0;
                const amount1MaxDep = defaultAmount1;

                const amountsDep = await grizzlyVault.getMintAmounts(
                  amount0MaxDep,
                  amount1MaxDep
                );

                token0.approve(grizzlyVault.address, amountsDep.amount0);
                token1.approve(grizzlyVault.address, amountsDep.amount1);

                await grizzlyVault.mint(
                  amountsDep.mintAmount,
                  deployerGrizzly.address
                );

                // Get Mint amounts for different max amounts
                const ZERO = BigNumber.from(0);

                // Equal amounts
                let amount0Max = ethers.utils.parseUnits("100", token0Decimals);
                let amount1Max = ethers.utils.parseUnits("100", token1Decimals);

                let amounts = await grizzlyVault.getMintAmounts(
                  amount0Max,
                  amount1Max
                );

                if (zeroForOne) {
                  expect(amounts.amount0).to.be.lt(amount0Max);
                  expect(amounts.amount1).to.be.at.most(amount1Max);
                } else {
                  expect(amounts.amount0).to.be.at.most(amount0Max);
                  expect(amounts.amount1).to.be.lt(amount1Max);
                }
                expect(amounts.mintAmount).to.be.gt(ZERO);

                // Unbalanced amounts with 0 balance token1
                amount0Max = ethers.utils.parseEther("1");
                amount1Max = ZERO;

                await expect(
                  grizzlyVault.getMintAmounts(amount0Max, amount1Max)
                ).to.be.revertedWith("mint 0");

                // Unbalanced amounts with 0 balance token1
                amount0Max = ZERO;
                amount1Max = ethers.utils.parseEther("1");

                await expect(
                  grizzlyVault.getMintAmounts(amount0Max, amount1Max)
                ).to.be.revertedWith("mint 0");

                // Both balances equal to 0
                amount0Max = ZERO;
                amount1Max = ZERO;

                await expect(
                  grizzlyVault.getMintAmounts(amount0Max, amount1Max)
                ).to.be.revertedWith("mint 0");
              });
            });
            describe("Get underlying balances", () => {
              it("Should correctly get the balances with empty pool", async () => {
                const balances = await grizzlyVault.getUnderlyingBalances();

                expect(balances.amount0Current).to.be.eq(BigNumber.from(0));
                expect(balances.amount1Current).to.be.eq(BigNumber.from(0));
              });

              it("Should correctly get the balances with charged pool", async () => {
                // Deployer loads the pool with some tokens
                const amount0MaxDep = defaultAmount0;
                const amount1MaxDep = defaultAmount1;

                const amountsDep = await grizzlyVault.getMintAmounts(
                  amount0MaxDep,
                  amount1MaxDep
                );

                await token0.approve(grizzlyVault.address, amountsDep.amount0);
                await token1.approve(grizzlyVault.address, amountsDep.amount1);

                await grizzlyVault.mint(
                  amountsDep.mintAmount,
                  deployerGrizzly.address
                );

                // We check the balances
                const balances = await grizzlyVault.getUnderlyingBalances();

                expect(balances.amount0Current).to.be.gt(BigNumber.from(0));
                expect(balances.amount1Current).to.be.gt(BigNumber.from(0));

                expect(balances.amount0Current).to.be.at.most(
                  amountsDep.amount0
                );
                expect(balances.amount1Current).to.be.at.most(
                  amountsDep.amount1
                );
              });

              it("Should correctly get the balances after some swaps", async () => {
                // Deployer loads the pool with some tokens
                const amount0MaxDep = defaultAmount0;
                const amount1MaxDep = defaultAmount1;

                const amountsDep = await grizzlyVault.getMintAmounts(
                  amount0MaxDep,
                  amount1MaxDep
                );

                await token0.approve(grizzlyVault.address, amountsDep.amount0);
                await token1.approve(grizzlyVault.address, amountsDep.amount1);

                await grizzlyVault.mint(
                  amountsDep.mintAmount,
                  deployerGrizzly.address
                );

                // We check the balances before
                const balancesBefore =
                  await grizzlyVault.getUnderlyingBalances();

                // We generate some asymmetric swaps
                await swapTest.washTrade(
                  uniswapPool.address,
                  ethers.utils.parseUnits("10", token0Decimals),
                  10000,
                  10,
                  0
                );

                // We check the balances
                const balances = await grizzlyVault.getUnderlyingBalances();

                expect(balances.amount0Current).to.be.gt(
                  balancesBefore.amount0Current
                );
                expect(balances.amount1Current).to.be.lt(
                  balancesBefore.amount1Current
                );
              });
            });
            describe("Get underlying balances at price", () => {
              //TODO: Not sure what this function will be used for
            });
            describe("Estimate Fees", () => {
              beforeEach(async () => {
                // Deployer loads the pool with some tokens
                const amount0MaxDep = defaultAmount0;
                const amount1MaxDep = defaultAmount1;

                const amountsDep = await grizzlyVault.getMintAmounts(
                  amount0MaxDep,
                  amount1MaxDep
                );

                await token0.approve(grizzlyVault.address, amountsDep.amount0);
                await token1.approve(grizzlyVault.address, amountsDep.amount1);

                await grizzlyVault.mint(
                  amountsDep.mintAmount,
                  deployerGrizzly.address
                );
              });
              it("Should provide 0 fees without swaps", async () => {
                const fees = await grizzlyVault.estimateFees();

                expect(fees.token0Fee).to.be.eq(0);
                expect(fees.token1Fee).to.be.eq(0);
              });

              it("Should gather token0 fees after 0 to 1 swaps", async () => {
                // We generate some swaps
                await swapTest.washTrade(
                  uniswapPool.address,
                  ethers.utils.parseUnits("1", token0Decimals),
                  10000,
                  10,
                  0
                );

                const fees = await grizzlyVault.estimateFees();

                expect(fees.token0Fee).to.be.gt(0);
                expect(fees.token1Fee).to.be.eq(0);
              });

              it("Should gather token1 fees after 1 to 0 swaps", async () => {
                // We generate some swaps
                await swapTest.washTrade(
                  uniswapPool.address,
                  ethers.utils.parseUnits("1", token1Decimals),
                  10000,
                  10,
                  1
                );

                const fees = await grizzlyVault.estimateFees();

                expect(fees.token0Fee).to.be.eq(0);
                expect(fees.token1Fee).to.be.gt(0);
              });

              it("Should gather both token fees after some swaps", async () => {
                // We generate some swaps
                await swapTest.washTrade(
                  uniswapPool.address,
                  ethers.utils.parseUnits("1", token0Decimals),
                  10000,
                  20,
                  2
                );

                const fees = await grizzlyVault.estimateFees();

                expect(fees.token0Fee).to.be.gt(0);
                expect(fees.token1Fee).to.be.gt(0);
              });
            });

            describe("Get position id", () => {
              it("Should get the correct id", async () => {
                const id = await grizzlyVault.getPositionID();

                // Manually calculate id
                const ticks = await grizzlyVault.baseTicks();
                const code = ethers.utils.solidityKeccak256(
                  ["address", "int24", "int24"],
                  [grizzlyVault.address, ticks.lowerTick, ticks.upperTick]
                );

                expect(id).to.be.eq(code);
              });
            });
          });

          describe("User Functions", () => {
            describe("Mint", () => {
              it("Should revert with wrong parameters", async () => {
                // revert when mint 0
                await expect(
                  grizzlyVault.connect(user).mint(0, user.address)
                ).to.be.revertedWith("mint 0");

                const amount0Max = BigNumber.from("100000");
                const amount1Max = BigNumber.from("100000");
                const amounts = await grizzlyVault.getMintAmounts(
                  amount0Max,
                  amount1Max
                );

                await token0
                  .connect(user)
                  .approve(grizzlyVault.address, amounts.amount0);
                await token1
                  .connect(user)
                  .approve(grizzlyVault.address, amounts.amount1);

                // revert when first mint is too small
                await expect(
                  grizzlyVault
                    .connect(user)
                    .mint(amounts.mintAmount, deployerGrizzly.address)
                ).to.be.revertedWith("min shares");
              });

              it("Should revert when missing approval", async () => {
                const amount0Max = defaultAmount0;
                const amount1Max = defaultAmount1;
                const amounts = await grizzlyVault.getMintAmounts(
                  amount0Max,
                  amount1Max
                );

                await token0
                  .connect(user)
                  .approve(grizzlyVault.address, amounts.amount0);

                await expect(
                  grizzlyVault
                    .connect(user)
                    .mint(amounts.mintAmount, user.address)
                ).to.be.reverted;

                //We reduce allowance to 0 on token0 and approve token1
                await token0.connect(user).approve(grizzlyVault.address, 0);
                await token1
                  .connect(user)
                  .approve(grizzlyVault.address, amounts.amount1);

                await expect(
                  grizzlyVault
                    .connect(user)
                    .mint(amounts.mintAmount, user.address)
                ).to.be.reverted;
              });

              it("Should correctly mint", async () => {
                // Check user balances before mint
                const token0BalanceBefore = await token0.balanceOf(
                  user.address
                );
                const token1BalanceBefore = await token1.balanceOf(
                  user.address
                );

                // We mint the first LP tokens
                const amount0MaxFirst = defaultAmount0;
                const amount1MaxFirst = defaultAmount1;
                let amounts = await grizzlyVault.getMintAmounts(
                  amount0MaxFirst,
                  amount1MaxFirst
                );

                token0
                  .connect(user)
                  .approve(grizzlyVault.address, amounts.amount0);
                token1
                  .connect(user)
                  .approve(grizzlyVault.address, amounts.amount1);

                const tx = await grizzlyVault
                  .connect(user)
                  .mint(amounts.mintAmount, user.address);

                // Check that event was emitted
                const receipt = await tx.wait();
                const events = receipt.events?.filter((e) => {
                  return e.event === "Minted";
                });
                if (!events) {
                  throw new Error("No events emitted on mint");
                }
                const args = events[0].args;
                if (!args) {
                  throw new Error("Event with no arguments");
                }
                expect(user.address).to.be.eq(args[0]);
                expect(amounts.mintAmount).to.be.eq(args[1]);
                expect(amounts.amount0).to.be.eq(args[2]);
                expect(amounts.amount1).to.be.eq(args[3]);

                // Check user balances after mint
                const token0BalanceAfter = await token0.balanceOf(user.address);
                const token1BalanceAfter = await token1.balanceOf(user.address);
                const lpBalanceAfter = await grizzlyVault.balanceOf(
                  user.address
                );

                expect(lpBalanceAfter).to.be.eq(amounts.mintAmount);
                expect(token0BalanceAfter).to.be.eq(
                  token0BalanceBefore.sub(amounts.amount0)
                );
                expect(token1BalanceAfter).to.be.eq(
                  token1BalanceBefore.sub(amounts.amount1)
                );

                // We mint a second time from deployer to user
                amounts = await grizzlyVault.getMintAmounts(
                  amount0MaxFirst,
                  amount1MaxFirst
                );

                token0.approve(grizzlyVault.address, amounts.amount0);
                token1.approve(grizzlyVault.address, amounts.amount1);

                await grizzlyVault.mint(amounts.mintAmount, user.address);

                // We check user LP balance
                const lpBalanceAfter2 = await grizzlyVault.balanceOf(
                  user.address
                );
                expect(lpBalanceAfter2).to.be.gt(lpBalanceAfter);
              });

              it("Should correctly mint after some swaps", async () => {
                // We generate some swaps
                await swapTest.washTrade(
                  uniswapPool.address,
                  defaultAmount0.div(100),
                  10000,
                  10,
                  0
                );

                // Check user balances before mint
                const token0BalanceBefore = await token0.balanceOf(
                  user.address
                );
                const token1BalanceBefore = await token1.balanceOf(
                  user.address
                );

                // We mint the first LP tokens
                const amount0MaxFirst = defaultAmount0;
                const amount1MaxFirst = defaultAmount1;
                let amounts = await grizzlyVault.getMintAmounts(
                  amount0MaxFirst,
                  amount1MaxFirst
                );

                await token0
                  .connect(user)
                  .approve(grizzlyVault.address, amounts.amount0);
                await token1
                  .connect(user)
                  .approve(grizzlyVault.address, amounts.amount1);

                await grizzlyVault
                  .connect(user)
                  .mint(amounts.mintAmount, user.address);

                // Check user balances after mint
                const token0BalanceAfter = await token0.balanceOf(user.address);
                const token1BalanceAfter = await token1.balanceOf(user.address);
                const lpBalanceAfter = await grizzlyVault.balanceOf(
                  user.address
                );

                expect(lpBalanceAfter).to.be.eq(amounts.mintAmount);
                expect(token0BalanceAfter).to.be.eq(
                  token0BalanceBefore.sub(amounts.amount0)
                );
                expect(token1BalanceAfter).to.be.eq(
                  token1BalanceBefore.sub(amounts.amount1)
                );

                // We generate some more swaps
                await swapTest.washTrade(
                  uniswapPool.address,
                  defaultAmount1.div(100),
                  10000,
                  10,
                  1
                );

                // We mint a second time from deployer to user
                amounts = await grizzlyVault.getMintAmounts(
                  amount0MaxFirst,
                  amount1MaxFirst
                );

                await token0.approve(grizzlyVault.address, amounts.amount0);
                await token1.approve(grizzlyVault.address, amounts.amount1);

                await grizzlyVault.mint(amounts.mintAmount, user.address);

                // We check user LP balance
                const lpBalanceAfter2 = await grizzlyVault.balanceOf(
                  user.address
                );
                expect(lpBalanceAfter2).to.be.gt(lpBalanceAfter);
              });
            });

            describe("Burn", () => {
              let mintAmount: BigNumber;
              let amount0: BigNumber;
              let amount1: BigNumber;
              let defaultMaxSlippage = BigNumber.from("5000");

              beforeEach(async () => {
                // We mint some tokens to be burned after
                const amount0Max = defaultAmount0;
                const amount1Max = defaultAmount1;
                const amounts = await grizzlyVault.getMintAmounts(
                  amount0Max,
                  amount1Max
                );
                mintAmount = amounts.mintAmount;
                amount0 = amounts.amount0;
                amount1 = amounts.amount1;

                await token0
                  .connect(user)
                  .approve(grizzlyVault.address, amount0);
                await token1
                  .connect(user)
                  .approve(grizzlyVault.address, amount1);

                await grizzlyVault.connect(user).mint(mintAmount, user.address);
              });

              it("Should revert if burn amount is 0", async () => {
                await expect(
                  grizzlyVault.burn(
                    BigNumber.from(0),
                    defaultMaxSlippage,
                    0,
                    user.address
                  )
                ).to.be.revertedWith("burn 0");
              });

              it("Should revert if user does not have enough LP tokens", async () => {
                const burnAmount = mintAmount.add(1);
                await expect(
                  grizzlyVault
                    .connect(user)
                    .burn(burnAmount, defaultMaxSlippage, 0, user.address)
                ).to.be.revertedWith("ERC20: burn amount exceeds balance");
              });

              it("Should burn and receive both tokens", async () => {
                const token0BalanceBefore = await token0.balanceOf(
                  user.address
                );
                const token1BalanceBefore = await token1.balanceOf(
                  user.address
                );

                await grizzlyVault
                  .connect(user)
                  .burn(mintAmount, 10000, 2, user.address);

                const lpBalanceAfter = await grizzlyVault.balanceOf(
                  user.address
                );
                const token0BalanceAfter = await token0.balanceOf(user.address);
                const token1BalanceAfter = await token1.balanceOf(user.address);

                expect(lpBalanceAfter).to.be.eq(BigNumber.from(0));
                expect(token0BalanceAfter).to.be.gt(token0BalanceBefore);
                expect(token1BalanceAfter).to.be.gt(token1BalanceBefore);
              });

              it("Should burn and receive only token 0 with enough slippage", async () => {
                const token0BalanceBefore = await token0.balanceOf(
                  user.address
                );
                const token1BalanceBefore = await token1.balanceOf(
                  user.address
                );

                const maxSlippage = BigNumber.from("50000"); //5%

                // We burn to get only token 0
                await grizzlyVault
                  .connect(user)
                  .burn(mintAmount, maxSlippage, 0, user.address);

                const lpBalanceAfter = await grizzlyVault.balanceOf(
                  user.address
                );
                const token0BalanceAfter = await token0.balanceOf(user.address);
                const token1BalanceAfter = await token1.balanceOf(user.address);

                expect(lpBalanceAfter).to.be.eq(BigNumber.from(0));
                expect(token0BalanceAfter).to.be.gt(token0BalanceBefore);
                expect(token1BalanceAfter).to.be.eq(token1BalanceBefore);
              });

              it("Should burn and receive only token 1 with enough slippage", async () => {
                const token0BalanceBefore = await token0.balanceOf(
                  user.address
                );
                const token1BalanceBefore = await token1.balanceOf(
                  user.address
                );

                const maxSlippage = BigNumber.from("50000"); //5%

                // We burn to get only token 1
                await grizzlyVault
                  .connect(user)
                  .burn(mintAmount, maxSlippage, 1, user.address);

                const lpBalanceAfter = await grizzlyVault.balanceOf(
                  user.address
                );
                const token0BalanceAfter = await token0.balanceOf(user.address);
                const token1BalanceAfter = await token1.balanceOf(user.address);

                expect(lpBalanceAfter).to.be.eq(BigNumber.from(0));
                expect(token0BalanceAfter).to.be.eq(token0BalanceBefore);
                expect(token1BalanceAfter).to.be.gt(token1BalanceBefore);
              });
            });
          });

          describe("External manager functions", () => {
            describe("Update config parameters", () => {
              it("Should revert if not manager", async () => {
                const newOracleSlippage = 3000;
                const newOracleSlippageInterval = 10800; //3 minutes
                const newTreasury = deployerGrizzly.address;

                // run as deployer
                await expect(
                  grizzlyVault.updateConfigParams(
                    newOracleSlippage,
                    newOracleSlippageInterval,
                    newTreasury
                  )
                ).to.be.revertedWith("Ownable: caller is not the manager");

                // run as user
                await expect(
                  grizzlyVault
                    .connect(user)
                    .updateConfigParams(
                      newOracleSlippage,
                      newOracleSlippageInterval,
                      newTreasury
                    )
                ).to.be.revertedWith("Ownable: caller is not the manager");
              });
              it("Should revert with wrong parameters", async () => {
                const newOracleSlippage = BigNumber.from("1000001");
                const newOracleSlippageInterval = 10800; //3 minutes
                const newTreasury = deployerGrizzly.address;

                await expect(
                  grizzlyVault
                    .connect(manager)
                    .updateConfigParams(
                      newOracleSlippage,
                      newOracleSlippageInterval,
                      newTreasury
                    )
                ).to.be.revertedWith("slippage too high");
              });
              it("Should correctly update parameters", async () => {
                const newOracleSlippage = 3000;
                const newOracleSlippageInterval = 10800; //3 minutes
                const newTreasury = deployerGrizzly.address;

                // update parameters and check event
                await expect(
                  grizzlyVault
                    .connect(manager)
                    .updateConfigParams(
                      newOracleSlippage,
                      newOracleSlippageInterval,
                      newTreasury
                    )
                )
                  .to.be.emit(grizzlyVault, "UpdateGrizzlyParams")
                  .withArgs(newOracleSlippage, newOracleSlippageInterval);

                // Check the parameters correctly changed
                const oracleSlippage = await grizzlyVault.oracleSlippage();
                const oracleSlippageInterval =
                  await grizzlyVault.oracleSlippageInterval();
                const managerTreasury = await grizzlyVault.managerTreasury();

                expect(oracleSlippage).to.be.eq(newOracleSlippage);
                expect(oracleSlippageInterval).to.be.eq(
                  newOracleSlippageInterval
                );
                expect(managerTreasury).to.be.eq(newTreasury);
              });
            });

            describe("Set manager fee", () => {
              it("Should revert if not manager", async () => {
                const managerFee = 3000;

                // run as deployer
                await expect(
                  grizzlyVault.setManagerFee(managerFee)
                ).to.be.revertedWith("Ownable: caller is not the manager");

                // run as user
                await expect(
                  grizzlyVault.connect(user).setManagerFee(managerFee)
                ).to.be.revertedWith("Ownable: caller is not the manager");
              });
              it("Should revert with wrong parameters", async () => {
                const managerFee = BigNumber.from("1000001");

                // try with fee 0
                await expect(
                  grizzlyVault.connect(manager).setManagerFee(0)
                ).to.be.revertedWith("invalid manager fee");

                // try with fee too high
                await expect(
                  grizzlyVault.connect(manager).setManagerFee(managerFee)
                ).to.be.revertedWith("invalid manager fee");
              });
              it("Should correctly update manager fee", async () => {
                const managerFee = 30000;

                // update fee and check event
                await expect(
                  grizzlyVault.connect(manager).setManagerFee(managerFee)
                )
                  .to.emit(grizzlyVault, "SetManagerFee")
                  .withArgs(managerFee);

                // Check the fee correctly changed
                const fee = await grizzlyVault.managerFee();
                expect(fee).to.be.eq(managerFee);
              });
            });

            describe("Set keeper address", () => {
              it("Should revert if not manager", async () => {
                const keeperAddress = bot.address;

                // run as deployer
                await expect(
                  grizzlyVault.setKeeperAddress(keeperAddress)
                ).to.be.revertedWith("Ownable: caller is not the manager");

                // run as user
                await expect(
                  grizzlyVault.connect(user).setKeeperAddress(keeperAddress)
                ).to.be.revertedWith("Ownable: caller is not the manager");
              });

              it("Should revert with wrong parameters", async () => {
                const keeperAddress = ethers.constants.AddressZero;

                // try with addreess 0
                await expect(
                  grizzlyVault.connect(manager).setKeeperAddress(keeperAddress)
                ).to.be.revertedWith("zeroAddress");
              });

              it("Should correctly sset keeper address", async () => {
                const keeperAddress = bot.address;

                // set new address
                await grizzlyVault
                  .connect(manager)
                  .setKeeperAddress(keeperAddress);

                // Check the keeper address correctly changed
                const keeper = await grizzlyVault.keeperAddress();
                expect(keeper).to.be.eq(keeperAddress);
              });
            });

            describe("Set manager parameters", () => {
              it("Should revert if not manager", async () => {
                const slippageUserMax = 7000;
                const slippageRebalanceMax = 5550;

                // run as deployer
                await expect(
                  grizzlyVault.setManagerParams(
                    slippageUserMax,
                    slippageRebalanceMax
                  )
                ).to.be.revertedWith("Ownable: caller is not the manager");

                // run as user
                await expect(
                  grizzlyVault
                    .connect(user)
                    .setManagerParams(slippageUserMax, slippageRebalanceMax)
                ).to.be.revertedWith("Ownable: caller is not the manager");
              });
              it("Should revert with wrong parameters", async () => {
                const slippageUserMax = BigNumber.from("1000001");
                const slippageRebalanceMax = BigNumber.from("1000001");

                await expect(
                  grizzlyVault
                    .connect(manager)
                    .setManagerParams(slippageUserMax, 5550)
                ).to.be.revertedWith("wrong inputs");

                await expect(
                  grizzlyVault
                    .connect(manager)
                    .setManagerParams(5550, slippageRebalanceMax)
                ).to.be.revertedWith("wrong inputs");

                await expect(
                  grizzlyVault
                    .connect(manager)
                    .setManagerParams(slippageUserMax, slippageRebalanceMax)
                ).to.be.revertedWith("wrong inputs");
              });

              it("Should correctly update parameters", async () => {
                const slippageUserMax = 7000;
                const slippageRebalanceMax = 5550;

                // update parameters
                await grizzlyVault
                  .connect(manager)
                  .setManagerParams(slippageUserMax, slippageRebalanceMax);

                // Check the parameters correctly changed
                const slippageUser = await grizzlyVault.slippageUserMax();
                const slippageRebalance =
                  await grizzlyVault.slippageRebalanceMax();

                expect(slippageRebalance).to.be.eq(slippageRebalanceMax);
                expect(slippageUser).to.be.eq(slippageUserMax);
              });
            });

            describe("Executive rebalance", () => {
              beforeEach(async () => {
                // Deployer loads the pool with some tokens
                const amount0MaxDep = defaultAmount0;
                const amount1MaxDep = defaultAmount1;

                const amountsDep = await grizzlyVault.getMintAmounts(
                  amount0MaxDep,
                  amount1MaxDep
                );

                await token0.approve(grizzlyVault.address, amountsDep.amount0);
                await token1.approve(grizzlyVault.address, amountsDep.amount1);

                await grizzlyVault.mint(
                  amountsDep.mintAmount,
                  deployerGrizzly.address
                );

                // We give bot manager authorization
                await grizzlyVault
                  .connect(manager)
                  .setKeeperAddress(bot.address);

                // We first make the evm go some seconds forward
                await helpers.time.increase(300);
              });
              it("Should revert if not manager", async () => {
                // run as deployer
                await expect(
                  grizzlyVault.executiveRebalance(
                    -tickSpacing,
                    tickSpacing,
                    3000
                  )
                ).to.be.revertedWith("Ownable: caller is not the manager");

                // run as user
                await expect(
                  grizzlyVault
                    .connect(user)
                    .executiveRebalance(-tickSpacing, tickSpacing, 3000)
                ).to.be.revertedWith("Ownable: caller is not the manager");

                // run as not yet apoproved bot
                await expect(
                  grizzlyVault
                    .connect(bot)
                    .executiveRebalance(-tickSpacing, tickSpacing, 3000)
                ).to.be.revertedWith("Ownable: caller is not the manager");
              });

              it("Should revert with wrong parameters", async () => {
                const id = await grizzlyVault.getPositionID();
                const liquidity = (await uniswapPool.positions(id))._liquidity;

                await expect(
                  grizzlyVault
                    .connect(manager)
                    .executiveRebalance(
                      -1 * tickSpacing,
                      tickSpacing + 1,
                      liquidity
                    )
                ).to.be.revertedWith("tickSpacing mismatch");

                await expect(
                  grizzlyVault
                    .connect(manager)
                    .executiveRebalance(
                      -2 * tickSpacing,
                      2 * tickSpacing,
                      liquidity.mul("10000000000")
                    )
                ).to.be.revertedWith("min liquidity");
              });

              it("Should correctly do an executive rebalance", async () => {
                // We read some values from the vault
                let id = await grizzlyVault.getPositionID();
                let liquidity = (await uniswapPool.positions(id))._liquidity;

                // We perform a rebalance on a tight interval
                const tx = await grizzlyVault
                  .connect(manager)
                  .executiveRebalance(
                    -2 * tickSpacing,
                    2 * tickSpacing,
                    liquidity
                  );

                // Check event emission
                const receipt = await tx.wait();
                const events = receipt.events?.filter((x) => {
                  return x.event == "Rebalance";
                });
                if (!events) {
                  throw new Error("No events when rebalance");
                }

                // Read new values from the vault
                const ticks = await grizzlyVault.baseTicks();
                id = await grizzlyVault.getPositionID();
                const newLiquidity = (await uniswapPool.positions(id))
                  ._liquidity;

                // Check event parameters
                const args = events[0].args;
                if (!args) {
                  throw new Error("Event has no args");
                }
                expect(ticks.lowerTick).to.be.eq(args[0]);
                expect(ticks.upperTick).to.be.eq(args[1]);
                expect(liquidity).to.be.eq(args[2]);
                expect(newLiquidity).to.be.eq(args[3]);

                //Check change in liquidity and ticks
                expect(newLiquidity).to.be.gt(liquidity);
                expect(ticks.lowerTick).to.be.eq(-2 * tickSpacing);
                expect(ticks.upperTick).to.be.eq(2 * tickSpacing);
              });
            });
          });

          describe("External authorized functions", () => {
            describe("Rebalance", () => {
              beforeEach(async () => {
                // Deployer mints a position
                const amount0MaxDep = defaultAmount0;
                const amount1MaxDep = defaultAmount1;

                const amountsDep = await grizzlyVault.getMintAmounts(
                  amount0MaxDep,
                  amount1MaxDep
                );

                await token0.approve(grizzlyVault.address, amountsDep.amount0);
                await token1.approve(grizzlyVault.address, amountsDep.amount1);

                await grizzlyVault.mint(
                  amountsDep.mintAmount,
                  deployerGrizzly.address
                );

                // We give bot manager authorization
                await grizzlyVault
                  .connect(manager)
                  .setKeeperAddress(bot.address);

                // We first make the evm go some seconds forward
                await helpers.time.increase(300);
              });
              it("Should revert if not authorized", async () => {
                // run rebalance as deployer
                await expect(grizzlyVault.rebalance()).to.be.revertedWith(
                  "not authorized"
                );

                // run rebalance as user
                await expect(
                  grizzlyVault.connect(user).rebalance()
                ).to.be.revertedWith("not authorized");
              });

              // Slippage generation depends on every pool
              // it.skip("Should revert when slippage is high", async () => {
              //   // We make some swaps to produce slippage
              //   await swapTest.washTrade(
              //     uniswapPool.address,
              //     zeroForOne ? defaultAmount0 : defaultAmount1,
              //     50000,
              //     10,
              //     zeroForOne ? 0 : 1
              //   );

              //   await expect(
              //     grizzlyVault.connect(manager).rebalance()
              //   ).to.be.revertedWith("high slippage");
              // });

              it("Should revert if liquidity did not increase", async () => {
                await expect(
                  grizzlyVault.connect(manager).rebalance()
                ).to.be.revertedWith("liquidity must increase");
              });
              it("Should let manager to rebalance", async () => {
                // WARNING: This test could fail for WBTC/USD* pools

                // We make some swaps to generate fees
                await swapTest.washTrade(
                  uniswapPool.address,
                  BigNumber.from("100000000"),
                  10000,
                  10,
                  2
                );

                // We read some values from the vault
                const ticks = await grizzlyVault.baseTicks();
                const id = await grizzlyVault.getPositionID();
                const liquidity = (await uniswapPool.positions(id))._liquidity;

                const tx = await grizzlyVault.connect(manager).rebalance();

                // Check event emission
                const receipt = await tx.wait();
                const events = receipt.events?.filter((x) => {
                  return x.event == "Rebalance";
                });
                if (!events) {
                  throw new Error("No events when rebalance");
                }

                // Read new values
                const newLiquidity = (await uniswapPool.positions(id))
                  ._liquidity;

                // Check event parameters
                const args = events[0].args;
                if (!args) {
                  throw new Error("Event has no args");
                }
                expect(ticks.lowerTick).to.be.eq(args[0]);
                expect(ticks.upperTick).to.be.eq(args[1]);
                expect(liquidity).to.be.eq(args[2]);
                expect(newLiquidity).to.be.eq(args[3]);

                //Check change in liquidity
                expect(newLiquidity).to.be.gt(liquidity);

                // // Bot can perform the same operation without reverting
                // await swapTest.washTrade(
                //   uniswapPool.address,
                //   BigNumber.from("100000000"),
                //   10000,
                //   5,
                //   2
                // );

                // await grizzlyVault.connect(bot).rebalance();
              });
            });
            describe("Withdraw manager balance", () => {
              beforeEach(async () => {
                // Deployer loads the pool with some tokens
                const amount0MaxDep = defaultAmount0;
                const amount1MaxDep = defaultAmount1;

                const amountsDep = await grizzlyVault.getMintAmounts(
                  amount0MaxDep,
                  amount1MaxDep
                );

                await token0.approve(grizzlyVault.address, amountsDep.amount0);
                await token1.approve(grizzlyVault.address, amountsDep.amount1);

                await grizzlyVault.mint(
                  amountsDep.mintAmount,
                  deployerGrizzly.address
                );

                // We give bot manager authorization
                await grizzlyVault
                  .connect(manager)
                  .setKeeperAddress(bot.address);

                // We first make the evm go some seconds forward
                await helpers.time.increase(300);

                // We make some swaps too generate fees
                await swapTest.washTrade(
                  uniswapPool.address,
                  defaultAmount0.div(10),
                  10000,
                  10,
                  2
                );
              });
              it("Should revert if not authorized", async () => {
                // run as deployer
                await expect(
                  grizzlyVault.connect(user).withdrawManagerBalance()
                ).to.be.revertedWith("not authorized");

                // run as user
                await expect(
                  grizzlyVault.connect(user).withdrawManagerBalance()
                ).to.be.revertedWith("not authorized");
              });

              it("Should get 0 manager fees with 0 parameter", async () => {
                // We rebalance to apply fees
                await grizzlyVault.connect(manager).rebalance();

                // We check manager balances before
                const balance0Before = await token0.balanceOf(manager.address);
                const balance1Before = await token1.balanceOf(manager.address);

                // Manager withdraws fees to default address = manager
                await grizzlyVault.connect(manager).withdrawManagerBalance();

                // We compare them afterwards
                const balance0After = await token0.balanceOf(manager.address);
                const balance1After = await token1.balanceOf(manager.address);

                expect(balance0After).to.be.eq(balance0Before);
                expect(balance1After).to.be.eq(balance1Before);
              });

              it("Should get 0 manager fees with no burns or rebalances", async () => {
                // Increase manager fee to 50%
                await grizzlyVault.connect(manager).setManagerFee(500000);

                // We check manager balances before
                const balance0Before = await token0.balanceOf(manager.address);
                const balance1Before = await token1.balanceOf(manager.address);

                // Manager withdraws fees to default address = manager
                await grizzlyVault.connect(manager).withdrawManagerBalance();

                // We compare them afterwards
                const balance0After = await token0.balanceOf(manager.address);
                const balance1After = await token1.balanceOf(manager.address);

                expect(balance0After).to.be.eq(balance0Before);
                expect(balance1After).to.be.eq(balance1Before);
              });

              it("Should get some manager fees after burn", async () => {
                // Increase manager fee to 50%
                await grizzlyVault.connect(manager).setManagerFee(500000);

                // We burn some liquidity to apply fees to
                const balanceLP = await grizzlyVault.balanceOf(
                  deployerGrizzly.address
                );
                await grizzlyVault.approve(grizzlyVault.address, balanceLP);
                await grizzlyVault.burn(
                  balanceLP,
                  50000,
                  1,
                  deployerGrizzly.address
                );

                // We check manager balances before
                const balance0Before = await token0.balanceOf(manager.address);
                const balance1Before = await token1.balanceOf(manager.address);

                // Manager withdraws fees to default address = manager
                await grizzlyVault.connect(manager).withdrawManagerBalance();

                // We compare them afterwards
                const balance0After = await token0.balanceOf(manager.address);
                const balance1After = await token1.balanceOf(manager.address);

                expect(balance0After).to.be.gt(balance0Before);
                expect(balance1After).to.be.gt(balance1Before);
              });

              it("Should get some manager fees after rebalance", async () => {
                // Increase manager fee to 50%
                await grizzlyVault.connect(manager).setManagerFee(500000);

                // We rebalance to apply fees
                await grizzlyVault.connect(manager).rebalance();

                // We check manager balances before
                const balance0Before = await token0.balanceOf(manager.address);
                const balance1Before = await token1.balanceOf(manager.address);

                // Manager withdraws fees to default address = manager
                await grizzlyVault.connect(manager).withdrawManagerBalance();

                // We compare them afterwards
                const balance0After = await token0.balanceOf(manager.address);
                const balance1After = await token1.balanceOf(manager.address);

                expect(balance0After).to.be.gt(balance0Before);
                expect(balance1After).to.be.gt(balance1Before);
              });
            });
          });
        });
      });
    });
  });
});
