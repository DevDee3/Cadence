// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title PriceOracle
/// @notice Minimal owner-settable price feed, priced in USDC terms with
///         18-decimal precision. Arc testnet has no deep native DEX
///         liquidity yet to source a trustworthy on-chain TWAP from, so
///         this mirrors how most hackathon-stage lending markets bootstrap
///         (and mirrors the PriceOracle already used in this portfolio's
///         Sentinel project) — swap-in a Chainlink or DEX-TWAP oracle
///         behind the same interface for production.
contract PriceOracle is Ownable {
    /// asset => price in USDC, scaled 1e18 (e.g. 1 ETH = 3000 USDC -> 3000e18)
    mapping(address => uint256) public prices;
    mapping(address => uint256) public lastUpdatedAt;

    event PriceUpdated(address indexed asset, uint256 price, uint256 timestamp);

    error StalePrice(address asset, uint256 lastUpdatedAt);
    error ZeroPrice();

    /// @notice Maximum age (seconds) before a price is considered stale and
    ///         reads revert. Protects the LendingPool from acting on a
    ///         price an operator forgot to refresh.
    uint256 public maxPriceAge = 1 days;

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setPrice(address asset, uint256 price) external onlyOwner {
        if (price == 0) revert ZeroPrice();
        prices[asset] = price;
        lastUpdatedAt[asset] = block.timestamp;
        emit PriceUpdated(asset, price, block.timestamp);
    }

    function setMaxPriceAge(uint256 newMaxAge) external onlyOwner {
        maxPriceAge = newMaxAge;
    }

    /// @notice Returns the current price, reverting if stale.
    function getPrice(address asset) external view returns (uint256) {
        uint256 updated = lastUpdatedAt[asset];
        if (updated == 0 || block.timestamp > updated + maxPriceAge) {
            revert StalePrice(asset, updated);
        }
        return prices[asset];
    }
}
