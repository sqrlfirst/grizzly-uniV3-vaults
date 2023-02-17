// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.4;

interface IGrizzlyVaultStorage {
	// Needed to avoid error compiler stack too deep
	struct LocalVariables_burn {
		uint256 totalSupply;
		uint256 liquidityBurnt;
		int256 amount0Delta;
		int256 amount1Delta;
	}

	struct Ticks {
		int24 lowerTick;
		int24 upperTick;
	}

	function initialize(
		string memory _name,
		string memory _symbol,
		address _pool,
		uint16 _managerFeeBPS,
		int24 _lowerTick,
		int24 _upperTick,
		address _manager
	) external;
}
