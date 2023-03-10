import { HardhatUserConfig } from "hardhat/config";

// PLUGINS
import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-etherscan";
import "@nomiclabs/hardhat-waffle";
import "@typechain/hardhat";
import "@nomicfoundation/hardhat-network-helpers";
import "hardhat-deploy";
import "solidity-coverage";
import "hardhat-contract-sizer";
import "hardhat-tracer";
import "hardhat-ignore-warnings";
import "./lib/uniswap";

// Process Env Variables
import * as dotenv from "dotenv";
dotenv.config({ path: __dirname + "/.env" });
const ALCHEMY_ID = process.env.ALCHEMY_ID;
const DEPLOYER_PK_MAINNET = process.env.DEPLOYER_PK_MAINNET;
const DEPLOYER_PK = process.env.DEPLOYER_PK;

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",

  // hardhat-deploy
  namedAccounts: {
    deployer: 0,
    manager: 1,
  },

  networks: {
    mainnet: {
      accounts: DEPLOYER_PK_MAINNET ? [DEPLOYER_PK_MAINNET] : [],
      chainId: 1,
      url: `https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_ID}`,
    },
    goerli: {
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
      chainId: 5,
      url: `https://eth-goerli.alchemyapi.io/v2/${ALCHEMY_ID}`,
    },
    sepolia: {
      accounts: DEPLOYER_PK ? [DEPLOYER_PK] : [],
      chainId: 5,
      url: `https://eth-sepolia.alchemyapi.io/v2/${ALCHEMY_ID}`,
    },
    localhost: {
      chainId: 1,
      url: "http://127.0.0.1:8545/",
      allowUnlimitedContractSize: true,
      timeout: 1000 * 60,
    },
    hardhat: {
      forking: {
        url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_ID}`,
        blockNumber: 16678850,
      },
    },
  },

  solidity: {
    compilers: [
      {
        version: "0.7.3",
        settings: {
          optimizer: { enabled: true },
        },
      },
      {
        version: "0.8.18",
        settings: {
          optimizer: { enabled: true, runs: 500 },
        },
      },
    ],
  },

  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY,
    },
  },

  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },

  contractSizer: {
    alphaSort: true,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
  },

  warnings: {
    // removes pure/view mutability warning:
    "*": {
      "func-mutability": "off",
      default: "warn",
    },
  },
};

export default config;
