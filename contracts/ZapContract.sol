// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.4;

import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IGrizzlyVault } from "./interfaces/IGrizzlyVault.sol";
import { TickMath } from "./uniswap/TickMath.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import { LiquidityAmounts } from "./uniswap/LiquidityAmounts.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

contract ZapContract is IUniswapV3SwapCallback, Ownable {
	using SafeERC20 for IERC20;
	using TickMath for int24;

	struct CallbackData {
		address token0;
		address token1;
		address pool;
	}

	// Needed to avoid error compiler stack too deep
	struct LocalVariables_zapIn {
		IERC20 token0;
		IERC20 token1;
		uint256 intermediateAmount0;
		uint256 intermediateAmount1;
	}

	struct LocalVariables_balanceAmounts {
		uint160 sqrtRatioX96;
		uint24 uniPoolFee;
		int256 amount0Delta;
		int256 amount1Delta;
	}

	string public constant name = "GrizzlyVaultZapContract";
	string public constant version = "1.0.0";

	uint256 internal constant basisOne = 1000000;

	// In bps, how much slippage we allow between swaps -> 5000 = 0.5% slippage
	uint256 public slippageUserMax = 5000;

	event ZapInVault(address sender, address vault, uint256 shares);

	// --- UniV3 callback functions --- //

	/// @notice Uniswap v3 callback function, called back on pool.swap
	function uniswapV3SwapCallback(
		int256 amount0Delta,
		int256 amount1Delta,
		bytes calldata data
	) external override {
		CallbackData memory info = abi.decode(data, (CallbackData));

		require(msg.sender == info.pool, "callback caller");

		if (amount0Delta > 0) IERC20(info.token0).safeTransfer(msg.sender, uint256(amount0Delta));
		if (amount1Delta > 0) IERC20(info.token1).safeTransfer(msg.sender, uint256(amount1Delta));
	}

	// --- User functions --- //

	function zapIn(
		address pool,
		address vault,
		uint256 amount0Desired,
		uint256 amount1Desired,
		uint256 maxSwapSlippage
	) external {
		// Sanity check
		require(address(IGrizzlyVault(vault).pool()) == pool, "wrong pool");

		LocalVariables_zapIn memory vars;

		IGrizzlyVault.Ticks memory ticks = IGrizzlyVault(vault).baseTicks();

		vars.token0 = IGrizzlyVault(vault).token0();
		vars.token1 = IGrizzlyVault(vault).token1();

		if (amount0Desired > 0) // Transfer desired amounts to contract
		{
			vars.token0.safeTransferFrom(msg.sender, address(this), amount0Desired);
		}
		if (amount1Desired > 0) {
			vars.token1.safeTransferFrom(msg.sender, address(this), amount1Desired);
		}

		(vars.intermediateAmount0, vars.intermediateAmount1) = _balanceAmounts(
			pool,
			ticks,
			amount0Desired,
			amount1Desired,
			maxSwapSlippage,
			abi.encode(
				CallbackData({
					token0: address(vars.token0),
					token1: address(vars.token1),
					pool: pool
				})
			)
		);

		(uint256 finalAmount0, uint256 finalAmount1, uint256 mintAmount) = IGrizzlyVault(vault)
			.getMintAmounts(vars.intermediateAmount0, vars.intermediateAmount1);

		// Approvals
		vars.token0.safeIncreaseAllowance(vault, finalAmount0);
		vars.token1.safeIncreaseAllowance(vault, finalAmount1);

		IGrizzlyVault(vault).mint(mintAmount, msg.sender);

		_transferUserLeftAmounts(vars.token0, vars.token1, msg.sender);

		emit ZapInVault(msg.sender, vault, mintAmount);
	}

	// --- Internal core functions --- //

	function _balanceAmounts(
		address pool,
		IGrizzlyVault.Ticks memory ticks,
		uint256 amount0Desired,
		uint256 amount1Desired,
		uint256 maxSwapSlippage,
		bytes memory data
	) internal returns (uint256 finalAmount0, uint256 finalAmount1) {
		LocalVariables_balanceAmounts memory vars;

		(vars.sqrtRatioX96, , , , , , ) = IUniswapV3Pool(pool).slot0();

		// Get max liquidity for amounts available
		uint128 liquidity = _liquidityForAmounts(
			ticks,
			vars.sqrtRatioX96,
			amount0Desired,
			amount1Desired
		);
		// Get correct amounts of each token for the liquidity we have
		(uint256 amount0, uint256 amount1) = _amountsForLiquidity(
			liquidity,
			ticks,
			vars.sqrtRatioX96
		);

		// Determine the trade direction
		bool _zeroForOne;
		if (amount1Desired == 0) {
			_zeroForOne = true;
		} else {
			_zeroForOne = _amountsDirection(amount0Desired, amount1Desired, amount0, amount1);
		}

		vars.uniPoolFee = IUniswapV3Pool(pool).fee();

		// Determine the amount to swap, it is not 100% precise but is a very good approximation
		uint256 _amountSpecified = _zeroForOne
			? ((amount0Desired - amount0) * basisOne) / (2 * basisOne + vars.uniPoolFee)
			: ((amount1Desired - amount1) * basisOne) / (2 * basisOne + vars.uniPoolFee);

		if (_amountSpecified > 0) {
			(vars.amount0Delta, vars.amount1Delta) = _swap(
				pool,
				_amountSpecified,
				_zeroForOne,
				maxSwapSlippage,
				data
			);
			finalAmount0 = uint256(SafeCast.toInt256(amount0Desired) - vars.amount0Delta);
			finalAmount1 = uint256(SafeCast.toInt256(amount1Desired) - vars.amount1Delta);
		} else {
			return (amount0, amount1);
		}
	}

	/// @notice maxSwapSlippage variable as argument to have flexibility with different liquidity pools
	function _swap(
		address pool,
		uint256 amountIn,
		bool zeroForOne,
		uint256 maxSwapSlippage,
		bytes memory data
	) internal returns (int256, int256) {
		// If the maxSwapSlippage argument is not provided we use default slippageUserMax state variable
		uint256 _slippageMax = maxSwapSlippage == 0 ? slippageUserMax : maxSwapSlippage;

		(uint160 _sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
		uint256 _slippage = zeroForOne ? (basisOne - _slippageMax) : (basisOne + _slippageMax);

		return
			IUniswapV3Pool(pool).swap(
				address(this),
				zeroForOne, // Swap direction, true: token0 -> token1, false: token1 -> token0
				int256(amountIn),
				uint160(uint256((_sqrtPriceX96 * _slippage) / basisOne)), // sqrtPriceLimitX96
				data
			);
	}

	function _transferUserLeftAmounts(IERC20 token0, IERC20 token1, address receiver) internal {
		uint256 token0Balance = token0.balanceOf(address(this));
		uint256 token1Balance = token1.balanceOf(address(this));

		if (token0Balance > 0) {
			token0.safeTransfer(receiver, token0Balance);
		}

		if (token1Balance > 0) {
			token1.safeTransfer(receiver, token1Balance);
		}
	}

	// --- Internal view functions --- //

	/// @notice Computes the token0 and token1 value for a given amount of liquidity
	function _amountsForLiquidity(
		uint128 liquidity,
		IGrizzlyVault.Ticks memory ticks,
		uint160 sqrtRatioX96
	) internal view returns (uint256, uint256) {
		return
			LiquidityAmounts.getAmountsForLiquidity(
				sqrtRatioX96,
				ticks.lowerTick.getSqrtRatioAtTick(),
				ticks.upperTick.getSqrtRatioAtTick(),
				liquidity
			);
	}

	/// @notice Gets the liquidity for the available amounts of token0 and token1
	function _liquidityForAmounts(
		IGrizzlyVault.Ticks memory ticks,
		uint160 sqrtRatioX96,
		uint256 amount0,
		uint256 amount1
	) internal view returns (uint128) {
		return
			LiquidityAmounts.getLiquidityForAmounts(
				sqrtRatioX96,
				ticks.lowerTick.getSqrtRatioAtTick(),
				ticks.upperTick.getSqrtRatioAtTick(),
				amount0,
				amount1
			);
	}

	/// @dev Needed in case token0 and token1 have different decimals
	function _amountsDirection(
		uint256 amount0Desired,
		uint256 amount1Desired,
		uint256 amount0,
		uint256 amount1
	) internal pure returns (bool zeroGreaterOne) {
		zeroGreaterOne = (amount0Desired - amount0) * amount1Desired >
			(amount1Desired - amount1) * amount0Desired
			? true
			: false;
	}
}
