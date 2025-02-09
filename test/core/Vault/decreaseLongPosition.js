const { expect, use } = require("chai")
const { solidity } = require("ethereum-waffle")
const { deployContract } = require("../../shared/fixtures")
const { expandDecimals, getBlockTime, increaseTime, mineBlock, reportGasUsed } = require("../../shared/utilities")
const { toChainlinkPrice } = require("../../shared/chainlink")
const { toUsd, toNormalizedPrice } = require("../../shared/units")
const { initVault, getBnbConfig, getBtcConfig, getDaiConfig, validateVaultBalance } = require("./helpers")

use(solidity)

describe("Vault.decreaseLongPosition", function () {
  const provider = waffle.provider
  const [wallet, user0, user1, user2, user3] = provider.getWallets()
  let vault
  let vaultPriceFeed
  let usdg
  let router
  let bnb
  let bnbPriceFeed
  let btc
  let btcPriceFeed
  let dai
  let daiPriceFeed
  let distributor0
  let yieldTracker0
  let vaultUtils

  beforeEach(async () => {
    bnb = await deployContract("Token", [])
    bnbPriceFeed = await deployContract("PriceFeed", [])

    btc = await deployContract("Token", [])
    btcPriceFeed = await deployContract("PriceFeed", [])

    dai = await deployContract("Token", [])
    daiPriceFeed = await deployContract("PriceFeed", [])

    vault = await deployContract("Vault", [])
    usdg = await deployContract("USDG", [vault.address])
    router = await deployContract("Router", [vault.address, usdg.address, bnb.address])
    vaultPriceFeed = await deployContract("VaultPriceFeed", [])

    const { vaultUtils: _vaultUtils } = await initVault(vault, router, usdg, vaultPriceFeed)
    vaultUtils = _vaultUtils

    distributor0 = await deployContract("TimeDistributor", [])
    yieldTracker0 = await deployContract("YieldTracker", [usdg.address])

    await yieldTracker0.setDistributor(distributor0.address)
    await distributor0.setDistribution([yieldTracker0.address], [1000], [bnb.address])

    await bnb.mint(distributor0.address, 5000)
    await usdg.setYieldTrackers([yieldTracker0.address])

    await vaultPriceFeed.setTokenConfig(bnb.address, bnbPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(btc.address, btcPriceFeed.address, 8, false)
    await vaultPriceFeed.setTokenConfig(dai.address, daiPriceFeed.address, 8, false)

    await vault.setFees(
      50, // _taxBasisPoints
      20, // _stableTaxBasisPoints
      30, // _mintBurnFeeBasisPoints
      30, // _swapFeeBasisPoints
      4, // _stableSwapFeeBasisPoints
      10, // _marginFeeBasisPoints
      toUsd(5), // _liquidationFeeUsd
      60 * 60, // _minProfitTime
      false // _hasDynamicFees
    )
  })

  it("decreasePosition long", async () => {
    await daiPriceFeed.setLatestAnswer(toChainlinkPrice(1))
    await vault.setTokenConfig(...getDaiConfig(dai, daiPriceFeed))

    await expect(vault.connect(user1).decreasePosition(user0.address, btc.address, btc.address, 0, 0, true, user2.address))
      .to.be.revertedWith("Vault: invalid msg.sender")

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))
    await vault.setTokenConfig(...getBtcConfig(btc, btcPriceFeed))

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))

    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, 0, toUsd(1000), true, user2.address))
      .to.be.revertedWith("Vault: empty position")

    await btc.mint(user1.address, expandDecimals(1, 8))
    await btc.connect(user1).transfer(vault.address, 250000) // 0.0025 BTC => 100 USD
    await vault.buyUSDG(btc.address, user1.address)

    await btc.mint(user0.address, expandDecimals(1, 8))
    await btc.connect(user1).transfer(vault.address, 25000) // 0.00025 BTC => 10 USD
    await expect(vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(110), true))
      .to.be.revertedWith("Vault: reserve exceeds pool")

    await vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(90), true)

    let position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    expect(position[0]).eq(toUsd(90)) // size
    expect(position[1]).eq(toUsd(9.91)) // collateral, 10 - 90 * 0.1%
    expect(position[2]).eq(toNormalizedPrice(41000)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(225000) // reserveAmount, 0.00225 * 40,000 => 90

    // test that minProfitBasisPoints works as expected
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 - 1))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 - 1))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 - 1))
    let delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(false)
    expect(delta[1]).eq("2195121951219512195121951219") // ~0.00219512195 USD

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307)) // 41000 * 0.75% => 307.5
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307))
    delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(true)
    expect(delta[1]).eq("0")

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 308))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 308))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 308))
    delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(true)
    expect(delta[1]).eq("676097560975609756097560975609") // ~0.676 USD

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(45100))

    delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(false)
    expect(delta[1]).eq("2195121951219512195121951219512") // ~2.1951

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(46100))
    delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(false)
    expect(delta[1]).eq("2195121951219512195121951219512") // ~2.1951

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(47100))
    delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(true)
    expect(delta[1]).eq(toUsd(9))

    let leverage = await vault.getPositionLeverage(user0.address, btc.address, btc.address, true)
    expect(leverage).eq(90817) // ~9X leverage

    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, 0, toUsd(100), true, user2.address))
      .to.be.revertedWith("Vault: position size exceeded")

    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, toUsd(10), toUsd(50), true, user2.address))
      .to.be.revertedWith("SafeMath: subtraction overflow")

    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, toUsd(8.91), toUsd(50), true, user2.address))
      .to.be.revertedWith("Vault: liquidation fees exceed collateral")

    expect(await vault.feeReserves(btc.address)).eq(969)
    expect(await vault.reservedAmounts(btc.address)).eq(225000)
    expect(await vault.guaranteedUsd(btc.address)).eq(toUsd(80.09))
    expect(await vault.poolAmounts(btc.address)).eq(274250 - 219)
    expect(await btc.balanceOf(user2.address)).eq(0)

    const tx = await vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, toUsd(3), toUsd(50), true, user2.address)
    await reportGasUsed(provider, tx, "decreasePosition gas used")

    leverage = await vault.getPositionLeverage(user0.address, btc.address, btc.address, true)
    expect(leverage).eq(57887) // ~5.8X leverage

    position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    expect(position[0]).eq(toUsd(40)) // size
    expect(position[1]).eq(toUsd(9.91 - 3)) // collateral
    expect(position[2]).eq(toNormalizedPrice(41000)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(225000 / 90 * 40) // reserveAmount, 0.00225 * 40,000 => 90
    expect(position[5]).eq(toUsd(5)) // pnl
    expect(position[6]).eq(true)

    expect(await vault.feeReserves(btc.address)).eq(969 + 106) // 0.00000106 * 45100 => ~0.05 USD
    expect(await vault.reservedAmounts(btc.address)).eq(225000 / 90 * 40)
    expect(await vault.guaranteedUsd(btc.address)).eq(toUsd(33.09))
    expect(await vault.poolAmounts(btc.address)).eq(274250 - 219 - 16878 - 106 - 1)
    expect(await btc.balanceOf(user2.address)).eq(16878) // 0.00016878 * 47100 => 7.949538 USD

    await validateVaultBalance(expect, vault, btc, 1)
  })

  it("decreasePosition long minProfitBasisPoints", async () => {
    await daiPriceFeed.setLatestAnswer(toChainlinkPrice(1))
    await vault.setTokenConfig(...getDaiConfig(dai, daiPriceFeed))

    await expect(vault.connect(user1).decreasePosition(user0.address, btc.address, btc.address, 0, 0, true, user2.address))
      .to.be.revertedWith("Vault: invalid msg.sender")

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))
    await vault.setTokenConfig(...getBtcConfig(btc, btcPriceFeed))

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))

    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, 0, toUsd(1000), true, user2.address))
      .to.be.revertedWith("Vault: empty position")

    await btc.mint(user1.address, expandDecimals(1, 8))
    await btc.connect(user1).transfer(vault.address, 250000) // 0.0025 BTC => 100 USD
    await vault.buyUSDG(btc.address, user1.address)

    await btc.mint(user0.address, expandDecimals(1, 8))
    await btc.connect(user1).transfer(vault.address, 25000) // 0.00025 BTC => 10 USD
    await expect(vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(110), true))
      .to.be.revertedWith("Vault: reserve exceeds pool")

    await vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(90), true)

    let position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    expect(position[0]).eq(toUsd(90)) // size
    expect(position[1]).eq(toUsd(9.91)) // collateral, 10 - 90 * 0.1%
    expect(position[2]).eq(toNormalizedPrice(41000)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(225000) // reserveAmount, 0.00225 * 40,000 => 90

    // test that minProfitBasisPoints works as expected
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 - 1))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 - 1))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 - 1))
    let delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(false)
    expect(delta[1]).eq("2195121951219512195121951219") // ~0.00219512195 USD

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307)) // 41000 * 0.75% => 307.5
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307))
    delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(true)
    expect(delta[1]).eq("0")

    await increaseTime(provider, 50 * 60)
    await mineBlock(provider)

    delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(true)
    expect(delta[1]).eq("0")

    await increaseTime(provider, 10 * 60 + 10)
    await mineBlock(provider)

    delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(true)
    expect(delta[1]).eq("673902439024390243902439024390") // 0.67390243902
  })

  it("decreasePosition long with loss", async () => {
    await daiPriceFeed.setLatestAnswer(toChainlinkPrice(1))
    await vault.setTokenConfig(...getDaiConfig(dai, daiPriceFeed))

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))
    await vault.setTokenConfig(...getBtcConfig(btc, btcPriceFeed))

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))

    await btc.mint(user1.address, expandDecimals(1, 8))
    await btc.connect(user1).transfer(vault.address, 250000) // 0.0025 BTC => 100 USD
    await vault.buyUSDG(btc.address, user1.address)

    await btc.mint(user0.address, expandDecimals(1, 8))
    await btc.connect(user1).transfer(vault.address, 25000) // 0.00025 BTC => 10 USD
    await expect(vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(110), true))
      .to.be.revertedWith("Vault: reserve exceeds pool")

    await vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(90), true)

    let position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    expect(position[0]).eq(toUsd(90)) // size
    expect(position[1]).eq(toUsd(9.91)) // collateral, 10 - 90 * 0.1%
    expect(position[2]).eq(toNormalizedPrice(41000)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(225000) // reserveAmount, 0.00225 * 40,000 => 90

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40790))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40690))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40590))

    expect(await vault.feeReserves(btc.address)).eq(969)
    expect(await vault.reservedAmounts(btc.address)).eq(225000)
    expect(await vault.guaranteedUsd(btc.address)).eq(toUsd(80.09))
    expect(await vault.poolAmounts(btc.address)).eq(274250 - 219)
    expect(await btc.balanceOf(user2.address)).eq(0)

    let delta = await vault.getPositionDelta(user0.address, btc.address, btc.address, true)
    expect(delta[0]).eq(false)
    expect(delta[1]).eq(toUsd(0.9))

    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, toUsd(4), toUsd(50), true, user2.address))
      .to.be.revertedWith("liquidation fees exceed collateral")

    const tx = await vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, toUsd(0), toUsd(50), true, user2.address)
    await reportGasUsed(provider, tx, "decreasePosition gas used")

    position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    expect(position[0]).eq(toUsd(40)) // size
    expect(position[1]).eq(toUsd(9.36)) // collateral
    expect(position[2]).eq(toNormalizedPrice(41000)) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(100000) // reserveAmount, 0.00100 * 40,000 => 40
    expect(position[5]).eq(toUsd(0.5)) // pnl
    expect(position[6]).eq(false)

    expect(await vault.feeReserves(btc.address)).eq(969 + 122) // 0.00000122 * 40790 => ~0.05 USD
    expect(await vault.reservedAmounts(btc.address)).eq(100000)
    expect(await vault.guaranteedUsd(btc.address)).eq(toUsd(30.64))
    expect(await vault.poolAmounts(btc.address)).eq(274250 - 219 - 122)
    expect(await btc.balanceOf(user2.address)).eq(0)

    await vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, toUsd(0), toUsd(40), true, user2.address)

    position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    expect(position[0]).eq(0) // size
    expect(position[1]).eq(0) // collateral
    expect(position[2]).eq(0) // averagePrice
    expect(position[3]).eq(0) // entryFundingRate
    expect(position[4]).eq(0) // reserveAmount
    expect(position[5]).eq(0) // pnl
    expect(position[6]).eq(true)

    expect(await vault.feeReserves(btc.address)).eq(969 + 122 + 98) // 0.00000098 * 40790 => ~0.04 USD
    expect(await vault.reservedAmounts(btc.address)).eq(0)
    expect(await vault.guaranteedUsd(btc.address)).eq(0)
    expect(await vault.poolAmounts(btc.address)).eq(274250 - 219 - 122 - 98 - 21868)
    expect(await btc.balanceOf(user2.address)).eq(21868) // 0.00021868 * 40790 => ~8.92 USD

    await validateVaultBalance(expect, vault, btc)
  })

  it("decreasePosition within withdrawal cooldown duration", async () => {
    await daiPriceFeed.setLatestAnswer(toChainlinkPrice(1))
    await vault.setTokenConfig(...getDaiConfig(dai, daiPriceFeed))

    await expect(vault.connect(user1).decreasePosition(user0.address, btc.address, btc.address, 0, 0, true, user2.address))
      .to.be.revertedWith("Vault: invalid msg.sender")

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))
    await vault.setTokenConfig(...getBtcConfig(btc, btcPriceFeed))

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(40000))

    await btc.mint(user1.address, expandDecimals(1, 8))
    await btc.connect(user1).transfer(vault.address, 250000) // 0.0025 BTC => 100 USD
    await vault.buyUSDG(btc.address, user1.address)

    await btc.mint(user0.address, expandDecimals(1, 8))

    await btc.connect(user1).transfer(vault.address, 25000) // 0.00025 BTC => 10 USD
    await vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(90), true)

    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307)) // 41000 * 0.75% => 307.5
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(41000 + 307))
    await btcPriceFeed.setLatestAnswer(toChainlinkPrice(47100))

    await vaultUtils.setWithdrawalCooldownDuration(6 * 60 * 60)

    // position is still closable inside withdrawal cooldown period
    await vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, 0, toUsd(90), true, user2.address)
    let position = await vault.getPosition(user0.address, btc.address, btc.address, true)

    await btc.connect(user1).transfer(vault.address, 50000)
    await vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(90), true)
    position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    // and also partially closable using same leverage
    await vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, position[1].div(5), position[0].div(5), true, user2.address)

    await btc.mint(user1.address, expandDecimals(1, 8))
    await btc.connect(user1).transfer(vault.address, 250000) // 0.0025 BTC => 100 USD
    await vault.buyUSDG(btc.address, user1.address)

    await btc.connect(user1).transfer(vault.address, 100000)
    await vault.connect(user0).increasePosition(user0.address, btc.address, btc.address, toUsd(90), true)
    position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, position[1].div(4), position[0].div(5), true, user2.address))
      .to.be.revertedWith("VaultUtils: cooldown duration not yet passed")

    await increaseTime(provider, 6 * 60 * 60 - 100)
    await mineBlock(provider)

    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, position[1].div(4), position[0].div(5), true, user2.address))
      .to.be.revertedWith("VaultUtils: cooldown duration not yet passed")

    await increaseTime(provider, 110)
    await mineBlock(provider)

    await vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, position[1].div(4), position[0].div(5), true, user2.address)

    position = await vault.getPosition(user0.address, btc.address, btc.address, true)
    await expect(vault.connect(user0).decreasePosition(user0.address, btc.address, btc.address, 0, position[0].div(2), true, user2.address))
      .to.be.revertedWith("VaultUtils: leverage is too low")
  })
})
