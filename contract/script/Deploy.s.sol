// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PolicyModule} from "../src/PolicyModule.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";

/// @title Deploy
/// @notice Deploys the core, non-mock Cadence system: PolicyModule,
///         PriceOracle, LendingPool, AgentAccountFactory.
///
/// Required env vars:
///   PRIVATE_KEY        Deployer key (becomes the admin/owner of every
///                       contract below).
///   ENTRY_POINT         ERC-4337 EntryPoint address to build the factory
///                       against. Defaults to the widely-referenced v0.7
///                       canonical address if unset — VERIFY this against
///                       Arc's actual deployed EntryPoint before relying on
///                       it; canonical cross-chain addresses are only
///                       correct where the deterministic deployer was used
///                       to put them there, and that has not been
///                       independently confirmed for Arc in this repo.
///   COLLATERAL_TOKEN    ERC20 collateral asset address. On a real Arc
///                       deploy this will typically be MockCollateralToken
///                       from DeployMocks.s.sol (no established wrapped
///                       volatile asset on Arc testnet at time of writing).
///   DEBT_TOKEN          ERC20 debt asset address — use Arc testnet's real
///                       faucet-issued USDC here for the authentic
///                       "gas + capital in one asset" story, or
///                       MockUSDC from DeployMocks.s.sol for a fully
///                       isolated dry run.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
contract Deploy is Script {
    // Referenced for documentation only — see ENTRY_POINT env var notes
    // above. NOT assumed correct without verification.
    address constant DEFAULT_ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address entryPointAddr = vm.envOr("ENTRY_POINT", DEFAULT_ENTRY_POINT_V07);
        address collateralTokenAddr = vm.envAddress("COLLATERAL_TOKEN");
        address debtTokenAddr = vm.envAddress("DEBT_TOKEN");

        console2.log("Deployer:", deployer);
        console2.log("Chain ID:", block.chainid);
        console2.log("EntryPoint:", entryPointAddr);
        console2.log("Collateral token:", collateralTokenAddr);
        console2.log("Debt token:", debtTokenAddr);

        vm.startBroadcast(deployerKey);

        PolicyModule policy = new PolicyModule(deployer);
        console2.log("PolicyModule:", address(policy));

        PriceOracle oracle = new PriceOracle(deployer);
        console2.log("PriceOracle:", address(oracle));

        LendingPool pool =
            new LendingPool(deployer, IERC20(collateralTokenAddr), IERC20(debtTokenAddr), oracle);
        console2.log("LendingPool:", address(pool));

        AgentAccountFactory factory = new AgentAccountFactory(IEntryPoint(entryPointAddr));
        console2.log("AgentAccountFactory:", address(factory));

        vm.stopBroadcast();

        console2.log("");
        console2.log("Next: run ConfigureAgent.s.sol with these addresses set in your env");
        console2.log("  POLICY_MODULE=", address(policy));
        console2.log("  PRICE_ORACLE=", address(oracle));
        console2.log("  LENDING_POOL=", address(pool));
        console2.log("  AGENT_FACTORY=", address(factory));
    }
}
