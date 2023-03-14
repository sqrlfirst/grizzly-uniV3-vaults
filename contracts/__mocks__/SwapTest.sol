// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.18;

// solhint-disable max-line-length
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IUniswapV3SwapCallback } from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { prbSqrt } from "@prb/math/src/Common.sol";

contract SwapTest is IUniswapV3SwapCallback {
	uint24 public constant BASIS = 1e6;
	uint24 public constant BASIS_SQRT = 1e3;

	function swap(
		address pool,
		bool zeroForOne,
		int256 amountSpecified,
		uint24 maxSlippage
	) external {
		(uint160 sqrtRatio, , , , , , ) = IUniswapV3Pool(pool).slot0();
		uint256 limitPrice = zeroForOne
			? (sqrtRatio * prbSqrt(BASIS - maxSlippage)) / BASIS_SQRT
			: (sqrtRatio * prbSqrt(BASIS + maxSlippage)) / BASIS_SQRT;
		IUniswapV3Pool(pool).swap(
			address(msg.sender),
			zeroForOne,
			amountSpecified,
			uint160(limitPrice),
			abi.encode(msg.sender)
		);
	}

	function washTrade(
		address pool,
		int256 amountSpecified,
		uint24 maxSlippage,
		uint256 numTrades,
		uint256 ratio
	) external {
		for (uint256 i = 0; i < numTrades; i++) {
			bool zeroForOne = ratio == 0 ? true : i % ratio > 0;
			(uint160 sqrtRatio, , , , , , ) = IUniswapV3Pool(pool).slot0();

			uint256 limitPrice = zeroForOne
				? (sqrtRatio * prbSqrt(BASIS - maxSlippage)) / BASIS_SQRT
				: (sqrtRatio * prbSqrt(BASIS + maxSlippage)) / BASIS_SQRT;
			IUniswapV3Pool(pool).swap(
				address(msg.sender),
				zeroForOne,
				amountSpecified,
				uint160(limitPrice),
				abi.encode(msg.sender)
			);
		}
	}

	function getSwapResult(
		address pool,
		bool zeroForOne,
		int256 amountSpecified,
		uint160 sqrtPriceLimitX96
	) external returns (int256 amount0Delta, int256 amount1Delta, uint160 nextSqrtRatio) {
		(amount0Delta, amount1Delta) = IUniswapV3Pool(pool).swap(
			address(msg.sender),
			zeroForOne,
			amountSpecified,
			sqrtPriceLimitX96,
			abi.encode(msg.sender)
		);

		(nextSqrtRatio, , , , , , ) = IUniswapV3Pool(pool).slot0();
	}

	function uniswapV3SwapCallback(
		int256 amount0Delta,
		int256 amount1Delta,
		bytes calldata data
	) external override {
		address sender = abi.decode(data, (address));

		if (amount0Delta > 0) {
			IERC20(IUniswapV3Pool(msg.sender).token0()).transferFrom(
				sender,
				msg.sender,
				uint256(amount0Delta)
			);
		} else if (amount1Delta > 0) {
			IERC20(IUniswapV3Pool(msg.sender).token1()).transferFrom(
				sender,
				msg.sender,
				uint256(amount1Delta)
			);
		}
	}
}

