// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockCollateralToken} from "../src/mocks/MockCollateralToken.sol";

/// @title DeployMocks
/// @notice Deploys MockUSDC + MockCollateralToken for demo/testing.
///
///         Hard-guarded to an allowlist of chain IDs (local Anvil +
///         Arc testnet) rather than a denylist of "not mainnet" — an
///         allowlist fails safe: an unrecognized chain ID refuses to
///         deploy rather than silently succeeding somewhere unintended.
///         Mirrors the equivalent mainnet-guard pattern already proven
///         out in this portfolio's AegisX project.
///
/// Required env vars:
///   PRIVATE_KEY   Deployer key (becomes owner/minter of both mocks).
///
/// Usage:
///   forge script script/DeployMocks.s.sol --rpc-url arc_testnet --broadcast
contract DeployMocks is Script {
    uint256 constant ANVIL_LOCAL_CHAIN_ID = 31337;
    uint256 constant ARC_TESTNET_CHAIN_ID = 5042002;

    error UnrecognizedChainForMockDeployment(uint256 chainId);

    function run() external {
        if (block.chainid != ANVIL_LOCAL_CHAIN_ID && block.chainid != ARC_TESTNET_CHAIN_ID) {
            revert UnrecognizedChainForMockDeployment(block.chainid);
        }

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console2.log("Deployer:", deployer);
        console2.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerKey);

        MockUSDC usdc = new MockUSDC(deployer);
        console2.log("MockUSDC:", address(usdc));

        MockCollateralToken collateral = new MockCollateralToken(deployer);
        console2.log("MockCollateralToken:", address(collateral));

        // Mint a starter supply for local demo/testing convenience.
        usdc.mint(deployer, 1_000_000e6);
        collateral.mint(deployer, 1_000 ether);

        vm.stopBroadcast();

        console2.log("");
        console2.log("Set these for Deploy.s.sol / ConfigureAgent.s.sol:");
        console2.log("  COLLATERAL_TOKEN=", address(collateral));
        console2.log("  DEBT_TOKEN=", address(usdc));
    }
}
