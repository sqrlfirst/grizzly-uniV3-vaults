# Grizzly UniV3 Vaults

![](./images/bear.png)

A shared fungible (ERC20) position for Uniswap V3 passive liquidity providers. Grizzly Vaults are auto-compounded to reinvest accrued fees into the position.
The position bounds are static by default, but can be updated by vault manager via `executiveRebalance` which redeposits liquidity into a new range.

## Grizzly Vaults Overview

### Mint

```JavaScript
    function mint(uint256 mintAmount, address receiver)
        external
        nonReentrant
        returns (
            uint256 amount0,
            uint256 amount1,
            uint128 liquidityMinted
        ) {
```

Arguments:

- `mintAmount` amount of Grizzly vault tokens to mint
- `receiver` account that receives the Grizzly vault tokens

Returns:

- `amount0` amount of token0 actually deposited into Grizzly vault
- `amount1` amount of token1 actually deposited into Grizzly vault
- `liquidityMinted` amount of liquidity added to Grizzly vault position

Note: to find out the amount of token0 and token1 you would owe by minting that many Grizzly vault tokens use `getMintAmounts` view method.

### Burn

```JavaScript
	function burn(
		uint256 burnAmount,
		bool onlyToken0,
		bool onlyToken1,
		address receiver
	)
		external
		nonReentrant
		returns (
			uint256 amount0,
			uint256 amount1,
			uint128 liquidityBurned
		) {
```

Arguments:

- `_burnAmount` number of Grizzly vault tokens to burn
- `onlyToken0` if true the user zaps out with only token0
- `onlyToken1` if true the user zaps out with only token1
- `receiver` account that receives the remitted token0 and token1

Returns:

- `amount0` amount of token0 remitted to receiver
- `amount1` amount of token1 remitted to receiver
- `liquidityBurned` amount of liquidity burned from Grizzly vault position

### getMintAmounts (view call)

```JavaScript
    function getMintAmounts(uint256 amount0Max, uint256 amount1Max)
        external
        view
        returns (
            uint256 amount0,
            uint256 amount1,
            uint256 mintAmount
        ) {
```

Arguments:

- `amount0Max` maximum amount of token0 to deposit into Grizzly vault
- `amount1Max` maximum amount of token1 to deposit into Grizzly vault

Returns:

- `amount0` actual amount of token0 to deposit into Grizzly vault
- `amount1` actual amount of token1 to deposit into Grizzly vault
- `mintAmount` amount of Grizzly vault tokens to pass to mint function (will cost exactly `amount0` and `amount1`)

### Rebalance

```
function rebalance() external onlyAuthorized
```

Note: Reinvest fees earned into underlying position, only authorized executors can call.

### ExecutiveRebalance (for managed pools)

If governance/admin wants to change bounds of the underlying position, or wants to force a rebalance for any other reason, they are allowed to call this executive rebalance function.

```JavaScript
	function executiveRebalance(
		int24 newLowerTick,
		int24 newUpperTick,
		uint128 minLiquidity
	) external onlyManager {
```

Arguments:

- `newLowerTick` the tick to use as position lower bound on reinvestment
- `newUpperTick` the tick to use as position upper bound on reinvestment
- `minLiquidity` minimum liquidity of the new position in order to not revert

## ZapContract Overview

### ZapIn

Basic zap that allows to deposit in the vault with one of the underlying pool tokens.
ZapContract balances properly the amounts in order to maximize the liquidity provision.

```JavaScript
    function zapIn(
    	address pool,
    	address vault,
    	uint256 amount0Desired,
    	uint256 amount1Desired,
    	uint256 maxSwapSlippage
    ) external {
```

Arguments:

- `pool` the desired UniV3 pool to zapIn
- `vault` the Grizzly vault chosen to deposit the tokens
- `amount0Desired` amount of token0 the user wants to invest into the vault
- `amount1Desired` amount of token1 the user wants to invest into the vault
- `maxSwapSlippage` maxSlippage allowed for the underlying swap

## GrizzlyVaultFactory Overview

### cloneGrizzlyVault

Every clone is a 100% replica of the Vault instance but serving for different variables.
The proxy factory pattern helps us to deploy a bunch of immutable Vault clones with a considerably lower gas cost.
These clones have the exact same logic as the implementation contract but with its own storage state.

```JavaScript
	function cloneGrizzlyVault(
		address tokenA,
		address tokenB,
		uint24 uniFee,
		uint24 managerFee,
		int24 lowerTick,
		int24 upperTick,
		address manager
	) external override returns (address newVault) {
```

Arguments:

- `tokenA` one of the tokens in the uniswap pair
- `tokenB` the other token in the uniswap pair
- `uniFee` fee tier of the uniswap pair
- `managerFee` proportion of earned fees that go to pool manager
- `lowerTick` initial lower bound of the Uniswap V3 position
- `upperTick` initial upper bound of the Uniswap V3 position
- `manager` address of the manager of the new Vault

## Project set up

### Dependencies

To install all the dependencies run

```
yarn
```

### Tests

Tests are performed on a mainnet fork. Set your Alchemy key on an .env file. See [.env.example](/.env.example).

Some tests are performed on mainnet pools. To configure the information of these pools check [this file](/test/data/pools.ts).

To perform all the tests run

```
yarn hardhat test
```

### Deployement

To deploy contracts, first set up your private key in a .env file, as in [.env.example](/.env.example), and run:

```bash
yarn hardhat deploy --network <network> --tags <network>
```

### Verify on Etherscan

To verify your deployed contracts, first set up your Etherscan API key in a .env file, as in [.env.example](/.env.example), and run:

```bash
yarn hardhat --network <network> etherscan-verify
```
