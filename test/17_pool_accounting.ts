import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { ProtocolError, errorGeneric, ExaTime } from "./exactlyUtils";
import { PoolAccountingEnv } from "./poolAccountingEnv";

describe("PoolAccounting", () => {
  let laura: SignerWithAddress;
  let tina: SignerWithAddress;
  let poolAccountingEnv: PoolAccountingEnv;
  let poolAccountingHarness: Contract;
  let mockedInterestRateModel: Contract;
  let exaTime = new ExaTime();
  let snapshot: any;
  const nextPoolID = exaTime.nextPoolID() + 7 * exaTime.ONE_DAY; // we add 7 days so we make sure we are far from the previouos timestamp blocks

  beforeEach(async () => {
    snapshot = await ethers.provider.send("evm_snapshot", []);
    [, laura, tina] = await ethers.getSigners();
    poolAccountingEnv = await PoolAccountingEnv.create();
    poolAccountingHarness = poolAccountingEnv.poolAccountingHarness;
    mockedInterestRateModel = poolAccountingEnv.mockedInterestRateModel;
  });

  describe("function calls not originating from the FixedLender contract", () => {
    it("WHEN invoking borrowMP NOT from the FixedLender, THEN it should revert with error CALLER_MUST_BE_FIXED_LENDER", async () => {
      await expect(
        poolAccountingHarness.borrowMP(0, laura.address, 0, 0, 0)
      ).to.be.revertedWith(
        errorGeneric(ProtocolError.CALLER_MUST_BE_FIXED_LENDER)
      );
    });

    it("WHEN invoking depositMP NOT from the FixedLender, THEN it should revert with error CALLER_MUST_BE_FIXED_LENDER", async () => {
      await expect(
        poolAccountingHarness.depositMP(0, laura.address, 0, 0)
      ).to.be.revertedWith(
        errorGeneric(ProtocolError.CALLER_MUST_BE_FIXED_LENDER)
      );
    });

    it("WHEN invoking repayMP NOT from the FixedLender, THEN it should revert with error CALLER_MUST_BE_FIXED_LENDER", async () => {
      await expect(
        poolAccountingHarness.repayMP(0, laura.address, 0, 0)
      ).to.be.revertedWith(
        errorGeneric(ProtocolError.CALLER_MUST_BE_FIXED_LENDER)
      );
    });

    it("WHEN invoking withdrawMP NOT from the FixedLender, THEN it should revert with error CALLER_MUST_BE_FIXED_LENDER", async () => {
      await expect(
        poolAccountingHarness.withdrawMP(0, laura.address, 0, 0, 0)
      ).to.be.revertedWith(
        errorGeneric(ProtocolError.CALLER_MUST_BE_FIXED_LENDER)
      );
    });
  });

  describe("GIVEN a depositMP with an amount of 10000 (0 fees earned)", () => {
    const sixDaysToMaturity = nextPoolID - exaTime.ONE_DAY * 5;
    let depositAmount: any;
    let borrowAmount: any;
    let borrowFees: any;
    let returnValues: any;
    let repayAmount: any;
    let mp: any;

    beforeEach(async () => {
      await poolAccountingEnv.moveInTime(sixDaysToMaturity);
      depositAmount = "10000";
      poolAccountingEnv.switchWallet(laura);
      await poolAccountingEnv.depositMP(nextPoolID, depositAmount);
      returnValues = await poolAccountingHarness.returnValues();
      mp = await poolAccountingHarness.maturityPools(nextPoolID);
    });
    it("THEN borrowed equals 0", async () => {
      expect(mp.borrowed).to.eq(parseUnits("0"));
    });
    it("THEN supplied equals to depositedAmount", async () => {
      expect(mp.supplied).to.eq(parseUnits(depositAmount));
    });
    it("THEN suppliedSP is 0", async () => {
      expect(mp.suppliedSP).to.eq(parseUnits("0"));
    });
    it("THEN earningsUnassigned are 0", async () => {
      expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
    });
    it("THEN lastAccrue is 6 days to maturity", async () => {
      expect(mp.lastAccrue).to.eq(sixDaysToMaturity);
    });
    it("THEN the earningsSP returned are 0", async () => {
      expect(returnValues.earningsSP).to.eq(parseUnits("0"));
    });
    it("THEN the currentTotalDeposit returned is equal to the amount (no fees earned)", async () => {
      expect(returnValues.currentTotalDeposit).to.eq(parseUnits(depositAmount));
    });

    describe("AND GIVEN a borrowMP with an amount of 5000 (250 charged in fees to treasury) (4 days to go)", () => {
      const fourDaysToMaturity = nextPoolID - exaTime.ONE_DAY * 4;
      let mp: any;
      beforeEach(async () => {
        await mockedInterestRateModel.setBorrowRate(parseUnits("0.05"));
        await poolAccountingEnv.moveInTime(fourDaysToMaturity);
        borrowAmount = 5000;
        borrowFees = 250;
        await poolAccountingEnv.borrowMP(
          nextPoolID,
          borrowAmount.toString(),
          (borrowAmount + borrowFees).toString()
        );
        returnValues = await poolAccountingHarness.returnValues();
        mp = await poolAccountingHarness.maturityPools(nextPoolID);
      });
      it("THEN borrowed is the just borrowed amount", async () => {
        expect(mp.borrowed).to.eq(parseUnits(borrowAmount.toString()));
      });
      it("THEN supplied is the just deposited amount", async () => {
        expect(mp.supplied).to.eq(parseUnits(depositAmount));
      });
      it("THEN suppliedSP is equal to 0", async () => {
        expect(mp.suppliedSP).to.eq(parseUnits("0"));
      });
      it("THEN earningsUnassigned are 0", async () => {
        expect(mp.earningsUnassigned).to.eq(0);
      });
      it("THEN lastAccrue is 4 days to maturity", async () => {
        expect(mp.lastAccrue).to.eq(fourDaysToMaturity);
      });
      it("THEN the earningsTreasury returned are 5000 x 0,05 (5%)", async () => {
        expect(returnValues.earningsTreasury).to.eq(
          parseUnits(borrowFees.toString()) // 5000 x 0,05 (5%)
        );
      });
      it("THEN the earningsSP returned are 0", async () => {
        expect(returnValues.earningsSP).to.eq(parseUnits("0"));
      });
      it("THEN the totalOwedNewBorrow returned is equal to the amount plus fees charged", async () => {
        expect(returnValues.totalOwedNewBorrow).to.eq(
          parseUnits((borrowAmount + borrowFees).toString())
        );
      });

      describe("AND GIVEN another borrowMP call with an amount of 5000 (250 charged in fees to treasury) (3 days to go)", () => {
        const threeDaysToMaturity = nextPoolID - exaTime.ONE_DAY * 3;
        let mp: any;
        beforeEach(async () => {
          await poolAccountingEnv.moveInTime(threeDaysToMaturity);
          borrowAmount = 5000;
          borrowFees = 250;
          await poolAccountingEnv.borrowMP(
            nextPoolID,
            borrowAmount.toString(),
            (borrowAmount + borrowFees).toString()
          );
          returnValues = await poolAccountingHarness.returnValues();
          mp = await poolAccountingHarness.maturityPools(nextPoolID);
        });
        it("THEN borrowed is 2x the previously borrow amount", async () => {
          expect(mp.borrowed).to.eq(parseUnits((borrowAmount * 2).toString()));
        });
        it("THEN supplied is the one depositedAmount", async () => {
          expect(mp.supplied).to.eq(parseUnits(depositAmount.toString()));
        });
        it("THEN suppliedSP is 0", async () => {
          expect(mp.suppliedSP).to.eq(parseUnits("0"));
        });
        it("THEN earningsUnassigned are 0", async () => {
          expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
        });
        it("THEN the lastAccrue is 3 days to maturity", async () => {
          expect(mp.lastAccrue).to.eq(threeDaysToMaturity);
        });
        it("THEN the earningsTreasury returned are 250", async () => {
          expect(returnValues.earningsTreasury).to.eq(
            parseUnits(borrowFees.toString())
          );
        });
        it("THEN the earningsSP returned are 0", async () => {
          expect(returnValues.earningsSP).to.eq(parseUnits("0"));
        });
        it("THEN the totalOwedNewBorrow returned is equal to the amount plus fees charged", async () => {
          expect(returnValues.totalOwedNewBorrow).to.eq(
            parseUnits((borrowAmount + borrowFees).toString())
          );
        });

        describe("AND GIVEN another borrowMP call with an amount of 5000 (250 charged in fees to unassigned) (2 days to go)", () => {
          const twoDaysToMaturity = nextPoolID - exaTime.ONE_DAY * 2;
          let mp: any;
          beforeEach(async () => {
            await poolAccountingEnv.moveInTime(twoDaysToMaturity);
            borrowAmount = 5000;
            borrowFees = 250;
            await poolAccountingEnv.borrowMP(
              nextPoolID,
              borrowAmount.toString(),
              (borrowAmount + borrowFees).toString()
            );
            returnValues = await poolAccountingHarness.returnValues();
            mp = await poolAccountingHarness.maturityPools(nextPoolID);
          });
          it("THEN borrowed is 3x the borrowAmount", async () => {
            expect(mp.borrowed).to.eq(
              parseUnits((borrowAmount * 3).toString())
            );
          });
          it("THEN supplied is 1x depositAmount", async () => {
            expect(mp.supplied).to.eq(parseUnits(depositAmount));
          });
          it("THEN suppliedSP is borrowAmount", async () => {
            expect(mp.suppliedSP).to.eq(parseUnits(borrowAmount.toString()));
          });
          it("THEN earningsUnassigned are 250", async () => {
            expect(mp.earningsUnassigned).to.eq(
              parseUnits(borrowFees.toString())
            );
          });
          it("THEN lastAccrue is 2 days to maturity", async () => {
            expect(mp.lastAccrue).to.eq(twoDaysToMaturity);
          });
          it("THEN the earningsSP returned are 0", async () => {
            expect(returnValues.earningsSP).to.eq(parseUnits("0"));
          });
          it("THEN the earningsTreasury returned are 0", async () => {
            expect(returnValues.earningsTreasury).to.eq(parseUnits("0"));
          });
          it("THEN the totalOwedNewBorrow returned is equal to the amount plus fees charged", async () => {
            expect(returnValues.totalOwedNewBorrow).to.eq(
              parseUnits((borrowAmount + borrowFees).toString())
            );
          });

          describe("AND GIVEN a repayMP at maturity(-1 DAY) with an amount of 15750 (total EARLY repayment) ", () => {
            const oneDayToMaturity = nextPoolID - exaTime.ONE_DAY * 1;
            let mp: any;
            beforeEach(async () => {
              await poolAccountingEnv.moveInTime(oneDayToMaturity);
              repayAmount = 15750;
              await poolAccountingEnv.repayMP(
                nextPoolID,
                repayAmount.toString()
              );
              returnValues = await poolAccountingHarness.returnValues();
              mp = await poolAccountingHarness.maturityPools(nextPoolID);
            });

            it("THEN borrowed field is updated correctly and is 0", async () => {
              // debtCovered=17325*15750/17325=15750
              // ppal of 15750 => 15000 (following ratio principal-fee of 15000 and 750)
              // borrowed original (15000) - 15000 = 0
              expect(mp.borrowed).to.be.eq(0);
            });

            it("THEN supplies are correctly updated", async () => {
              expect(mp.supplied).to.eq(
                parseUnits(depositAmount.toString()) // 10k
              );
              expect(mp.suppliedSP).to.eq(parseUnits("0"));
            });
            it("THEN the debtCovered was equal to full repayAmount", async () => {
              // debtCovered=5775*5250/5775=5250
              expect(returnValues.debtCovered).to.eq(parseUnits("15750"));
            });
            it("THEN earningsSP returned 0", async () => {
              expect(returnValues.earningsSP).to.eq(0);
            });
            it("THEN the earningsTreasury returned is 0", async () => {
              expect(returnValues.earningsTreasury).to.eq(0);
            });
            it("THEN the spareAmount returned is 125", async () => {
              // Takes all the unassignedEarnings
              // first 500 were taken by the treasury
              // then 125 was accrued and earned by the SP
              // then the repay takes the rest as a discount
              expect(returnValues.spareAmount).to.eq(parseUnits("125"));
            });
          });

          describe("AND GIVEN a repayMP at maturity(-1 DAY) with an amount of 8000 (partial EARLY repayment) ", () => {
            const oneDayToMaturity = nextPoolID - exaTime.ONE_DAY * 1;
            let mp: any;
            beforeEach(async () => {
              await poolAccountingEnv.moveInTime(oneDayToMaturity);
              repayAmount = 8000;
              await poolAccountingEnv.repayMP(
                nextPoolID,
                repayAmount.toString()
              );
              returnValues = await poolAccountingHarness.returnValues();
              mp = await poolAccountingHarness.maturityPools(nextPoolID);
            });

            it("THEN borrowed field is updated correctly and is 0", async () => {
              // debtCovered=8000*15750/15750=8000
              // ppal of 8000 => 7619 (following ratio principal-fee of 15000 and 750)
              // borrowed original (15000) - 7619 = ~7380
              expect(mp.borrowed).to.be.gt(parseUnits("7380"));
              expect(mp.borrowed).to.be.lt(parseUnits("7381"));
            });

            it("THEN supplies are correctly updated", async () => {
              expect(mp.supplied).to.eq(
                parseUnits(depositAmount.toString()) // 10k
              );
              expect(mp.suppliedSP).to.eq(parseUnits("0"));
            });
            it("THEN the debtCovered was equal to full repayAmount (8000)", async () => {
              expect(returnValues.debtCovered).to.eq(parseUnits("8000"));
            });
            it("THEN earningsSP returned 0", async () => {
              expect(returnValues.earningsSP).to.eq(0);
            });
            it("THEN the earningsTreasury returned is 0", async () => {
              expect(returnValues.earningsTreasury).to.eq(0);
            });
            it("THEN the spareAmount returned is 125", async () => {
              // Takes all the unassignedEarnings
              // first 500 were taken by the treasury
              // then 125 was accrued and earned by the SP
              // then the repay takes the rest as a discount
              expect(returnValues.spareAmount).to.eq(parseUnits("125"));
            });
          });

          describe("AND GIVEN a repayMP at maturity(-1 DAY) with an amount of 15750 but asking a 126 discount (total EARLY repayment) ", () => {
            const oneDayToMaturity = nextPoolID - exaTime.ONE_DAY * 1;
            let tx: any;
            beforeEach(async () => {
              await poolAccountingEnv.moveInTime(oneDayToMaturity);
              repayAmount = 15750;
              tx = poolAccountingEnv.repayMP(
                nextPoolID,
                repayAmount.toString(),
                (repayAmount - 126).toString()
              );
            });

            it("THEN the tx is reverted with TOO_MUCH_SLIPPAGE", async () => {
              await expect(tx).to.be.revertedWith(
                errorGeneric(ProtocolError.TOO_MUCH_SLIPPAGE)
              );
            });
          });

          describe("AND GIVEN a repayMP at maturity(+1 DAY) with an amount of 15750*1.1=17325 (total late repayment supported by SP) ", () => {
            // (to check earnings distribution) => we have the same test down below, but the differences here
            // are the pre-conditions: in this case, the borrow was supported by the SP and MP, while the one at the bottom
            // was supported by the MP
            let mp: any;
            beforeEach(async () => {
              await poolAccountingEnv.mockedInterestRateModel.setPenaltyRate(
                parseUnits("0.1").div(exaTime.ONE_DAY)
              );

              await poolAccountingEnv.moveInTime(nextPoolID + exaTime.ONE_DAY);
              repayAmount = 17325;
              await poolAccountingEnv.repayMP(
                nextPoolID,
                repayAmount.toString()
              );
              returnValues = await poolAccountingHarness.returnValues();
              mp = await poolAccountingHarness.maturityPools(nextPoolID);
            });

            it("THEN borrowed field is updated correctly and is 0", async () => {
              // debtCovered=17325*15750/17325=15750
              // ppal of 15750 => 15000 (following ratio principal-fee of 15000 and 750)
              // borrowed original (15000) - 15000 = 0
              expect(mp.borrowed).to.be.eq(0);
            });

            it("THEN supplies are correctly updated", async () => {
              expect(mp.supplied).to.eq(
                parseUnits(depositAmount.toString()) // 10k
              );
              expect(mp.suppliedSP).to.eq(parseUnits("0"));
            });
            it("THEN the debtCovered was equal to full repayAmount", async () => {
              // debtCovered=5775*5250/5775=5250
              expect(returnValues.debtCovered).to.eq(parseUnits("15750"));
            });
            it("THEN earningsSP receive the 10% of penalties (they were supporting this borrow)", async () => {
              // 17325 - 15750 = 1575 (10% of the debt) * 1/3 = 1050
              expect(returnValues.earningsSP).to.gt(parseUnits("524"));
              expect(returnValues.earningsSP).to.lt(parseUnits("525"));
            });
            it("THEN the earningsTreasury returned is 0", async () => {
              // 17325 - 15750 = 1575 (10% of the debt) * 1/3 = 1050
              expect(returnValues.earningsTreasury).to.gt(parseUnits("1049"));
              expect(returnValues.earningsTreasury).to.lt(parseUnits("1050"));
            });
            it("THEN the spareAmount returned is almost 0", async () => {
              expect(returnValues.spareAmount).to.lt(parseUnits("0.1"));
            });

            afterEach(async () => {
              await poolAccountingEnv.mockedInterestRateModel.setPenaltyRate(0);
            });
          });

          describe("AND GIVEN another depositMP with an amount of 5000 (half of 250 unassigned earnings earned) (1 day to)", () => {
            const oneDayToMaturity = nextPoolID - exaTime.ONE_DAY;
            let mp: any;
            beforeEach(async () => {
              await poolAccountingEnv.moveInTime(oneDayToMaturity);
              depositAmount = 5000;
              await poolAccountingEnv.depositMP(
                nextPoolID,
                depositAmount.toString()
              );
              returnValues = await poolAccountingHarness.returnValues();
              mp = await poolAccountingHarness.maturityPools(nextPoolID);
            });

            it("THEN borrowed is 3x borrowAmount", async () => {
              expect(mp.borrowed).to.eq(
                parseUnits((borrowAmount * 3).toString()) // 3 borrows of 5k were made
              );
            });
            it("THEN supplied is 2x depositAmount", async () => {
              expect(mp.supplied).to.eq(
                parseUnits((depositAmount + 10000).toString()) // 1 deposits of 10k + 1 deposit of 5k
              );
            });
            it("THEN suppliedSP is 0", async () => {
              expect(mp.suppliedSP).to.eq(0);
            });
            it("THEN earningsUnassigned are 0", async () => {
              expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
            });
            it("THEN lastAccrue is 1 day to maturity", async () => {
              expect(mp.lastAccrue).to.eq(oneDayToMaturity);
            });
            it("THEN the earningsSP returned are 125", async () => {
              expect(returnValues.earningsSP).to.eq(
                parseUnits((250 / 2).toString()) // 250 (previous unassigned) / 2 days
              );
            });
            it("THEN the earningsTreasury returned are 0", async () => {
              expect(returnValues.earningsTreasury).to.eq(parseUnits("0"));
            });
            it("THEN the currentTotalDeposit returned is equal to the amount plus fees earned", async () => {
              expect(returnValues.currentTotalDeposit).to.eq(
                parseUnits((depositAmount + 250 / 2).toString())
              );
            });
          });

          describe("AND GIVEN another depositMP with an amount of 5000 and with a spFeeRate of 10% (125 - (125 * 0.1) fees earned)", () => {
            const oneDayToMaturity = nextPoolID - exaTime.ONE_DAY;
            let mp: any;
            beforeEach(async () => {
              await poolAccountingEnv
                .getRealInterestRateModel()
                .setSPFeeRate(parseUnits("0.1")); // 10% fees charged from the mp depositor yield to the sp earnings
              await poolAccountingEnv.moveInTime(oneDayToMaturity);
              depositAmount = 10000;
              await poolAccountingEnv.depositMP(
                nextPoolID,
                depositAmount.toString()
              );
              returnValues = await poolAccountingHarness.returnValues();
              mp = await poolAccountingHarness.maturityPools(nextPoolID);
            });

            it("THEN borrowed is 3x borrowAmount", async () => {
              expect(mp.borrowed).to.eq(
                parseUnits((borrowAmount * 3).toString()) // 3 borrows of 5k were made
              );
            });
            it("THEN supplied is 2x depositAmount", async () => {
              expect(mp.supplied).to.eq(
                parseUnits((depositAmount * 2).toString()) // 2 deposits of 10k were made
              );
            });
            it("THEN suppliedSP is 0", async () => {
              expect(mp.suppliedSP).to.eq(0);
            });
            it("THEN earningsUnassigned are 0", async () => {
              expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
            });
            it("THEN lastAccrue is 1 day to maturity", async () => {
              expect(mp.lastAccrue).to.eq(oneDayToMaturity);
            });
            it("THEN the earningsTreasury returned are 0", async () => {
              expect(returnValues.earningsTreasury).to.eq(parseUnits("0"));
            });
            it("THEN the earningsSP returned are 125 + 12.5", async () => {
              expect(returnValues.earningsSP).to.eq(
                parseUnits((250 / 2 + 12.5).toString()) // 250 (previous unassigned) / 2 days
              );
            });
            it("THEN the currentTotalDeposit returned is equal to the amount plus fees earned", async () => {
              expect(returnValues.currentTotalDeposit).to.eq(
                parseUnits((depositAmount + 250 / 2 - 12.5).toString())
              );
            });
          });

          describe("AND GIVEN another depositMP with an exorbitant amount of 100M (all fees earned - same as depositing only 5k)", () => {
            const oneDayToMaturity = nextPoolID - exaTime.ONE_DAY;

            beforeEach(async () => {
              await poolAccountingEnv.moveInTime(oneDayToMaturity);
              depositAmount = 100000000;
              await poolAccountingEnv.depositMP(
                nextPoolID,
                depositAmount.toString()
              );
              returnValues = await poolAccountingHarness.returnValues();
              mp = await poolAccountingHarness.maturityPools(nextPoolID);
            });

            it("THEN borrowed is 3x borrowAmount", async () => {
              expect(mp.borrowed).to.eq(
                parseUnits((borrowAmount * 3).toString()) // 3 borrows of 5k where made
              );
            });
            it("THEN supplied is depositAmount + 10000 (10k are previous deposited amount)", async () => {
              expect(mp.supplied).to.eq(
                parseUnits((depositAmount + 10000).toString()) // 10000 = previous deposited amount
              );
            });
            it("THEN suppliedSP is 0", async () => {
              expect(mp.suppliedSP).to.eq(0);
            });
            it("THEN earningsUnassigned are 0", async () => {
              expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
            });
            it("THEN lastAccrue is 1 day before maturity", async () => {
              expect(mp.lastAccrue).to.eq(oneDayToMaturity);
            });
            it("THEN the currentTotalDeposit returned is equal to the amount plus fees earned", async () => {
              expect(returnValues.currentTotalDeposit).to.eq(
                parseUnits((depositAmount + 125).toString())
              );
            });

            describe("AND GIVEN an EARLY repayMP with an amount of 5250 (12 hours to maturity)", () => {
              const twelveHoursToMaturity =
                nextPoolID - exaTime.ONE_DAY + exaTime.ONE_HOUR * 12;

              beforeEach(async () => {
                await poolAccountingEnv.moveInTime(twelveHoursToMaturity);
                repayAmount = 5250;
                await poolAccountingEnv.repayMP(
                  nextPoolID,
                  repayAmount.toString()
                );
                returnValues = await poolAccountingHarness.returnValues();
                mp = await poolAccountingHarness.maturityPools(nextPoolID);
              });

              it("THEN borrowed is (borrowAmount(principal) * 3 - repayAmount(principal)) = 10K", async () => {
                expect(mp.borrowed).to.eq(parseUnits("10000"));
              });
              it("THEN supplied is 100M + 10k", async () => {
                expect(mp.supplied).to.eq(
                  parseUnits((depositAmount + 10000).toString()) // 100M + 10k deposit
                );
              });
              it("THEN suppliedSP is 0", async () => {
                expect(mp.suppliedSP).to.eq(0);
              });
              it("THEN earningsUnassigned are still 0", async () => {
                expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
              });
              it("THEN the earningsSP returned are 0", async () => {
                expect(returnValues.earningsSP).to.eq(parseUnits("0"));
              });
              it("THEN the earningsTreasury returned are 0", async () => {
                expect(returnValues.earningsTreasury).to.eq(parseUnits("0"));
              });
              it("THEN lastAccrue is 12 hours before maturity", async () => {
                expect(mp.lastAccrue).to.eq(twelveHoursToMaturity);
              });
              it("THEN the debtCovered was the full repayAmount", async () => {
                expect(returnValues.debtCovered).to.eq(
                  parseUnits(repayAmount.toString())
                );
              });
            });

            describe("AND GIVEN a total EARLY repayMP with an amount of 15750 (all debt)", () => {
              const twelveHoursToMaturity =
                nextPoolID - exaTime.ONE_DAY + exaTime.ONE_HOUR * 12;

              beforeEach(async () => {
                await poolAccountingEnv.moveInTime(twelveHoursToMaturity);
                repayAmount = 15750;
                await poolAccountingEnv.repayMP(
                  nextPoolID,
                  repayAmount.toString()
                );
                returnValues = await poolAccountingHarness.returnValues();
              });
              it("THEN the debtCovered was the full amount repaid", async () => {
                expect(returnValues.debtCovered).to.eq(
                  parseUnits(repayAmount.toString())
                );
              });
              it("THEN earningsUnassigned are still 0", async () => {
                expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
              });
              it("THEN the earningsSP returned are 0", async () => {
                expect(returnValues.earningsSP).to.eq(parseUnits("0"));
              });
            });

            describe("AND GIVEN a total repayMP at maturity with an amount of 15750 (all debt)", () => {
              beforeEach(async () => {
                await poolAccountingEnv.moveInTime(nextPoolID);
                repayAmount = 15750;
                await poolAccountingEnv.repayMP(
                  nextPoolID,
                  repayAmount.toString()
                );
                returnValues = await poolAccountingHarness.returnValues();
              });
              it("THEN the maturity pool state is correctly updated", async () => {
                const mp = await poolAccountingHarness.maturityPools(
                  nextPoolID
                );

                expect(mp.borrowed).to.eq(parseUnits("0"));
                expect(mp.supplied).to.eq(
                  parseUnits((depositAmount + 10000).toString()) // 1M + 10k deposit
                );
                expect(mp.suppliedSP).to.eq(parseUnits("0"));
              });

              it("THEN the debtCovered was equal to full repayAmount", async () => {
                expect(returnValues.debtCovered).to.eq(
                  parseUnits(repayAmount.toString())
                );
              });
              it("THEN earningsUnassigned are still 0", async () => {
                expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
              });
              it("THEN the earningsSP returned are 0", async () => {
                expect(returnValues.earningsSP).to.eq(parseUnits("0"));
              });
            });

            describe("AND GIVEN a partial repayMP at maturity(+1 DAY) with an amount of 8000 (partial late repayment)", () => {
              let mp: any;
              beforeEach(async () => {
                await poolAccountingEnv.mockedInterestRateModel.setPenaltyRate(
                  parseUnits("0.1").div(exaTime.ONE_DAY)
                );

                await poolAccountingEnv.moveInTime(
                  nextPoolID + exaTime.ONE_DAY
                );
                repayAmount = 8000;
                await poolAccountingEnv.repayMP(
                  nextPoolID,
                  repayAmount.toString()
                );
                returnValues = await poolAccountingHarness.returnValues();
                mp = await poolAccountingHarness.maturityPools(nextPoolID);
              });

              it("THEN borrowed field is updated correctly (~8073)", async () => {
                // debtCovered=8000*15750/17325=~7272
                // ppal of ~7272 => ~6926 (following ratio principal-fee of 15000 and 750)
                // borrowed original (15000) - ~6296 = ~8073
                //
                expect(mp.borrowed).to.be.gt(parseUnits("8073.59"));
                expect(mp.borrowed).to.be.lt(parseUnits("8073.60"));
              });

              it("THEN supplies are correctly updated", async () => {
                expect(mp.supplied).to.eq(
                  parseUnits((depositAmount + 10000).toString()) // 1M + 10k deposit
                );
                expect(mp.suppliedSP).to.eq(parseUnits("0"));
              });
              it("THEN the debtCovered was equal to full repayAmount", async () => {
                // debtCovered=8000*15750/17325=~7272
                expect(returnValues.debtCovered).to.gt(parseUnits("7272.72"));
                expect(returnValues.debtCovered).to.lt(parseUnits("7272.73"));
              });
              it("THEN earningsTreasury receive the 10% of penalties (they were supporting this borrow)", async () => {
                // debtCovered=8000*15750/17325=~7272
                // debtCovered+(~727)=8000 that the user repaid
                expect(returnValues.earningsTreasury).to.gt(
                  parseUnits("727.272")
                );
                expect(returnValues.earningsTreasury).to.lt(
                  parseUnits("727.273")
                );
              });
              it("THEN the earningsSP returned are 0", async () => {
                expect(returnValues.earningsSP).to.eq(parseUnits("0"));
              });

              afterEach(async () => {
                await poolAccountingEnv.mockedInterestRateModel.setPenaltyRate(
                  0
                );
              });
            });

            describe("AND GIVEN a repayMP at maturity(+1 DAY) with an amount of 15750*1.1=17325 (total late repayment)", () => {
              let mp: any;
              beforeEach(async () => {
                await poolAccountingEnv.mockedInterestRateModel.setPenaltyRate(
                  parseUnits("0.1").div(exaTime.ONE_DAY)
                );

                await poolAccountingEnv.moveInTime(
                  nextPoolID + exaTime.ONE_DAY
                );
                repayAmount = 17325;
                await poolAccountingEnv.repayMP(
                  nextPoolID,
                  repayAmount.toString()
                );
                returnValues = await poolAccountingHarness.returnValues();
                mp = await poolAccountingHarness.maturityPools(nextPoolID);
              });

              it("THEN borrowed field is updated correctly and is 0", async () => {
                // debtCovered=17325*15750/17325=15750
                // ppal of 15750 => 15000 (following ratio principal-fee of 15000 and 750)
                // borrowed original (15000) - 15000 = 0
                expect(mp.borrowed).to.be.eq(0);
              });

              it("THEN supplies are correctly updated", async () => {
                expect(mp.supplied).to.eq(
                  parseUnits((depositAmount + 10000).toString()) // 1M + 10k deposit
                );
                expect(mp.suppliedSP).to.eq(parseUnits("0"));
              });
              it("THEN the debtCovered was equal to full repayAmount", async () => {
                // debtCovered=17325*15750/17325=15750
                expect(returnValues.debtCovered).to.eq(parseUnits("15750"));
              });
              it("THEN earningsTreasury receive the 10% of penalties (they were supporting this borrow)", async () => {
                // 17325 - 15750 = 1575 (10% of the debt)
                expect(returnValues.earningsTreasury).to.gt(parseUnits("1574"));
                expect(returnValues.earningsTreasury).to.lt(parseUnits("1575"));
              });
              it("THEN the earningsSP returned are 0", async () => {
                expect(returnValues.earningsSP).to.eq(parseUnits("0"));
              });
              it("THEN the spareAmount returned is almost 0", async () => {
                expect(returnValues.spareAmount).to.lt(parseUnits("0.1"));
              });
            });

            describe("AND GIVEN a repayMP at maturity(+1 DAY) with an amount of 2000 on a debt 15750*0.1=17325 (way more money late repayment)", () => {
              let mp: any;
              beforeEach(async () => {
                await poolAccountingEnv.mockedInterestRateModel.setPenaltyRate(
                  parseUnits("0.1").div(exaTime.ONE_DAY)
                );

                await poolAccountingEnv.moveInTime(
                  nextPoolID + exaTime.ONE_DAY
                );
                repayAmount = 20000;
                await poolAccountingEnv.repayMP(
                  nextPoolID,
                  repayAmount.toString()
                );
                returnValues = await poolAccountingHarness.returnValues();
                mp = await poolAccountingHarness.maturityPools(nextPoolID);
              });

              it("THEN borrowed field is updated correctly and is 0", async () => {
                // debtCovered=17325*15750/17325=15750
                // ppal of 15750 => 15000 (following ratio principal-fee of 15000 and 750)
                // borrowed original (15000) - 15000 = 0
                expect(mp.borrowed).to.be.eq(0);
              });

              it("THEN supplies are correctly updated", async () => {
                expect(mp.supplied).to.eq(
                  parseUnits((depositAmount + 10000).toString()) // 1M + 10k deposit
                );
                expect(mp.suppliedSP).to.eq(parseUnits("0"));
              });
              it("THEN the debtCovered was equal to full repayAmount", async () => {
                // debtCovered=17325*15750/17325=15750
                expect(returnValues.debtCovered).to.eq(parseUnits("15750"));
              });
              it("THEN earningsTreasury receive the 10% of penalties (they were supporting this borrow)", async () => {
                // 17325 - 15750 = 1575 (10% of the debt)
                expect(returnValues.earningsTreasury).to.gt(parseUnits("1574"));
                expect(returnValues.earningsTreasury).to.lt(parseUnits("1575"));
              });
              it("THEN the earningsSP returned are 0", async () => {
                expect(returnValues.earningsSP).to.eq(parseUnits("0"));
              });
              it("THEN the spareAmount returned is 2675 (paid 20000 on a 17325 debt)", async () => {
                expect(returnValues.spareAmount).to.be.gt(parseUnits("2675.0"));
                expect(returnValues.spareAmount).to.be.lt(parseUnits("2675.1"));
              });
            });
          });
        });
      });
    });
  });

  describe("PoolAccounting Early Withdrawal / Early Repayment", () => {
    let returnValues: any;
    let mp: any;
    describe("GIVEN a borrowMP of 10000 (500 fees owed by user)", () => {
      const fiveDaysToMaturity = nextPoolID - exaTime.ONE_DAY * 5;

      beforeEach(async () => {
        poolAccountingEnv.switchWallet(laura);
        await mockedInterestRateModel.setBorrowRate(parseUnits("0.05"));
        await poolAccountingEnv.moveInTime(fiveDaysToMaturity);
        await poolAccountingEnv.borrowMP(nextPoolID, "10000");
        mp = await poolAccountingHarness.maturityPools(nextPoolID);
      });

      it("THEN all earningsUnassigned should be 500", () => {
        expect(mp.earningsUnassigned).to.eq(parseUnits("500"));
      });

      describe("WHEN an early repayment of 5250", () => {
        beforeEach(async () => {
          await poolAccountingEnv.repayMP(nextPoolID, "5250");
          returnValues = await poolAccountingHarness.returnValues();
          mp = await poolAccountingHarness.maturityPools(nextPoolID);
        });
        it("THEN borrowed is 5000", async () => {
          expect(mp.borrowed).to.eq(parseUnits("5000"));
        });
        it("THEN all earningsUnassigned should be 250", async () => {
          expect(mp.earningsUnassigned).to.eq(parseUnits("250"));
        });
        it("THEN the debtCovered returned is 5250", async () => {
          expect(returnValues.debtCovered).eq(parseUnits("5250"));
        });
        it("THEN the earningsSP returned are 0", async () => {
          expect(returnValues.earningsSP).eq(parseUnits("0")); // no seconds passed since last accrual
        });
        it("THEN the spareAmount returned is 250 (got a discount)", async () => {
          expect(returnValues.spareAmount).to.eq(parseUnits("250"));
        });

        describe("AND WHEN an early repayment of 5250", () => {
          beforeEach(async () => {
            await poolAccountingEnv.repayMP(nextPoolID, "5250");
            returnValues = await poolAccountingHarness.returnValues();
            mp = await poolAccountingHarness.maturityPools(nextPoolID);
          });
          it("THEN borrowed is 0", async () => {
            expect(mp.borrowed).to.eq(0);
          });
          it("THEN suppliedSP is 0", async () => {
            expect(mp.suppliedSP).to.eq(0);
          });
          it("THEN all earningsUnassigned should be 0", async () => {
            expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
          });
          it("THEN the debtCovered returned is 5250", async () => {
            expect(returnValues.debtCovered).eq(parseUnits("5250"));
          });
          it("THEN the earningsSP returned are 0", async () => {
            expect(returnValues.earningsSP).eq(parseUnits("0")); // no seconds passed since last accrual
          });
          it("THEN the spareAmount returned is 250 (got a discount)", async () => {
            expect(returnValues.spareAmount).to.eq(parseUnits("250"));
          });
        });
      });
    });

    describe("GIVEN a borrowMP of 5000 (250 fees owed by user) AND a depositMP of 5000", () => {
      const fiveDaysToMaturity = nextPoolID - exaTime.ONE_DAY * 5;

      beforeEach(async () => {
        poolAccountingEnv.switchWallet(laura);
        await mockedInterestRateModel.setBorrowRate(parseUnits("0.05"));
        await poolAccountingEnv.moveInTime(fiveDaysToMaturity);
        await poolAccountingEnv.borrowMP(nextPoolID, "5000");
        await poolAccountingEnv.depositMP(nextPoolID, "5000");
        returnValues = await poolAccountingHarness.returnValues();
        mp = await poolAccountingHarness.maturityPools(nextPoolID);
      });
      it("THEN all earningsUnassigned should be 0", async () => {
        expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
      });
      it("THEN the earningsSP returned are 0", async () => {
        expect(returnValues.earningsSP).eq(parseUnits("0"));
      });
      it("THEN the currentTotalDeposit returned is 5000 + 250 (earned fees)", async () => {
        expect(returnValues.currentTotalDeposit).eq(parseUnits("5250"));
      });

      describe("WHEN an early repayment of 5250", () => {
        beforeEach(async () => {
          await poolAccountingEnv.repayMP(nextPoolID, "5250");
          returnValues = await poolAccountingHarness.returnValues();
          mp = await poolAccountingHarness.maturityPools(nextPoolID);
        });
        it("THEN borrowed is 0", async () => {
          expect(mp.borrowed).to.eq(parseUnits("0"));
        });
        it("THEN all earningsUnassigned should be 0", async () => {
          expect(mp.earningsUnassigned).to.eq(parseUnits("0"));
        });
        it("THEN the earningsSP returned are 0", async () => {
          expect(returnValues.earningsSP).eq(parseUnits("0"));
        });
        it("THEN the debtCovered returned is 5250", async () => {
          expect(returnValues.debtCovered).eq(parseUnits("5250"));
        });
        it("THEN the spareAmount returned is 0 (didn't get a discount since it was gotten all before)", async () => {
          expect(returnValues.spareAmount).to.eq(parseUnits("0"));
        });
      });
    });

    describe("User receives more money than deposited for repaying earlier", () => {
      describe("GIVEN a borrowMP of 10000 (500 fees owed by user)", () => {
        const fiveDaysToMaturity = nextPoolID - exaTime.ONE_DAY * 5;

        beforeEach(async () => {
          poolAccountingEnv.switchWallet(laura);
          await mockedInterestRateModel.setBorrowRate(parseUnits("0.05"));
          await poolAccountingEnv.moveInTime(fiveDaysToMaturity);
          await poolAccountingEnv.borrowMP(nextPoolID, "10000");
          mp = await poolAccountingHarness.maturityPools(nextPoolID);
        });

        it("THEN all earningsUnassigned should be 500", () => {
          expect(mp.earningsUnassigned).to.eq(parseUnits("500"));
        });

        describe("GIVEN a borrowMP of 10000 (10000 fees owed by user)", () => {
          beforeEach(async () => {
            poolAccountingEnv.switchWallet(tina);
            await mockedInterestRateModel.setBorrowRate(parseUnits("1")); // Crazy FEE
            await poolAccountingEnv.borrowMP(nextPoolID, "10000", "20000"); // ... and we accept it
            mp = await poolAccountingHarness.maturityPools(nextPoolID);
          });

          it("THEN all earningsUnassigned should be 10500", async () => {
            expect(mp.earningsUnassigned).to.eq(parseUnits("10500"));
          });

          describe("WHEN an early repayment of 10500", () => {
            beforeEach(async () => {
              poolAccountingEnv.switchWallet(laura);
              await poolAccountingEnv.repayMP(nextPoolID, "10500");
              returnValues = await poolAccountingHarness.returnValues();
              mp = await poolAccountingHarness.maturityPools(nextPoolID);
            });
            it("THEN borrowed is 10000", async () => {
              expect(mp.borrowed).to.eq(parseUnits("10000"));
            });
            it("THEN all earningsUnassigned should be 5250", async () => {
              expect(mp.earningsUnassigned).to.eq(parseUnits("5250"));
            });
            it("THEN the debtCovered returned is 10500", async () => {
              expect(returnValues.debtCovered).eq(parseUnits("10500"));
            });
            it("THEN the earningsSP returned are 0", async () => {
              expect(returnValues.earningsSP).eq(parseUnits("0"));
            });
            it("THEN the earningsTreasury returned are 0", async () => {
              expect(returnValues.earningsTreasury).eq(parseUnits("0"));
            });
            it("THEN the spareAmount returned is 5250 (got a BIG discount)", async () => {
              expect(returnValues.spareAmount).to.eq(parseUnits("5250"));
            });
          });
        });
      });
    });
  });

  afterEach(async () => {
    await ethers.provider.send("evm_revert", [snapshot]);
    await ethers.provider.send("evm_mine", []);
  });
});
