// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import "./TSUtils.sol";

error GenericError(ErrorCode error);
error UnmatchedPoolState(TSUtils.State state, TSUtils.State requiredState);

enum ErrorCode {
    NO_ERROR,
    MARKET_NOT_LISTED,
    MARKET_ALREADY_LISTED,
    SNAPSHOT_ERROR,
    PRICE_ERROR,
    INSUFFICIENT_LIQUIDITY,
    UNSUFFICIENT_SHORTFALL,
    AUDITOR_MISMATCH,
    TOO_MUCH_REPAY,
    REPAY_ZERO,
    TOKENS_MORE_THAN_BALANCE,
    INVALID_POOL_STATE,
    INVALID_POOL_ID,
    LIQUIDATOR_NOT_BORROWER,
    BORROW_PAUSED,
    NOT_A_FIXED_LENDER_SENDER,
    INVALID_SET_BORROW_CAP,
    MARKET_BORROW_CAP_REACHED,
    INCONSISTENT_PARAMS_LENGTH,
    REDEEM_CANT_BE_ZERO,
    EXIT_MARKET_BALANCE_OWED,
    CALLER_MUST_BE_FIXED_LENDER,
    FIXED_LENDER_ALREADY_SET,
    INSUFFICIENT_PROTOCOL_LIQUIDITY,
    TRANSFER_IN_OVERFLOW,
    TOO_MUCH_REPAY_TRANSFER
}
