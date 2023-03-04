// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.18;

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IGrizzlyVaultStorage } from "./IGrizzlyVaultStorage.sol";

interface IGrizzlyVault is IGrizzlyVaultStorage {
	function pool() external view returns (IUniswapV3Pool);

	function token0() external view returns (IERC20);

	function token1() external view returns (IERC20);

	function baseTicks() external view returns (Ticks memory);

	function getMintAmounts(
		uint256 amount0Max,
		uint256 amount1Max
	) external returns (uint256 amount0, uint256 amount1, uint256 mintAmount);

	function mint(
		uint256 mintAmount,
		address receiver
	) external returns (uint256 amount0, uint256 amount1, uint128 liquidityMinted);
}

