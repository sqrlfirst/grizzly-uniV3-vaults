import { expect } from "chai";
import bn from "bignumber.js";
import { BigNumber, BigNumberish } from "ethers";
import { ethers, deployments } from "hardhat";
import {
  IERC20,
  IUniswapV3Factory,
  IUniswapV3Pool,
  GrizzlyVault,
  GrizzlyVaultFactory,
} from "../typechain";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
//import * as helpers from "@nomicfoundation/hardhat-network-helpers";

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

  let token0: IERC20;
  let token1: IERC20;
  let grizzlyCoreVault: GrizzlyVault;
  let grizzlyVault: GrizzlyVault;
  let grizzlyFactory: GrizzlyVaultFactory;

  let uniswapPoolAddress: string;
  let vaultAddress: string;

  let deployerGrizzly: SignerWithAddress;
  let manager: SignerWithAddress;
  let user: SignerWithAddress;
  let bot: SignerWithAddress;

  before(async () => {
    [deployerGrizzly, manager, user, bot] = await ethers.getSigners();
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

    token0 = await ethers.getContract("Token0", deployerGrizzly);
    token1 = await ethers.getContract("Token1", deployerGrizzly);

    // We charge user account with some tokens
    token0.transfer(user.address, ethers.utils.parseEther("100"));
    token1.transfer(user.address, ethers.utils.parseEther("100"));

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

    vaultAddress = (await grizzlyFactory.getVaults(deployerGrizzly.address))[0];

    grizzlyVault = await ethers.getContractAt("GrizzlyVault", vaultAddress);
  });

  describe("Grizzly Vault Factory", () => {
    describe("External view functions", () => {
      it("Should get Token Name", async () => {
        const tokenName = await grizzlyFactory.getTokenName(
          token0.address,
          token1.address
        );
        expect(tokenName).to.be.eq("Grizzly Uniswap TOKEN0/TOKEN1 LP");
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

          grizzlyVault.mint(amountsDep.mintAmount, deployerGrizzly.address);

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
          // console.log(
          //   "BALANCES ",
          //   ethers.utils.formatEther(balances.amount0Current),
          //   ethers.utils.formatEther(balances.amount1Current)
          // );
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

          grizzlyVault.mint(amountsDep.mintAmount, deployerGrizzly.address);

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
          // TODO (use SwapTest.sol ?)
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

          // We check the balances
          const balances = await grizzlyVault.getUnderlyingBalances();

          expect(balances.amount0Current).to.be.eq(
            ethers.utils.parseEther("99.999999999999999998")
          );
          expect(balances.amount1Current).to.be.eq(
            ethers.utils.parseEther("99.999999999999999998")
          );
        });
      });
      describe("Get underlying balances at price", () => {});
      describe("Estimate Fees", () => {});
    });
    describe("User Functions", () => {
      describe("Mint", () => {});
      describe("Burn", () => {
        let mintAmount: BigNumber;
        let amount0: BigNumber;
        let amount1: BigNumber;
        let defaultMaxSlippage = BigNumber.from("5000");

        beforeEach(async () => {
          // We load the pool before being able to swap
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

          token0.connect(user).approve(grizzlyVault.address, amount0);
          token1.connect(user).approve(grizzlyVault.address, amount1);

          grizzlyVault.connect(user).mint(mintAmount, user.address);
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

          await grizzlyVault.connect(user).burn(mintAmount, 0, 2, user.address);

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

          // console.log(
          //   "TOKEN 0 DELTA:",
          //   ethers.utils.formatEther(
          //     token0BalanceAfter.sub(token0BalanceBefore)
          //   )
          // );

          // console.log(
          //   "TOKEN 1 DELTA:",
          //   ethers.utils.formatEther(
          //     token1BalanceAfter.sub(token1BalanceBefore)
          //   )
          // );
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
      describe("Executive rebalance", () => {
        it("Should revert if not manager", async () => {
          // run executiverebalance on vault as deployer
          await expect(
            grizzlyVault.executiveRebalance(-887220, 887220, 3000)
          ).to.be.revertedWith("Ownable: caller is not the manager");

          // run executiverebalance on vault as deployer
          await expect(
            grizzlyVault.connect(user).executiveRebalance(-887220, 887220, 3000)
          ).to.be.revertedWith("Ownable: caller is not the manager");
        });
      });
    });
    describe("External authorized functions", () => {
      describe("Rebalance", () => {
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
      });
      describe("Withdraw manager balance", () => {
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
      });
    });
  });
});

//TODO: Mainnet test revert "tickSpacing mismatch"
