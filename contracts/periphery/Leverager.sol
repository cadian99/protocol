// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import { ERC20 } from "solmate/src/tokens/ERC20.sol";
import { SafeTransferLib } from "solmate/src/utils/SafeTransferLib.sol";
import { FixedPointMathLib } from "solmate/src/utils/FixedPointMathLib.sol";
import { Auditor, MarketNotListed } from "../Auditor.sol";
import { Market, ERC4626, FixedLib } from "../Market.sol";

/// @title Leverager
/// @notice Contract that leverages and deleverages the floating position of accounts interacting with Exactly Protocol.
contract Leverager {
  using FixedPointMathLib for uint256;
  using SafeTransferLib for ERC20;
  using FixedLib for FixedLib.Pool;
  using FixedLib for FixedLib.Position;

  /// @notice Balancer's vault contract that is used to take flash loans.
  IBalancerVault public immutable balancerVault;
  /// @notice Auditor contract that lists the markets that can be leveraged.
  Auditor public immutable auditor;

  constructor(Auditor auditor_, IBalancerVault balancerVault_) {
    auditor = auditor_;
    balancerVault = balancerVault_;
    Market[] memory markets = auditor_.allMarkets();
    for (uint256 i = 0; i < markets.length; i++) {
      markets[i].asset().safeApprove(address(markets[i]), type(uint256).max);
    }
  }

  /// @notice Leverages the floating position of `msg.sender` to match `targetHealthFactor` by taking a flash loan
  /// from Balancer's vault.
  /// @param market The Market to leverage the position in.
  /// @param principal The amount of assets to deposit or deposited.
  /// @param targetHealthFactor The desired target health factor that the account will be leveraged to.
  /// @param deposit True if the principal is being deposited, false if the principal is already deposited.
  function leverage(Market market, uint256 principal, uint256 targetHealthFactor, bool deposit) external {
    uint256[] memory amounts = new uint256[](1);
    ERC20[] memory tokens = new ERC20[](1);
    bytes[] memory calls = new bytes[](2);
    ERC20 asset = market.asset();

    if (deposit) asset.safeTransferFrom(msg.sender, address(this), principal);

    (uint256 adjustFactor, , , , ) = auditor.markets(market);
    uint256 factor = adjustFactor.mulWadDown(adjustFactor).divWadDown(targetHealthFactor);
    tokens[0] = asset;
    amounts[0] = principal.mulWadDown(factor).divWadDown(1e18 - factor);
    calls[0] = abi.encodeCall(ERC4626.deposit, (amounts[0] + (deposit ? principal : 0), msg.sender));
    calls[1] = abi.encodeCall(Market.borrow, (amounts[0], address(balancerVault), msg.sender));

    balancerVault.flashLoan(address(this), tokens, amounts, abi.encode(market, calls));
  }

  /// @notice Deleverages the position of `msg.sender` a certain `percentage` by taking a flash loan from
  /// Balancer's vault to repay the borrow.
  /// @param market The Market to deleverage the position out.
  /// @param maturity The maturity of the fixed pool that the position is being deleveraged out of, `0` if floating.
  /// @param maxAssets Max amount of fixed debt that the sender is willing to accept.
  /// @param percentage The percentage of the borrow that will be repaid, represented with 18 decimals.
  function deleverage(Market market, uint256 maturity, uint256 maxAssets, uint256 percentage) external {
    uint256[] memory amounts = new uint256[](1);
    ERC20[] memory tokens = new ERC20[](1);
    bytes[] memory calls = new bytes[](2);
    tokens[0] = market.asset();

    if (maturity == 0) {
      (, , uint256 floatingBorrowShares) = market.accounts(msg.sender);
      amounts[0] = market.previewRefund(floatingBorrowShares.mulWadDown(percentage));
      calls[0] = abi.encodeCall(Market.repay, (amounts[0], msg.sender));
    } else {
      uint256 positionAssets;
      (amounts[0], positionAssets) = repayAtMaturityAssets(market, maturity, percentage);
      calls[0] = abi.encodeCall(Market.repayAtMaturity, (maturity, positionAssets, maxAssets, msg.sender));
    }
    calls[1] = abi.encodeCall(Market.withdraw, (amounts[0], address(balancerVault), msg.sender));

    balancerVault.flashLoan(address(this), tokens, amounts, abi.encode(market, calls));
  }

  /// @notice Rolls a percentage of the floating position of `msg.sender` to a fixed position or vice versa.
  /// @param market The Market to roll the position in.
  /// @param floatingToFixed `True` if the position is being rolled from floating to a fixed pool, `false` if opposite.
  /// @param maturity The maturity of the fixed pool that the position is being rolled to or from.
  /// @param maxAssets Max amount of debt that the sender is willing to accept.
  /// @param percentage The percentage of the position that will be rolled, represented with 18 decimals.
  function floatingRoll(
    Market market,
    bool floatingToFixed,
    uint256 maturity,
    uint256 maxAssets,
    uint256 percentage
  ) external {
    uint256[] memory amounts = new uint256[](1);
    ERC20[] memory tokens = new ERC20[](1);
    bytes[] memory calls = new bytes[](2);
    tokens[0] = market.asset();

    if (floatingToFixed) {
      (, , uint256 floatingBorrowShares) = market.accounts(msg.sender);
      amounts[0] = market.previewRefund(floatingBorrowShares.mulWadDown(percentage));
      calls[0] = abi.encodeCall(Market.repay, (amounts[0], msg.sender));
      calls[1] = abi.encodeCall(
        Market.borrowAtMaturity,
        (maturity, amounts[0], maxAssets, address(balancerVault), msg.sender)
      );
    } else {
      uint256 positionAssets;
      (amounts[0], positionAssets) = repayAtMaturityAssets(market, maturity, percentage);
      calls[0] = abi.encodeCall(Market.repayAtMaturity, (maturity, positionAssets, maxAssets, msg.sender));
      calls[1] = abi.encodeCall(Market.borrow, (amounts[0], address(balancerVault), msg.sender));
    }

    balancerVault.flashLoan(address(this), tokens, amounts, abi.encode(market, calls));
  }

  /// @notice Rolls a percentage of the fixed position of `msg.sender` to another fixed pool.
  /// @param market The Market to roll the position in.
  /// @param maturity The maturity of the fixed pool that the position is being rolled from.
  /// @param newMaturity The maturity of the fixed pool that the position is being rolled to.
  /// @param maxRepayAssets Max amount of debt that the account is willing to accept to be repaid.
  /// @param maxBorrowAssets Max amount of debt that the sender is willing to accept to be borrowed.
  /// @param percentage The percentage of the position that will be rolled, represented with 18 decimals.
  function fixedRoll(
    Market market,
    uint256 maturity,
    uint256 newMaturity,
    uint256 maxRepayAssets,
    uint256 maxBorrowAssets,
    uint256 percentage
  ) external {
    uint256[] memory amounts = new uint256[](1);
    ERC20[] memory tokens = new ERC20[](1);
    bytes[] memory calls = new bytes[](2);
    tokens[0] = market.asset();
    uint256 positionAssets;

    (amounts[0], positionAssets) = repayAtMaturityAssets(market, maturity, percentage);
    calls[0] = abi.encodeCall(Market.repayAtMaturity, (maturity, positionAssets, maxRepayAssets, msg.sender));
    calls[1] = abi.encodeCall(
      Market.borrowAtMaturity,
      (newMaturity, amounts[0], maxBorrowAssets, address(balancerVault), msg.sender)
    );

    balancerVault.flashLoan(address(this), tokens, amounts, abi.encode(market, calls));
  }

  /// @notice Calculates the actual repay and position assets of a repay operation at maturity.
  /// @param market The Market to calculate the actual repay and position assets.
  /// @param maturity The maturity of the fixed pool in which the position is being repaid.
  /// @param percentage The percentage of the position that will be repaid, represented with 18 decimals.
  /// @return actualRepay The actual amount of assets that will be repaid.
  /// @return positionAssets The amount of principal and fee to be covered.
  function repayAtMaturityAssets(
    Market market,
    uint256 maturity,
    uint256 percentage
  ) internal view returns (uint256 actualRepay, uint256 positionAssets) {
    FixedLib.Position memory position;
    (position.principal, position.fee) = market.fixedBorrowPositions(maturity, msg.sender);
    positionAssets = percentage.mulWadDown(position.principal + position.fee);
    if (block.timestamp < maturity) {
      FixedLib.Pool memory pool;
      (pool.borrowed, pool.supplied, pool.unassignedEarnings, pool.lastAccrual) = market.fixedPools(maturity);
      pool.unassignedEarnings -= pool.unassignedEarnings.mulDivDown(
        block.timestamp - pool.lastAccrual,
        maturity - pool.lastAccrual
      );
      (uint256 yield, ) = pool.calculateDeposit(
        position.scaleProportionally(positionAssets).principal,
        market.backupFeeRate()
      );
      actualRepay = positionAssets - yield;
    } else {
      actualRepay = positionAssets + positionAssets.mulWadDown((block.timestamp - maturity) * market.penaltyRate());
    }
  }

  /// @notice Callback function called by the Balancer Vault contract when a flash loan is initiated.
  /// @dev Only the Balancer Vault contract is allowed to call this function.
  /// @param userData Additional data provided by the borrower for the flash loan.
  function receiveFlashLoan(ERC20[] memory, uint256[] memory, uint256[] memory, bytes memory userData) external {
    assert(msg.sender == address(balancerVault));

    (Market market, bytes[] memory calls) = abi.decode(userData, (Market, bytes[]));
    for (uint256 i = 0; i < calls.length; ) {
      (bool success, bytes memory data) = address(market).call(calls[i]);
      if (!success) revert CallError(i, data);
      unchecked {
        ++i;
      }
    }
  }

  /// @notice Returns Balancer Vault's available liquidity of each enabled underlying asset.
  function availableLiquidity() external view returns (AvailableAsset[] memory availableAssets) {
    uint256 marketsCount = auditor.allMarkets().length;
    availableAssets = new AvailableAsset[](marketsCount);

    for (uint256 i = 0; i < marketsCount; i++) {
      ERC20 asset = auditor.marketList(i).asset();
      availableAssets[i] = AvailableAsset({ asset: asset, liquidity: asset.balanceOf(address(balancerVault)) });
    }
  }

  /// @notice Approves the Market to spend the contract's balance of the underlying asset.
  /// @dev The Market must be listed by the Auditor in order to be valid for approval.
  /// @param market The Market to spend the contract's balance.
  function approve(Market market) external {
    (, , , bool isListed, ) = auditor.markets(market);
    if (!isListed) revert MarketNotListed();

    market.asset().safeApprove(address(market), type(uint256).max);
  }

  struct AvailableAsset {
    ERC20 asset;
    uint256 liquidity;
  }
}

error CallError(uint256 callIndex, bytes revertData);

interface IBalancerVault {
  function flashLoan(
    address recipient,
    ERC20[] memory tokens,
    uint256[] memory amounts,
    bytes memory userData
  ) external;
}
