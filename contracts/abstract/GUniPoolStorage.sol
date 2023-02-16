// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.4;

import { OwnableUninitialized } from "./OwnableUninitialized.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/// @dev Single Global upgradeable state var storage base: APPEND ONLY
/// @dev Add all inherited contracts with state vars here: APPEND ONLY
/// @dev ERC20Upgradable Includes Initialize
// solhint-disable-next-line max-states-count
abstract contract GUniPoolStorage is
	ERC20Upgradeable, /* XXXX DONT MODIFY ORDERING XXXX */
	ReentrancyGuardUpgradeable,
	OwnableUninitialized
	// APPEND ADDITIONAL BASE WITH STATE VARS BELOW:
	// XXXX DONT MODIFY ORDERING XXXX
{
	// solhint-disable-next-line const-name-snakecase
	string public constant version = "1.0.0";
	// solhint-disable-next-line const-name-snakecase
	uint16 public constant gelatoFeeBPS = 250;

	struct Ticks {
		int24 lowerTick;
		int24 upperTick;
	}

	// XXXXXXXX DO NOT MODIFY ORDERING XXXXXXXX
	Ticks public baseTicks;

	uint16 public gelatoRebalanceBPS;
	uint16 public gelatoWithdrawBPS;
	uint16 public oracleSlippageBPS;
	uint32 public oracleSlippageInterval;

	uint16 public managerFeeBPS;
	address public managerTreasury;

	uint256 public managerBalance0;
	uint256 public managerBalance1;

	IUniswapV3Pool public pool;
	IERC20 public token0;
	IERC20 public token1;
	uint24 uniPoolFee;

	uint256 internal constant MIN_INITIAL_SHARES = 1e9;
	uint256 internal constant basisOne = 10000;

	// In bps, how much slippage we allow between swaps -> 50 = 0.5% slippage
	uint256 public slippageUserMax = 100;
	uint256 public slippageRebalanceMax = 100;

	bool internal isOriginal = true; // check for cloning

	address public immutable factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

	address public keeperAddress;

	// APPEND ADDITIONAL STATE VARS BELOW:
	// XXXXXXXX DO NOT MODIFY ORDERING XXXXXXXX

	event UpdateAdminTreasury(address oldAdminTreasury, address newAdminTreasury);

	event UpdateGelatoParams(
		uint16 gelatoRebalanceBPS,
		uint16 gelatoWithdrawBPS,
		uint16 oracleSlippageBPS,
		uint32 oracleSlippageInterval
	);

	event SetManagerFee(uint16 managerFee);

	modifier onlyAuthorized() {
		require(msg.sender == manager() || msg.sender == keeperAddress, "not authorized");
		_;
	}

	/// @notice initialize storage variables on a new G-UNI pool, only called once
	/// @param _name name of G-UNI token
	/// @param _symbol symbol of G-UNI token
	/// @param _pool address of Uniswap V3 pool
	/// @param _managerFeeBPS proportion of fees earned that go to manager treasury
	/// note that the 4 above params are NOT UPDATABLE AFTER INITIALIZATION
	/// @param _lowerTick initial lowerTick (only changeable with executiveRebalance)
	/// @param _lowerTick initial upperTick (only changeable with executiveRebalance)
	/// @param _manager_ address of manager (ownership can be transferred)
	function initialize(
		string memory _name,
		string memory _symbol,
		address _pool,
		uint16 _managerFeeBPS,
		int24 _lowerTick,
		int24 _upperTick,
		address _manager_
	) external initializer {
		require(_managerFeeBPS <= 10000 - gelatoFeeBPS, "mBPS");

		// these variables are immutable after initialization
		pool = IUniswapV3Pool(_pool);
		token0 = IERC20(pool.token0());
		token1 = IERC20(pool.token1());
		uniPoolFee = pool.fee();
		managerFeeBPS = _managerFeeBPS; // if set to 0 here manager can still initialize later

		// these variables can be updated by the manager
		oracleSlippageInterval = 5 minutes; // default: last five minutes;
		oracleSlippageBPS = 500; // default: 5% slippage
		gelatoWithdrawBPS = 100; // default: only auto withdraw if tx fee is lt 1% withdrawn
		gelatoRebalanceBPS = 200; // default: only rebalance if tx fee is lt 2% reinvested
		managerTreasury = _manager_; // default: treasury is admin
		baseTicks.lowerTick = _lowerTick;
		baseTicks.upperTick = _upperTick;
		_manager = _manager_;

		// e.g. "Gelato Uniswap V3 USDC/DAI LP" and "G-UNI"
		__ERC20_init(_name, _symbol);
		__ReentrancyGuard_init();
	}

	/// @notice change configurable parameters, only manager can call
	/// @param newRebalanceBPS controls frequency of gelato rebalances: gas fee to execute
	/// rebalance can be gelatoRebalanceBPS proportion of fees earned since last rebalance
	/// @param newWithdrawBPS controls frequency of gelato withdrawals: gas fee to execute
	/// withdrawal can be gelatoWithdrawBPS proportion of fees accrued since last withdraw
	/// @param newSlippageBPS maximum slippage on swaps during gelato rebalance
	/// @param newSlippageInterval length of time for TWAP used in computing slippage on swaps
	/// @param newTreasury address where managerFee withdrawals are sent
	// solhint-disable-next-line code-complexity
	function updateGelatoParams(
		uint16 newRebalanceBPS,
		uint16 newWithdrawBPS,
		uint16 newSlippageBPS,
		uint32 newSlippageInterval,
		address newTreasury
	) external onlyManager {
		require(newWithdrawBPS <= 10000, "BPS");
		require(newRebalanceBPS <= 10000, "BPS");
		require(newSlippageBPS <= 10000, "BPS");
		emit UpdateGelatoParams(
			newRebalanceBPS,
			newWithdrawBPS,
			newSlippageBPS,
			newSlippageInterval
		);
		if (newRebalanceBPS != 0) gelatoRebalanceBPS = newRebalanceBPS;
		if (newWithdrawBPS != 0) gelatoWithdrawBPS = newWithdrawBPS;
		if (newSlippageBPS != 0) oracleSlippageBPS = newSlippageBPS;
		if (newSlippageInterval != 0) oracleSlippageInterval = newSlippageInterval;
		if (newTreasury != address(0)) managerTreasury = newTreasury;
	}

	/// @notice initializeManagerFee sets a managerFee, only manager can call.
	/// If a manager fee was not set in the initialize function it can be set here
	/// but ONLY ONCE- after it is set to a non-zero value, managerFee can never be set again.
	/// @param _managerFeeBPS proportion of fees earned that are credited to manager in Basis Points
	function initializeManagerFee(uint16 _managerFeeBPS) external onlyManager {
		require(managerFeeBPS == 0, "fee");
		require(_managerFeeBPS > 0 && _managerFeeBPS <= 10000 - gelatoFeeBPS, "mBPS");
		emit SetManagerFee(_managerFeeBPS);
		managerFeeBPS = _managerFeeBPS;
	}

	function renounceOwnership() public virtual override onlyManager {
		managerTreasury = address(0);
		managerFeeBPS = 0;
		managerBalance0 = 0;
		managerBalance1 = 0;
		super.renounceOwnership();
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

	function setManagerParams(uint256 _slippageUserMax, uint256 _slippageRebalanceMax)
		external
		onlyManager
	{
		require(_slippageUserMax <= basisOne && _slippageRebalanceMax <= basisOne, "wrong inputs");
		slippageUserMax = _slippageUserMax;
		slippageRebalanceMax = _slippageRebalanceMax;
	}
}
