// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.4;

import {
	ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

contract MockERC20 is ERC20Upgradeable {
	// constructor() {
	// 	__ERC20_init("", "TOKEN");
	// 	_mint(msg.sender, 100000e18);
	// }
	function initialize(string memory _tokenName, string memory _tokenSymbol)
		public
		initializer
	{
		__ERC20_init(_tokenName, _tokenSymbol);
		_mint(msg.sender, 100000e18);
	}
}

