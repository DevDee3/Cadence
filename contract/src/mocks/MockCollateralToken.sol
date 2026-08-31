// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockCollateralToken
/// @notice 18-decimal ERC20 mock standing in for a volatile collateral
///         asset (e.g. wrapped ETH) in local/unit tests and testnet demos.
///         Owner-mintable only.
contract MockCollateralToken is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Mock Collateral Token", "mCOL") Ownable(initialOwner) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
