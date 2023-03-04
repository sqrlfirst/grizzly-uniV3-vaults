// SPDX-License-Identifier: MIT
pragma solidity 0.8.18;

interface IGrizzlyVaultFactory {
	function cloneGrizzlyVault(
		address tokenA,
		address tokenB,
		uint24 uniFee,
		uint24 managerFee,
		int24 lowerTick,
		int24 upperTick,
		address manager
	) external returns (address newVault);
}

