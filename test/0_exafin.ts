import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, BigNumber } from "ethers";
import {
  ExactlyEnv,
  ExaTime,
  parseBorrowEvent,
  parseSupplyEvent,
} from "./exactlyUtils";
import { formatUnits, parseUnits } from "ethers/lib/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

Error.stackTraceLimit = Infinity;

describe("Exafin", function () {
  let exactlyEnv: ExactlyEnv;

  let underlyingToken: Contract;
  let exafin: Contract;
  let auditor: Contract;

  let tokensCollateralRate = new Map([
    ["DAI", parseUnits("0.8", 18)],
    ["ETH", parseUnits("0.7", 18)],
  ]);

  // Oracle price is in 10**6
  let tokensUSDPrice = new Map([
    ["DAI", parseUnits("1", 6)],
    ["ETH", parseUnits("3100", 6)],
  ]);

  let mariaUser: SignerWithAddress;
  let johnUser: SignerWithAddress;
  let owner: SignerWithAddress;
  let now: number;
  let exaTime: ExaTime;

  let snapshot: any;

  beforeEach(async () => {
    [owner, mariaUser, johnUser] = await ethers.getSigners();

    exactlyEnv = await ExactlyEnv.create(tokensUSDPrice, tokensCollateralRate);

    underlyingToken = exactlyEnv.getUnderlying("DAI");
    exafin = exactlyEnv.getExafin("DAI");
    auditor = exactlyEnv.auditor;

    // From Owner to User
    underlyingToken.transfer(mariaUser.address, parseUnits("100"));

    exaTime = new ExaTime(); // Defaults to now
    now = exaTime.timestamp;

    // This can be optimized (so we only do it once per file, not per test)
    // This helps with tests that use evm_setNextBlockTimestamp
    snapshot = await ethers.provider.send("evm_snapshot", []);
  });

  it("it allows to give money to a pool", async () => {
    const underlyingAmount = parseUnits("100");
    await underlyingToken.approve(exafin.address, underlyingAmount);

    let tx = await exafin.supply(owner.address, underlyingAmount, now);
    let event = await parseSupplyEvent(tx);

    expect(event.from).to.equal(owner.address);
    expect(event.amount).to.equal(underlyingAmount);
    expect(event.maturityDate).to.equal(exaTime.nextPoolID().timestamp);

    expect(await underlyingToken.balanceOf(exafin.address)).to.equal(
      underlyingAmount
    );
  });

  it("it allows you to borrow money", async () => {
    let exafinMaria = exafin.connect(mariaUser);
    let auditorUser = auditor.connect(mariaUser);
    let underlyingTokenUser = underlyingToken.connect(mariaUser);

    await underlyingTokenUser.approve(exafin.address, parseUnits("1"));
    await exafinMaria.supply(mariaUser.address, parseUnits("1"), now);
    await auditorUser.enterMarkets([exafinMaria.address]);
    expect(
      await exafinMaria.borrow(mariaUser.address, parseUnits("0.8"), now)
    ).to.emit(exafinMaria, "Borrowed");
  });

  it("it doesnt allow mariaUser to borrow money because not collateralized enough", async () => {
    let exafinMaria = exafin.connect(mariaUser);
    let auditorUser = auditor.connect(mariaUser);
    let underlyingTokenUser = underlyingToken.connect(mariaUser);

    await underlyingTokenUser.approve(exafin.address, parseUnits("1"));
    await exafinMaria.supply(mariaUser.address, parseUnits("1"), now);
    await auditorUser.enterMarkets([exafinMaria.address]);
    await expect(exafinMaria.borrow(mariaUser.address, parseUnits("0.9"), now))
      .to.be.reverted;
  });

  it("Calculates the right rate to supply", async () => {
    let exafinMaria = exafin.connect(mariaUser);
    let underlyingTokenUser = underlyingToken.connect(mariaUser);
    let unitsToSupply = parseUnits("1");

    let [rateSupplyToApply, poolStateAfterSupply] =
      await exafinMaria.rateForSupply(unitsToSupply, now);

    // We verify that the state of the pool is what we suppose it is
    expect(poolStateAfterSupply[1]).to.be.equal(unitsToSupply);
    expect(poolStateAfterSupply[0]).to.be.equal(0);

    // We supply the money
    await underlyingTokenUser.approve(exafin.address, unitsToSupply);
    let tx = await exafinMaria.supply(mariaUser.address, unitsToSupply, now);
    let supplyEvent = await parseSupplyEvent(tx);

    // It should be the base rate since there are no other deposits
    let nextExpirationDate = exaTime.nextPoolID().timestamp;
    let daysToExpiration = exaTime.daysDiffWith(nextExpirationDate);
    let yearlyRateProjected = BigNumber.from(rateSupplyToApply)
      .mul(365)
      .div(daysToExpiration);

    // Expected "19999999999999985" to be within 20 of 20000000000000000
    expect(BigNumber.from(yearlyRateProjected)).to.be.closeTo(
      exactlyEnv.baseRate,
      100
    );

    // We expect that the actual rate was taken when we submitted the supply transaction
    expect(supplyEvent.commission).to.be.closeTo(
      unitsToSupply.mul(rateSupplyToApply).div(parseUnits("1")),
      20
    );
  });

  it("Calculates the right rate to borrow", async () => {
    let exafinMaria = exafin.connect(mariaUser);
    let underlyingTokenUser = underlyingToken.connect(mariaUser);
    let unitsToSupply = parseUnits("1");
    let unitsToBorrow = parseUnits("0.8");

    await underlyingTokenUser.approve(exafin.address, unitsToSupply);
    await exafinMaria.supply(mariaUser.address, unitsToSupply, now);

    let [rateBorrowToApply, poolStateAfterBorrow] =
      await exafinMaria.rateToBorrow(unitsToBorrow, now);

    expect(poolStateAfterBorrow[1]).to.be.equal(unitsToSupply);
    expect(poolStateAfterBorrow[0]).to.be.equal(unitsToBorrow);

    let tx = await exafinMaria.borrow(mariaUser.address, unitsToBorrow, now);
    expect(tx).to.emit(exafinMaria, "Borrowed");
    let borrowEvent = await parseBorrowEvent(tx);

    // It should be the base rate since there are no other deposits
    let nextExpirationDate = exaTime.nextPoolID().timestamp;
    let daysToExpiration = exaTime.daysDiffWith(nextExpirationDate);

    // We just receive the multiplying factor for the amount "rateBorrowToApply"
    // so by multiplying we get the APY
    let yearlyRateProjected = BigNumber.from(rateBorrowToApply)
      .mul(365)
      .div(daysToExpiration);

    // This Rate is purely calculated on JS/TS side
    let yearlyRateCalculated = exactlyEnv.baseRate
      .add(exactlyEnv.marginRate)
      .add(exactlyEnv.slopeRate.mul(unitsToBorrow).div(unitsToSupply));

    // Expected "85999999999999996" to be within 20 of 86000000000000000
    expect(yearlyRateProjected).to.be.closeTo(yearlyRateCalculated, 100);

    // We expect that the actual rate was taken when we submitted the borrowing transaction
    expect(borrowEvent.commission).to.be.closeTo(
      unitsToBorrow.mul(rateBorrowToApply).div(parseUnits("1")),
      100
    );
  });

  it("it allows the mariaUser to withdraw money only after maturity", async () => {

    await ethers.provider.send("hardhat_reset", []);

    // give the protocol some solvency
    await underlyingToken.transfer(exafin.address, parseUnits("100"));
    let originalAmount = await underlyingToken.balanceOf(mariaUser.address);

    // connect through Maria
    let exafinMaria = exafin.connect(mariaUser);
    let underlyingTokenUser = underlyingToken.connect(mariaUser);

    // supply some money and parse event
    await underlyingTokenUser.approve(exafin.address, parseUnits("1"));
    let tx = await exafinMaria.supply(mariaUser.address, parseUnits("1"), now);
    let supplyEvent = await parseSupplyEvent(tx);

    console.log("LUCAS------");
    console.log(now);

    // try to redeem before maturity
    await expect(
      exafinMaria.redeem(
        mariaUser.address,
        supplyEvent.amount,
        supplyEvent.commission,
        now
      )
    ).to.be.revertedWith("Pool not matured yet");

    // Move in time to maturity
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      exaTime.nextPoolID().timestamp,
    ]);
    await ethers.provider.send("evm_mine", []);

    // finally redeem voucher and we expect maria to have her original amount + the comission earned
    await exafinMaria.redeem(
      mariaUser.address,
      supplyEvent.amount,
      supplyEvent.commission,
      now
    );
    expect(await underlyingToken.balanceOf(mariaUser.address)).to.be.equal(
      originalAmount.add(supplyEvent.commission)
    );
  });

  it('it allows the mariaUser to repay her debt only after maturity', async () => {
    // give the protocol some solvency
    await underlyingToken.transfer(exafin.address, parseUnits("100"));

    // connect through Maria
    let originalAmount = await underlyingToken.balanceOf(mariaUser.address);
    let exafinMaria = exafin.connect(mariaUser);
    let underlyingTokenUser = underlyingToken.connect(mariaUser);

    // supply some money and parse event
    await underlyingTokenUser.approve(exafin.address, parseUnits("5.0"));
    let txSupply = await exafinMaria.supply(mariaUser.address, parseUnits("1"), now);
    let supplyEvent = await parseSupplyEvent(txSupply);
    let tx = await exafinMaria.borrow(mariaUser.address, parseUnits("0.8"), now);
    let borrowEvent = await parseBorrowEvent(tx);

    // try to redeem before maturity
    await expect(
      exafinMaria.repay(
        mariaUser.address,
        mariaUser.address,
        borrowEvent.amount,
        borrowEvent.commission,
        now
      )
    ).to.be.revertedWith("Pool not matured yet");

    // Move in time to maturity
    await ethers.provider.send('evm_setNextBlockTimestamp', [exaTime.nextPoolID().timestamp]);
    await ethers.provider.send('evm_mine', []);

    // try to pay a little less and fail
    await expect(
      exafinMaria.repay(
        mariaUser.address,
        mariaUser.address,
        borrowEvent.amount.sub(10),
        borrowEvent.commission,
        now
      )
    ).to.be.revertedWith("debt must be paid in full");

    // repay and succeed
    await exafinMaria.repay(
      mariaUser.address,
      mariaUser.address,
      borrowEvent.amount,
      borrowEvent.commission,
      now
    );

    // finally redeem voucher and we expect maria to have her original amount + the comission earned - comission paid
    await exafinMaria.redeem(
      mariaUser.address,
      supplyEvent.amount,
      supplyEvent.commission,
      now
    );

    expect(
        await underlyingToken.balanceOf(mariaUser.address)
    ).to.be.equal(
        originalAmount
            .add(supplyEvent.commission)
            .sub(borrowEvent.commission)
    );
  });

  afterEach(async () => {
    await ethers.provider.send("evm_revert", [snapshot]);
  });
});
