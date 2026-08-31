// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PolicyModule} from "../src/PolicyModule.sol";
import {AgentAccountFactory} from "../src/AgentAccountFactory.sol";
import {AgentAccount} from "../src/AgentAccount.sol";

/// @title ConfigureAgent
/// @notice Second-stage script, run after Deploy.s.sol (and DeployMocks.s.sol
///         if using mock tokens): deploys the agent's AgentAccount via the
///         factory, registers it with PolicyModule, and grants exactly the
///         four function-level permissions the rebalancing agent needs —
///         nothing else. This is the on-chain equivalent of the "job
///         description" the off-chain reasoning loop operates under.
///
/// Required env vars:
///   PRIVATE_KEY       Deployer/admin key — becomes both the AgentAccount's
///                      owner and PolicyModule's rule-setter for it.
///   AGENT_SIGNER       Address of the autonomous agent's signing key (the
///                      key your backend holds and uses to sign
///                      UserOperations day-to-day). Generate this
///                      separately — it should NOT be the same key as
///                      PRIVATE_KEY/owner.
///   POLICY_MODULE      Address from Deploy.s.sol output.
///   LENDING_POOL       Address from Deploy.s.sol output.
///   COLLATERAL_TOKEN   Same value used in Deploy.s.sol.
///   DEBT_TOKEN         Same value used in Deploy.s.sol.
///   AGENT_FACTORY      Address from Deploy.s.sol output.
///
/// Optional env vars (sane defaults applied if unset):
///   MAX_SUPPLY_PER_CALL   default 10e18   (10 collateral tokens)
///   MAX_BORROW_PER_CALL   default 2500e6  (2,500 USDC)
///   MAX_REPAY_PER_CALL    default 2500e6  (2,500 USDC)
///   MAX_WITHDRAW_PER_CALL default 10e18   (10 collateral tokens)
///   COOLDOWN_SECONDS      default 900     (15 minutes between actions)
///
/// Usage:
///   forge script script/ConfigureAgent.s.sol --rpc-url arc_testnet --broadcast
contract ConfigureAgent is Script {
    bytes4 constant APPROVE_SELECTOR = bytes4(keccak256("approve(address,uint256)"));
    bytes4 constant SUPPLY_SELECTOR = bytes4(keccak256("supplyCollateral(uint256)"));
    bytes4 constant BORROW_SELECTOR = bytes4(keccak256("borrow(uint256)"));
    bytes4 constant REPAY_SELECTOR = bytes4(keccak256("repay(uint256)"));
    bytes4 constant WITHDRAW_SELECTOR = bytes4(keccak256("withdrawCollateral(uint256)"));

    struct Config {
        uint256 deployerKey;
        address deployer;
        address agentSigner;
        address policyAddr;
        address poolAddr;
        address collateralAddr;
        address debtAddr;
        address factoryAddr;
        uint256 maxSupply;
        uint256 maxBorrow;
        uint256 maxRepay;
        uint256 maxWithdraw;
        uint256 cooldown;
    }

    function run() external {
        Config memory c = _loadConfig();
        require(c.agentSigner != c.deployer, "AGENT_SIGNER must differ from owner key - never reuse the admin key");

        console2.log("Owner / admin:", c.deployer);
        console2.log("Agent signer:", c.agentSigner);

        vm.startBroadcast(c.deployerKey);
        AgentAccount agent = _deployAndConfigure(c);
        vm.stopBroadcast();

        console2.log("AgentAccount:", address(agent));
        console2.log("");
        console2.log("Agent configured. Policy limits:");
        console2.log("  max supply/call:   ", c.maxSupply);
        console2.log("  max borrow/call:   ", c.maxBorrow);
        console2.log("  max repay/call:    ", c.maxRepay);
        console2.log("  max withdraw/call: ", c.maxWithdraw);
        console2.log("  cooldown (sec):    ", c.cooldown);
        console2.log("");
        console2.log("Remaining manual steps before the agent can act:");
        console2.log("1. Send the AgentAccount native USDC for gas prefunding (Arc's native gas token)");
        console2.log("2. Send/mint it some collateral token to supply into the pool");
        console2.log("3. Ensure LendingPool has USDC liquidity (LendingPool.fundPoolLiquidity, owner-only)");
    }

    function _loadConfig() internal view returns (Config memory c) {
        c.deployerKey = vm.envUint("PRIVATE_KEY");
        c.deployer = vm.addr(c.deployerKey);
        c.agentSigner = vm.envAddress("AGENT_SIGNER");
        c.policyAddr = vm.envAddress("POLICY_MODULE");
        c.poolAddr = vm.envAddress("LENDING_POOL");
        c.collateralAddr = vm.envAddress("COLLATERAL_TOKEN");
        c.debtAddr = vm.envAddress("DEBT_TOKEN");
        c.factoryAddr = vm.envAddress("AGENT_FACTORY");
        c.maxSupply = vm.envOr("MAX_SUPPLY_PER_CALL", uint256(10e18));
        c.maxBorrow = vm.envOr("MAX_BORROW_PER_CALL", uint256(2500e6));
        c.maxRepay = vm.envOr("MAX_REPAY_PER_CALL", uint256(2500e6));
        c.maxWithdraw = vm.envOr("MAX_WITHDRAW_PER_CALL", uint256(10e18));
        c.cooldown = vm.envOr("COOLDOWN_SECONDS", uint256(900));
    }

    function _deployAndConfigure(Config memory c) internal returns (AgentAccount agent) {
        AgentAccountFactory factory = AgentAccountFactory(c.factoryAddr);
        PolicyModule policy = PolicyModule(c.policyAddr);

        agent = factory.createAccount(c.deployer, c.agentSigner, c.policyAddr, 0);
        policy.registerAccount(address(agent));

        // Token approvals: uncapped (0), since the amount that matters is
        // capped at the pool-call level below, not the approval itself.
        policy.setRule(address(agent), c.collateralAddr, APPROVE_SELECTOR, true, 0);
        policy.setRule(address(agent), c.debtAddr, APPROVE_SELECTOR, true, 0);

        // The four pool actions this agent's job is scoped to. Notably
        // absent: liquidate(), or any call to a target other than these
        // two tokens and this one pool — everything else is implicitly
        // denied by PolicyModule's allowlist-by-default design.
        policy.setRule(address(agent), c.poolAddr, SUPPLY_SELECTOR, true, c.maxSupply);
        policy.setRule(address(agent), c.poolAddr, BORROW_SELECTOR, true, c.maxBorrow);
        policy.setRule(address(agent), c.poolAddr, REPAY_SELECTOR, true, c.maxRepay);
        policy.setRule(address(agent), c.poolAddr, WITHDRAW_SELECTOR, true, c.maxWithdraw);

        policy.setCooldown(address(agent), c.cooldown);
    }
}
