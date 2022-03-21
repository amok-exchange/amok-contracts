require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-etherscan");
require("hardhat-contract-sizer");
require("@typechain/hardhat");

const { SNOWTRACE_API_KEY, AVAX_DEPLOY_KEY, AVAX_URL } = require("./env.json");

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    // avax: {
    //   url: AVAX_URL,
    //   gasPrice: 100000000000,
    //   chainId: 43114,
    //   accounts: [AVAX_DEPLOY_KEY],
    // },
  },
  etherscan: {
    apiKey: SNOWTRACE_API_KEY,
  },
  solidity: {
    version: "0.6.12",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
    },
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },
};
