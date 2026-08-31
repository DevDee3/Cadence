// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PriceOracle} from "./PriceOracle.sol";

/// @title LendingPool
/// @notice Minimal single-collateral / single-debt-asset lending market —
///         the position the autonomous agent is responsible for keeping
///         healthy. Deliberately scoped down from a full multi-asset money
///         market (see this portfolio's Sentinel project for that shape):
///         the point of this contract is to be a small, fully-tested
///         surface the agent's PolicyModule rules can wrap tightly around
///         (repay/supply/withdraw, each a single uint256 argument, which is
///         exactly the shape AgentAccount's calldata decoder expects).
contract LendingPool is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable collateralToken;
    IERC20 public immutable debtToken; // USDC (or USDC-equivalent test asset)
    PriceOracle public priceOracle;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant HEALTH_FACTOR_PRECISION = 1e18;
    uint256 public constant MIN_HEALTH_FACTOR = 1e18; // 1.0

    /// Collateral value is discounted by this factor before comparing to
    /// debt — the standard "liquidation threshold" (e.g. 8000 = 80%).
    uint256 public liquidationThresholdBps = 8000;

    /// Bonus collateral (in bps of the repaid debt's USD value) a
    /// liquidator receives for closing an unhealthy position.
    uint256 public liquidationBonusBps = 500; // 5%

    uint8 private immutable debtDecimals;
    uint8 private immutable collateralDecimals;

    struct Position {
        uint256 collateralAmount;
        uint256 debtAmount;
    }

    mapping(address => Position) public positions;

    event CollateralSupplied(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 debtRepaid, uint256 collateralSeized);
    event PriceOracleUpdated(address indexed newOracle);
    event LiquidationParamsUpdated(uint256 thresholdBps, uint256 bonusBps);

    error ZeroAmount();
    error InsufficientCollateral();
    error HealthFactorTooLow(uint256 healthFactor);
    error PositionHealthy(uint256 healthFactor);
    error InsufficientPoolLiquidity();
    error RepayExceedsDebt();

    constructor(address initialOwner, IERC20 _collateralToken, IERC20 _debtToken, PriceOracle _priceOracle)
        Ownable(initialOwner)
    {
        collateralToken = _collateralToken;
        debtToken = _debtToken;
        priceOracle = _priceOracle;
        debtDecimals = IERC20Metadata(address(_debtToken)).decimals();
        collateralDecimals = IERC20Metadata(address(_collateralToken)).decimals();
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setPriceOracle(PriceOracle newOracle) external onlyOwner {
        priceOracle = newOracle;
        emit PriceOracleUpdated(address(newOracle));
    }

    function setLiquidationParams(uint256 newThresholdBps, uint256 newBonusBps) external onlyOwner {
        require(newThresholdBps <= BPS_DENOMINATOR, "threshold > 100%");
        liquidationThresholdBps = newThresholdBps;
        liquidationBonusBps = newBonusBps;
        emit LiquidationParamsUpdated(newThresholdBps, newBonusBps);
    }

    /// @notice Seeds the pool with borrowable liquidity. In production
    ///         this would come from depositor supply; for this agent-focused
    ///         demo the pool is a single-sided liquidity source the owner
    ///         funds directly (see DeployMocks.s.sol).
    function fundPoolLiquidity(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        debtToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    // ---------------------------------------------------------------
    // Position management
    // ---------------------------------------------------------------

    function supplyCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        positions[msg.sender].collateralAmount += amount;
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralSupplied(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[msg.sender];
        if (amount > p.collateralAmount) revert InsufficientCollateral();

        p.collateralAmount -= amount;

        if (p.debtAmount > 0) {
            uint256 hf = _healthFactor(p);
            if (hf < MIN_HEALTH_FACTOR) revert HealthFactorTooLow(hf);
        }

        collateralToken.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (debtToken.balanceOf(address(this)) < amount) revert InsufficientPoolLiquidity();

        Position storage p = positions[msg.sender];
        p.debtAmount += amount;

        uint256 hf = _healthFactor(p);
        if (hf < MIN_HEALTH_FACTOR) revert HealthFactorTooLow(hf);

        debtToken.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[msg.sender];
        if (amount > p.debtAmount) revert RepayExceedsDebt();

        p.debtAmount -= amount;
        debtToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Repaid(msg.sender, amount);
    }

    /// @notice Anyone may liquidate an unhealthy position by repaying its
    ///         debt (fully or partially) in exchange for a discounted
    ///         share of its collateral.
    function liquidate(address user, uint256 debtToCover) external nonReentrant {
        Position storage p = positions[user];
        uint256 hf = _healthFactor(p);
        if (hf >= MIN_HEALTH_FACTOR) revert PositionHealthy(hf);
        if (debtToCover == 0 || debtToCover > p.debtAmount) revert RepayExceedsDebt();

        uint256 price = priceOracle.getPrice(address(collateralToken));

        // USD value (18-decimals) of the debt being repaid
        uint256 debtValueUsd = _toWad(debtToCover, debtDecimals);
        // Collateral seized = debt value converted to collateral units,
        // plus the liquidation bonus, at current oracle price.
        uint256 collateralValueOwed = (debtValueUsd * (BPS_DENOMINATOR + liquidationBonusBps)) / BPS_DENOMINATOR;
        uint256 collateralToSeize = (collateralValueOwed * (10 ** collateralDecimals)) / price;

        if (collateralToSeize > p.collateralAmount) {
            collateralToSeize = p.collateralAmount;
        }

        p.debtAmount -= debtToCover;
        p.collateralAmount -= collateralToSeize;

        debtToken.safeTransferFrom(msg.sender, address(this), debtToCover);
        collateralToken.safeTransfer(msg.sender, collateralToSeize);

        emit Liquidated(user, msg.sender, debtToCover, collateralToSeize);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function healthFactor(address user) external view returns (uint256) {
        return _healthFactor(positions[user]);
    }

    function _healthFactor(Position memory p) internal view returns (uint256) {
        if (p.debtAmount == 0) return type(uint256).max;

        uint256 price = priceOracle.getPrice(address(collateralToken));
        uint256 collateralValueUsd = (p.collateralAmount * price) / (10 ** collateralDecimals);
        uint256 adjustedCollateralUsd = (collateralValueUsd * liquidationThresholdBps) / BPS_DENOMINATOR;
        uint256 debtValueUsd = _toWad(p.debtAmount, debtDecimals);

        if (debtValueUsd == 0) return type(uint256).max;
        return (adjustedCollateralUsd * HEALTH_FACTOR_PRECISION) / debtValueUsd;
    }

    /// @dev Normalizes an amount from `decimals` precision to 18-decimal
    ///      ("wad") precision.
    function _toWad(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        if (decimals == 18) return amount;
        if (decimals < 18) return amount * (10 ** (18 - decimals));
        return amount / (10 ** (decimals - 18));
    }
}
