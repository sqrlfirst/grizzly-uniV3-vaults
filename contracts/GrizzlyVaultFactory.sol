// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.18;

import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3TickSpacing } from "./interfaces/IUniswapV3TickSpacing.sol";
import { IGrizzlyVaultFactory } from "./interfaces/IGrizzlyVaultFactory.sol";
import { IGrizzlyVaultStorage } from "./interfaces/IGrizzlyVaultStorage.sol";
import { TickMath } from "./uniswap/TickMath.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract GrizzlyVaultFactory is IGrizzlyVaultFactory, Ownable {
	using EnumerableSet for EnumerableSet.AddressSet;

	string public constant NAME = "GrizzlyVaultCloneFactory";
	string public constant VERSION = "1.0.0";

	address public immutable factory = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

	address public implementation;
	address public grizzlyDeployer;

	mapping(address => EnumerableSet.AddressSet) internal _vaults;

	event VaultCreated(address indexed uniPool, address indexed manager, address indexed vault);
	event ImplementationVaultChanged(address newImplementation, address origImplementation);

	constructor(address _implementation, address _grizzlyDeployer) {
		implementation = _implementation;
		grizzlyDeployer = _grizzlyDeployer;
	}

	/// @notice getGrizzlyVaults gets all the Grizzly Vaults deployed by Grizzly's
	/// default deployer address (since anyone can deploy and manage Grizzly Vaults)
	/// @return array of Grizzly managed Vault addresses
	function getGrizzlyVaults() external view returns (address[] memory) {
		return getVaults(grizzlyDeployer);
	}

	/// @notice getVaults fetches all the Grizzly Vault addresses deployed by `deployer`
	/// @param deployer Address that has potentially deployed Grizzly Vaults (can return empty array)
	/// @return vaults Array of Grizzly Vault addresses deployed by `deployer`
	function getVaults(address deployer) public view returns (address[] memory) {
		uint256 length = numVaults(deployer);
		address[] memory vaults = new address[](length);
		for (uint256 i = 0; i < length; i++) {
			vaults[i] = _getVault(deployer, i);
		}

		return vaults;
	}

	/// @notice numVaults counts the total number of Grizzly Vaults deployed by `deployer`
	/// @param deployer Deployer address
	/// @return total Number of Grizzly Vaults deployed by `deployer`
	function numVaults(address deployer) public view returns (uint256) {
		return _vaults[deployer].length();
	}

	function _getVault(address deployer, uint256 index) internal view returns (address) {
		return _vaults[deployer].at(index);
	}

	// ---- Cloning ---- //

	/// @notice clones our original vault implementation contract functionality in an immutable way
	/// Clones have the exact same logic as the implementation contract but with its own storage state
	/// @param tokenA One of the tokens in the uniswap pair
	/// @param tokenB The other token in the uniswap pair
	/// @param uniFee Fee tier of the uniswap pair
	/// @param managerFee Proportion of earned fees that go to pool manager in Basis Points
	/// @param lowerTick Initial lower bound of the Uniswap V3 position
	/// @param upperTick Initial upper bound of the Uniswap V3 position
	/// @param manager Address of the manager of the new Vault
	/// @return newVault Address of the newly created Grizzly Vault (proxy)
	// solhint-disable-next-line function-max-lines
	function cloneGrizzlyVault(
		address tokenA,
		address tokenB,
		uint24 uniFee,
		uint24 managerFee,
		int24 lowerTick,
		int24 upperTick,
		address manager
	) external override returns (address newVault) {
		(address token0, address token1) = _getTokenOrder(tokenA, tokenB);

		string memory name = "Grizzly Uniswap LP";
		try this.getTokenName(token0, token1) returns (string memory result) {
			name = result;
		} catch {} // solhint-disable-line no-empty-blocks

		address uniPool = IUniswapV3Factory(factory).getPool(token0, token1, uniFee);
		require(uniPool != address(0), "uniV3Pool does not exist");
		require(_validateTickSpacing(uniPool, lowerTick, upperTick), "tickSpacing mismatch");

		// Copied from https://github.com/optionality/clone-factory/blob/master/contracts/CloneFactory.sol
		bytes20 addressBytes = bytes20(implementation);
		assembly {
			// EIP-1167 bytecode
			let clone_code := mload(0x40)
			mstore(clone_code, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
			mstore(add(clone_code, 0x14), addressBytes)
			mstore(
				add(clone_code, 0x28),
				0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000
			)
			newVault := create(0, clone_code, 0x37)
		}

		IGrizzlyVaultStorage(newVault).initialize(
			name,
			string(
				abi.encodePacked(
					"hs",
					IERC20Metadata(address(token0)).symbol(),
					"-",
					IERC20Metadata(address(token1)).symbol()
				)
			),
			uniPool,
			managerFee,
			lowerTick,
			upperTick,
			manager
		);

		_vaults[msg.sender].add(newVault);

		emit VaultCreated(uniPool, manager, newVault);
	}

	function _validateTickSpacing(
		address uniPool,
		int24 lowerTick,
		int24 upperTick
	) internal view returns (bool) {
		int24 spacing = IUniswapV3TickSpacing(uniPool).tickSpacing();
		return
			lowerTick < upperTick &&
			lowerTick % spacing == 0 &&
			upperTick % spacing == 0 &&
			lowerTick >= TickMath.MIN_TICK &&
			upperTick <= TickMath.MAX_TICK;
	}

	function _getTokenOrder(
		address tokenA,
		address tokenB
	) internal pure returns (address token0, address token1) {
		require(tokenA != tokenB, "same token");
		(token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
		require(token0 != address(0), "zeroAddress");
	}

	function getTokenName(address token0, address token1) external view returns (string memory) {
		string memory symbol0 = IERC20Metadata(token0).symbol();
		string memory symbol1 = IERC20Metadata(token1).symbol();

		return _append("Grizzly Uniswap ", symbol0, "/", symbol1, " LP");
	}

	function _append(
		string memory a,
		string memory b,
		string memory c,
		string memory d,
		string memory e
	) internal pure returns (string memory) {
		return string(abi.encodePacked(a, b, c, d, e));
	}

	function setImplementationVault(address _newImplementation) external onlyOwner {
		require(_newImplementation != address(0), "zeroAddress");
		address oldImplementationVault = implementation;
		implementation = _newImplementation;
		emit ImplementationVaultChanged(implementation, oldImplementationVault);
	}
}

