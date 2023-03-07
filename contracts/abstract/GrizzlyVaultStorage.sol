// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.18;

import { OwnableUninitialized } from "./OwnableUninitialized.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3TickSpacing } from "../interfaces/IUniswapV3TickSpacing.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// solhint-disable max-line-length
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
// solhint-enable max-line-length
import { IGrizzlyVaultStorage } from "../interfaces/IGrizzlyVaultStorage.sol";

/// @dev Single Global upgradeable state var storage base
/// @dev Add all inherited contracts with state vars here
/// @dev ERC20Upgradable Includes Initialize
// solhint-disable-next-line max-states-count
abstract contract GrizzlyVaultStorage is
	IGrizzlyVaultStorage,
	ERC20Upgradeable,
	ReentrancyGuardUpgradeable,
	OwnableUninitialized
{
	string public constant VERSION = "1.0.0";

	Ticks public baseTicks;

	uint24 public oracleSlippage;
	uint32 public oracleSlippageInterval;

	uint24 public managerFee;
	address public managerTreasury;

	uint256 public managerBalance0;
	uint256 public managerBalance1;

	IUniswapV3Pool public pool;
	IERC20 public token0;
	IERC20 public token1;
	uint24 public uniPoolFee;

	/* solhint-disable */
	uint32 internal constant MIN_INITIAL_SHARES = 1e9;
	uint24 internal constant basisOne = 1000000;
	uint16 internal constant basisOneSqrt = 1000;
	/* solhint-enable */

	// How much slippage we allow between swaps -> 5000 = 0.5% slippage
	uint24 public slippageUserMax = 10000;
	uint24 public slippageRebalanceMax = 10000;

	address public immutable factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

	address public keeperAddress;

	event UpdateGrizzlyParams(uint24 oracleSlippage, uint32 oracleSlippageInterval);
	event SetManagerFee(uint24 managerFee);

	modifier onlyAuthorized() {
		require(msg.sender == manager() || msg.sender == keeperAddress, "not authorized");
		_;
	}

	/// @notice Initialize storage variables on a new Grizzly vault pool, only called once
	/// @param _name Name of Grizzly vault token
	/// @param _symbol Symbol of Grizzly vault token
	/// @param _pool Address of Uniswap V3 pool
	/// @param _managerFee Proportion of fees earned that go to manager treasury
	/// Note that the 4 above params are NOT UPDATABLE AFTER INITIALIZATION
	/// @param _lowerTick Initial lowerTick (only changeable with executiveRebalance)
	/// @param _lowerTick Initial upperTick (only changeable with executiveRebalance)
	/// @param _manager_ Address of manager (ownership can be transferred)
	function initialize(
		string memory _name,
		string memory _symbol,
		address _pool,
		uint24 _managerFee,
		int24 _lowerTick,
		int24 _upperTick,
		address _manager_
	) external override initializer {
		require(_managerFee <= basisOne, "fee too high");

		_validateTickSpacing(_pool, _lowerTick, _upperTick);

		// These variables are immutable after initialization
		pool = IUniswapV3Pool(_pool);
		token0 = IERC20(pool.token0());
		token1 = IERC20(pool.token1());
		uniPoolFee = pool.fee();
		managerFee = _managerFee; // if set to 0 here manager can still initialize later

		// These variables can be updated by the manager
		oracleSlippageInterval = 5 minutes; // default: last five minutes;
		oracleSlippage = 50000; // default: 5% slippage

		managerTreasury = _manager_; // default: treasury is admin

		baseTicks.lowerTick = _lowerTick;
		baseTicks.upperTick = _upperTick;

		_manager = _manager_;

		// e.g. "Grizzly Uniswap USDC/DAI LP" and "hsUSDC-DAI"
		__ERC20_init(_name, _symbol);
		__ReentrancyGuard_init();
	}

	/// @notice Change configurable parameters, only manager can call
	/// @param newOracleSlippage Maximum slippage on swaps during gelato rebalance
	/// @param newOracleSlippageInterval Length of time for TWAP used in computing slippage on swaps
	/// @param newTreasury Address where managerFee withdrawals are sent
	function updateConfigParams(
		uint24 newOracleSlippage,
		uint32 newOracleSlippageInterval,
		address newTreasury
	) external onlyManager {
		require(newOracleSlippage <= basisOne, "slippage too high");

		if (newOracleSlippage != 0) oracleSlippage = newOracleSlippage;
		if (newOracleSlippageInterval != 0) oracleSlippageInterval = newOracleSlippageInterval;
		emit UpdateGrizzlyParams(newOracleSlippage, newOracleSlippageInterval);

		if (newTreasury != address(0)) managerTreasury = newTreasury;
	}

	/// @notice setManagerFee sets a managerFee, only manager can call
	/// @param _managerFee Proportion of fees earned that are credited to manager in Basis Points
	function setManagerFee(uint24 _managerFee) external onlyManager {
		require(_managerFee > 0 && _managerFee <= basisOne, "fee too high");
		emit SetManagerFee(_managerFee);
		managerFee = _managerFee;
	}

	function getPositionID() external view returns (bytes32 positionID) {
		return _getPositionID(baseTicks);
	}

	function _getPositionID(Ticks memory _ticks) internal view returns (bytes32 positionID) {
		return keccak256(abi.encodePacked(address(this), _ticks.lowerTick, _ticks.upperTick));
	}

	function setKeeperAddress(address _keeperAddress) external onlyManager {
		require(_keeperAddress != address(0), "zeroAddress");
		keeperAddress = _keeperAddress;
	}

	function setManagerParams(
		uint24 _slippageUserMax,
		uint24 _slippageRebalanceMax
	) external onlyManager {
		require(_slippageUserMax <= basisOne && _slippageRebalanceMax <= basisOne, "wrong inputs");
		slippageUserMax = _slippageUserMax;
		slippageRebalanceMax = _slippageRebalanceMax;
	}

	function _validateTickSpacing(
		address uniPool,
		int24 lowerTick,
		int24 upperTick
	) internal view returns (bool) {
		int24 spacing = IUniswapV3TickSpacing(uniPool).tickSpacing();
		return lowerTick < upperTick && lowerTick % spacing == 0 && upperTick % spacing == 0;
	}
}
