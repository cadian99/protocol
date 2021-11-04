// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IExafin.sol";
import "./interfaces/IAuditor.sol";
import "./interfaces/IInterestRateModel.sol";
import "./utils/TSUtils.sol";
import "./utils/DecimalMath.sol";
import "./utils/Errors.sol";
import "hardhat/console.sol";

contract Exafin is IExafin, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using DecimalMath for uint256;
    using PoolLib for PoolLib.Pool;

    event Borrowed(
        address indexed to,
        uint256 amount,
        uint256 commission,
        uint256 maturityDate
    );

    event Supplied(
        address indexed from,
        uint256 amount,
        uint256 commission,
        uint256 maturityDate
    );

    event Redeemed(
        address indexed from,
        uint256 amount,
        uint256 maturityDate
    );

    event Repaid(
        address indexed payer,
        address indexed borrower,
        uint256 amount,
        uint256 maturityDate
    );

    event LiquidateBorrow(
        address liquidator,
        address borrower,
        uint256 repayAmount,
        address exafinCollateral,
        uint256 seizeAmount,
        uint256 maturityDate
    );

    event Seized(
        address liquidator,
        address borrower,
        uint256 seizedAmount,
        uint256 maturityDate
    );

    event ReservesAdded(
        address benefactor,
        uint256 addAmount
    );

    mapping(uint256 => mapping(address => uint256)) public suppliedAmounts;
    mapping(uint256 => mapping(address => uint256)) public borrowedAmounts;
    mapping(uint256 => PoolLib.Pool) public pools;
    mapping(address => uint256[]) public addressPools;

    uint256 private constant PROTOCOL_SEIZE_SHARE = 2.8e16; //2.8%

    IERC20 private trustedUnderlying;
    string public override tokenName;

    IAuditor public auditor;
    IInterestRateModel public interestRateModel;

    // Smart Pool Values
    uint256 public totalSupply;
    mapping(address => uint256) public balances;

    // Total deposits in all maturities
    uint256 override public totalDeposits;
    mapping(address => uint256) private totalDepositsUser;

    // Total borrows in all maturities
    uint256 override public totalBorrows;
    mapping(address => uint256) private totalBorrowsUser;

    constructor(
        address _tokenAddress,
        string memory _tokenName,
        address _auditorAddress,
        address _interestRateModelAddress
    ) {
        trustedUnderlying = IERC20(_tokenAddress);
        trustedUnderlying.safeApprove(address(this), type(uint256).max);
        tokenName = _tokenName;

        auditor = IAuditor(_auditorAddress);
        interestRateModel = IInterestRateModel(_interestRateModelAddress);
    }

    /**
     * @dev Get current rate to borrow a certain amount in a certain maturity
     *      in the current state of the pool and the pot
     * @param amount amount to borrow from a certain maturity date
     * @param maturityDate maturity date for calculating rates
     */
    function getRateToBorrow(uint256 amount, uint256 maturityDate) override public view returns (uint256) {
        if(!TSUtils.isPoolID(maturityDate)) {
            revert GenericError(ErrorCode.INVALID_POOL_ID);
        }

        PoolLib.Pool memory poolMaturity = pools[maturityDate];
        return interestRateModel.getRateToBorrow(amount, maturityDate, poolMaturity, poolMaturity);
    }

    /**
     * @dev Get current rate for supplying a certain amount in a certain maturity
     *      in the current state of the pool and the pot
     * @param amount amount to supply to a certain maturity date
     * @param maturityDate maturity date for calculating rates
     */
    function getRateToSupply(uint256 amount, uint256 maturityDate) override public view returns (uint256) {
        if(!TSUtils.isPoolID(maturityDate)) {
            revert GenericError(ErrorCode.INVALID_POOL_ID);
        }

        PoolLib.Pool memory poolMaturity = pools[maturityDate];
        return interestRateModel.getRateToSupply(amount, maturityDate, poolMaturity, poolMaturity);
    }

    /**
     * @dev Lends to a wallet for a certain maturity date/pool
     * @param amount amount to send to the specified wallet
     * @param maturityDate maturity date for repayment
     */
    function borrow(
        uint256 amount,
        uint256 maturityDate
    ) override public nonReentrant {

        if(!TSUtils.isPoolID(maturityDate)) {
            revert GenericError(ErrorCode.INVALID_POOL_ID);
        }

        PoolLib.Pool memory pool = pools[maturityDate];

        // reverts on failure
        auditor.borrowAllowed(
            address(this),
            msg.sender,
            amount,
            maturityDate
        );

        uint256 commissionRate = interestRateModel.getRateToBorrow(
            amount,
            maturityDate,
            pool,
            pool // TO BE REPLACED BY POT
        );

        uint256 commission = amount.mul_(commissionRate);
        uint256 totalBorrow = amount + commission;
        borrowedAmounts[maturityDate][msg.sender] += totalBorrow;
        pool.borrowed += totalBorrow;
        pools[maturityDate] = pool;

        totalBorrows += totalBorrow;
        totalBorrowsUser[msg.sender] += totalBorrow;

        trustedUnderlying.safeTransferFrom(address(this), msg.sender, amount);

        emit Borrowed(msg.sender, amount, commission, maturityDate);
    }

    /**
     * @dev Supplies a certain amount to the protocol for 
     *      a certain maturity date/pool
     * @param from wallet to receive amount from
     * @param amount amount to receive from the specified wallet
     * @param maturityDate maturity date / pool ID
     */
    function supply(
        address from,
        uint256 amount,
        uint256 maturityDate
    ) override public nonReentrant {
        if(!TSUtils.isPoolID(maturityDate)) {
            revert GenericError(ErrorCode.INVALID_POOL_ID);
        }

        PoolLib.Pool memory pool = pools[maturityDate];

        // reverts on failure
        auditor.supplyAllowed(
            address(this),
            from,
            amount,
            maturityDate
        );

        uint256 commissionRate = interestRateModel.getRateToSupply(
            amount,
            maturityDate,
            pool,
            pool // TO BE REPLACED BY POT
        );

        uint256 commission = amount.mul_(commissionRate);
        uint256 totalAmount = amount + commission;
        suppliedAmounts[maturityDate][from] += totalAmount;
        pool.supplied += totalAmount;
        pools[maturityDate] = pool;

        totalDeposits += totalAmount;
        totalDepositsUser[from] += totalAmount;

        trustedUnderlying.safeTransferFrom(from, address(this), amount);

        emit Supplied(from, amount, commission, maturityDate);
    }

    /**
     * @notice User collects a certain amount of underlying asset after having
     *         supplied tokens until a certain maturity date
     * @dev The pool that the user is trying to retrieve the money should be matured
     * @param redeemer The address of the account which is redeeming the tokens
     * @param redeemAmount The number of underlying tokens to receive from redeeming this Exafin
     * @param maturityDate the matured date for which we're trying to retrieve the funds
     */
    function redeem(
        address payable redeemer,
        uint256 redeemAmount,
        uint256 maturityDate
    ) external override nonReentrant {
        if(redeemAmount == 0) {
            revert GenericError(ErrorCode.REDEEM_CANT_BE_ZERO);
        }

        // reverts on failure
        auditor.redeemAllowed(
            address(this),
            redeemer,
            redeemAmount,
            maturityDate
        );

        suppliedAmounts[maturityDate][redeemer] -= redeemAmount;
        totalDeposits -= redeemAmount;
        totalDepositsUser[redeemer] -= redeemAmount;

        require(
            trustedUnderlying.balanceOf(address(this)) >= redeemAmount,
            "Not enough liquidity"
        );

        trustedUnderlying.safeTransferFrom(
            address(this),
            redeemer,
            redeemAmount
        );

        emit Redeemed(redeemer, redeemAmount, maturityDate);
    }

    /**
     * @notice Sender repays borrower's debt for a maturity date
     * @dev The pool that the user is trying to repay to should be matured
     * @param borrower The address of the account that has the debt
     * @param maturityDate The matured date where the debt is located
     */
    function repay(
        address borrower,
        uint256 maturityDate
    ) override external nonReentrant {
        // reverts on failure
        auditor.repayAllowed(
            address(this),
            borrower,
            maturityDate
        );

        // the commission is included
        uint256 amountBorrowed = borrowedAmounts[maturityDate][borrower];

        trustedUnderlying.safeTransferFrom(msg.sender, address(this), amountBorrowed);
        totalBorrows -= amountBorrowed;
        totalBorrowsUser[borrower] -= amountBorrowed;

        delete borrowedAmounts[maturityDate][borrower];

        emit Repaid(msg.sender, borrower, amountBorrowed, maturityDate);
    }

    /**
     * @notice This function allows to partially repay a position on liquidation
     * @dev repay function on liquidation, it allows to partially pay debt, and it
     *      doesn't check `repayAllowed` on the auditor. It should be called after 
     *      liquidateAllowed
     * @param payer The address of the account that will pay the debt
     * @param borrower The address of the account that has the debt
     * @param repayAmount the amount of debt of the pool that should be paid
     * @param maturityDate the maturityDate to access the pool
     */
    function _repayLiquidate(
        address payer,
        address borrower,
        uint256 repayAmount,
        uint256 maturityDate
    ) internal {
        require(repayAmount != 0, "You can't repay zero");

        trustedUnderlying.safeTransferFrom(payer, address(this), repayAmount);

        uint256 amountBorrowed = borrowedAmounts[maturityDate][borrower];
        borrowedAmounts[maturityDate][borrower] = amountBorrowed - repayAmount;

        // That repayment diminishes debt in the pool
        PoolLib.Pool memory pool = pools[maturityDate];
        pool.borrowed -= repayAmount;
        pools[maturityDate] = pool;

        totalBorrows -= repayAmount;
        totalBorrowsUser[borrower] -= repayAmount;

        emit Repaid(payer, borrower, repayAmount, maturityDate);
    }

    /**
     * @notice Function to liquidate an uncollaterized position
     * @dev Msg.sender liquidates a borrower's position and repays a certain amount of collateral
     *      for a maturity date, seizing a part of borrower's collateral
     * @param borrower wallet that has an outstanding debt for a certain maturity date
     * @param repayAmount amount to be repaid by liquidator(msg.sender)
     * @param exafinCollateral address of exafin from which the collateral will be seized to give the liquidator
     * @param maturityDate maturity date for which the position will be liquidated
     */
    function liquidate(
        address borrower,
        uint256 repayAmount,
        IExafin exafinCollateral,
        uint256 maturityDate
    ) override external nonReentrant returns (uint256) {
        return _liquidate(msg.sender, borrower, repayAmount, exafinCollateral, maturityDate);
    }

    /**
     * @notice Internal Function to liquidate an uncollaterized position
     * @dev Liquidator liquidates a borrower's position and repays a certain amount of collateral
     *      for a maturity date, seizing a part of borrower's collateral
     * @param borrower wallet that has an outstanding debt for a certain maturity date
     * @param repayAmount amount to be repaid by liquidator(msg.sender)
     * @param exafinCollateral address of exafin from which the collateral will be seized to give the liquidator
     * @param maturityDate maturity date for which the position will be liquidated
     */
    function _liquidate(
        address liquidator,
        address borrower,
        uint256 repayAmount,
        IExafin exafinCollateral,
        uint256 maturityDate
    ) internal returns (uint256) {

        // reverts on failure
        auditor.liquidateAllowed(
            address(this),
            address(exafinCollateral),
            liquidator,
            borrower,
            repayAmount, 
            maturityDate
        );

        _repayLiquidate(liquidator, borrower, repayAmount, maturityDate);

        // reverts on failure
        uint256 seizeTokens = auditor.liquidateCalculateSeizeAmount(address(this), address(exafinCollateral), repayAmount);

        /* Revert if borrower collateral token balance < seizeTokens */
        (uint256 balance,) = exafinCollateral.getAccountSnapshot(borrower, maturityDate);
        if (balance < seizeTokens) {
            revert GenericError(ErrorCode.TOKENS_MORE_THAN_BALANCE);
        }

        // If this is also the collateral
        // run seizeInternal to avoid re-entrancy, otherwise make an external call
        // both revert on failure
        if (address(exafinCollateral) == address(this)) {
            _seize(address(this), liquidator, borrower, seizeTokens, maturityDate);
        } else {
            exafinCollateral.seize(liquidator, borrower, seizeTokens, maturityDate);
        }

        /* We emit a LiquidateBorrow event */
        emit LiquidateBorrow(liquidator, borrower, repayAmount, address(exafinCollateral), seizeTokens, maturityDate);

        return repayAmount;
    }

    /**
     * @notice Public function to seize a certain amount of tokens
     * @dev Public function for liquidator to seize borrowers tokens in a certain maturity date. 
     *      This function will only be called from another Exafins, on `liquidation` calls. 
     *      That's why msg.sender needs to be passed to the private function (to be validated as a market)
     * @param liquidator address which will receive the seized tokens
     * @param borrower address from which the tokens will be seized
     * @param seizeAmount amount to be removed from borrower's posession
     * @param maturityDate maturity date from where the tokens will be removed. Used to remove liquidity.
     */
    function seize(
        address liquidator,
        address borrower,
        uint256 seizeAmount,
        uint256 maturityDate
    ) override external nonReentrant {
        _seize(msg.sender, liquidator, borrower, seizeAmount, maturityDate);
    }

    /**
     * @notice Private function to seize a certain amount of tokens
     * @dev Private function for liquidator to seize borrowers tokens in a certain maturity date. 
     *      This function will only be called from this Exafin, on `liquidation` or through `seize` calls from another Exafins. 
     *      That's why msg.sender needs to be passed to the private function (to be validated as a market)
     * @param seizerExafin address which is calling the seize function (see `seize` public function)
     * @param liquidator address which will receive the seized tokens
     * @param borrower address from which the tokens will be seized
     * @param seizeAmount amount to be removed from borrower's posession
     * @param maturityDate maturity date from where the tokens will be removed. Used to remove liquidity.
     */
    function _seize(
        address seizerExafin,
        address liquidator,
        address borrower,
        uint256 seizeAmount,
        uint256 maturityDate
    ) internal {

        // reverts on failure
        auditor.seizeAllowed(
            address(this),
            seizerExafin,
            liquidator,
            borrower
        );

        uint256 protocolAmount = seizeAmount.mul_(PROTOCOL_SEIZE_SHARE);
        uint256 amountToTransfer = seizeAmount - protocolAmount;

        suppliedAmounts[maturityDate][borrower] -= seizeAmount;

        // That seize amount diminishes liquidity in the pool
        PoolLib.Pool memory pool = pools[maturityDate];
        pool.supplied -= seizeAmount;
        pools[maturityDate] = pool;

        totalDeposits -= seizeAmount;
        totalDepositsUser[borrower] -= seizeAmount;

        trustedUnderlying.safeTransfer(liquidator, amountToTransfer);

        emit Seized(liquidator, borrower, seizeAmount, maturityDate);
        emit ReservesAdded(address(this), protocolAmount);
    }

    /**
     * @dev Gets current snapshot for a wallet in a certain maturity
     * @param who wallet to return status snapshot in the specified maturity date
     * @param maturityDate maturity date
     */
    function getAccountSnapshot(address who, uint256 maturityDate)
        public
        view
        override
        returns (uint256, uint256)
    {
        if(!TSUtils.isPoolID(maturityDate)) {
            revert GenericError(ErrorCode.INVALID_POOL_ID);
        }
        return (suppliedAmounts[maturityDate][who], borrowedAmounts[maturityDate][who]);
    }

    /**
     * @dev Gets the total amount of borrowed money for a maturityDate
     * @param maturityDate maturity date
     */
    function getTotalBorrows(uint256 maturityDate)
        public
        view
        override
        returns (uint256)
    {
        if(!TSUtils.isPoolID(maturityDate)) {
            revert GenericError(ErrorCode.INVALID_POOL_ID);
        }
        return pools[maturityDate].borrowed;
    }

    /**
     * @dev Gets the auditor contract interface being used to validate positions
     */
    function getAuditor() public view override returns (IAuditor) {
        return IAuditor(auditor);
    }

    /**
     * @dev Retrieves all the supplies (Smart + all maturities) in this Exafin
     *      for a user -- This is NOT for ERC20 of the smart pool
     */
    function suppliesOf(address who) public view override returns (uint256) {
        return balances[who] + totalDepositsUser[who];
    }

    /**
     * @dev Retrieves all the borrows in this Exafin
     *      for a user -- This is NOT for ERC20 of the smart pool
     */
    function borrowsOf(address who) public view override returns (uint256) {
        return totalBorrowsUser[who];
    }
}
