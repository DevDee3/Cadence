// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDC
/// @notice 6-decimal ERC20 mock standing in for USDC in local/unit tests.
///         On Arc testnet itself, use the real faucet-issued USDC
///         (faucet.circle.com) instead of this mock — this contract exists
///         purely so the Foundry test suite doesn't depend on network
///         access. Owner-mintable only, never deploy this to a chain where
///         real USDC exists.
contract MockUSDC is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Mock USD Coin", "mUSDC") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
