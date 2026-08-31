// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyModule} from "../src/PolicyModule.sol";
import {IPolicyModule} from "../src/interfaces/IPolicyModule.sol";

contract PolicyModuleTest is Test {
    PolicyModule policy;
    address admin = makeAddr("admin");
    address account = makeAddr("agentAccount"); // simulated msg.sender (an AgentAccount)
    address target = makeAddr("lendingPool");
    bytes4 constant REPAY_SELECTOR = bytes4(keccak256("repay(uint256)"));

    function setUp() public {
        vm.prank(admin);
        policy = new PolicyModule(admin);
    }

    function test_RevertsWhenNotAllowlisted() public {
        vm.prank(account);
        vm.expectRevert(abi.encodeWithSelector(PolicyModule.NotAllowlisted.selector, account, target, REPAY_SELECTOR));
        policy.checkAndConsume(target, REPAY_SELECTOR, 100e6);
    }

    function test_AllowsWithinCap() public {
        vm.prank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, 1000e6);

        vm.prank(account);
        bool ok = policy.checkAndConsume(target, REPAY_SELECTOR, 500e6);
        assertTrue(ok);
    }

    function test_RevertsWhenExceedsCap() public {
        vm.prank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, 1000e6);

        vm.prank(account);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyModule.ExceedsCap.selector, account, target, REPAY_SELECTOR, 1500e6, 1000e6)
        );
        policy.checkAndConsume(target, REPAY_SELECTOR, 1500e6);
    }

    function test_ZeroCapMeansUncapped() public {
        vm.prank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, 0);

        vm.prank(account);
        bool ok = policy.checkAndConsume(target, REPAY_SELECTOR, type(uint128).max);
        assertTrue(ok);
    }

    function test_RevertsDuringCooldown() public {
        vm.startPrank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, 1000e6);
        policy.setCooldown(account, 1 hours);
        vm.stopPrank();

        vm.prank(account);
        policy.checkAndConsume(target, REPAY_SELECTOR, 100e6);

        vm.prank(account);
        vm.expectRevert(); // CooldownActive(account, readyAt) — exact readyAt not asserted here
        policy.checkAndConsume(target, REPAY_SELECTOR, 100e6);
    }

    function test_AllowsAfterCooldownElapses() public {
        vm.startPrank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, 1000e6);
        policy.setCooldown(account, 1 hours);
        vm.stopPrank();

        vm.prank(account);
        policy.checkAndConsume(target, REPAY_SELECTOR, 100e6);

        vm.warp(block.timestamp + 1 hours + 1);

        vm.prank(account);
        bool ok = policy.checkAndConsume(target, REPAY_SELECTOR, 100e6);
        assertTrue(ok);
    }

    function test_RulesAreScopedPerAccount() public {
        address otherAccount = makeAddr("otherAgentAccount");
        vm.prank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, 1000e6);

        // otherAccount was never granted a rule — must revert
        vm.prank(otherAccount);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyModule.NotAllowlisted.selector, otherAccount, target, REPAY_SELECTOR)
        );
        policy.checkAndConsume(target, REPAY_SELECTOR, 100e6);
    }

    function test_OnlyOwnerCanSetRules() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        policy.setRule(account, target, REPAY_SELECTOR, true, 1000e6);
    }

    function test_OnlyOwnerCanSetCooldown() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        policy.setCooldown(account, 1 hours);
    }

    function test_WouldAllowMirrorsCheckAndConsumeLogic() public {
        vm.prank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, 1000e6);

        (bool allowed, string memory reason) = policy.wouldAllow(account, target, REPAY_SELECTOR, 500e6);
        assertTrue(allowed);
        assertEq(reason, "");

        (bool allowed2, string memory reason2) = policy.wouldAllow(account, target, REPAY_SELECTOR, 1500e6);
        assertFalse(allowed2);
        assertEq(reason2, "exceeds per-call cap");
    }

    function test_WouldAllowDoesNotMutateState() public {
        vm.startPrank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, 1000e6);
        policy.setCooldown(account, 1 hours);
        vm.stopPrank();

        // Calling the view function repeatedly must never itself trigger cooldown
        policy.wouldAllow(account, target, REPAY_SELECTOR, 100e6);
        policy.wouldAllow(account, target, REPAY_SELECTOR, 100e6);

        vm.prank(account);
        bool ok = policy.checkAndConsume(target, REPAY_SELECTOR, 100e6);
        assertTrue(ok);
    }

    function testFuzz_CapEnforcedForAnyAmount(uint256 cap, uint256 amount) public {
        cap = bound(cap, 1, type(uint128).max);
        amount = bound(amount, 0, type(uint128).max);

        vm.prank(admin);
        policy.setRule(account, target, REPAY_SELECTOR, true, cap);

        vm.prank(account);
        if (amount > cap) {
            vm.expectRevert(
                abi.encodeWithSelector(PolicyModule.ExceedsCap.selector, account, target, REPAY_SELECTOR, amount, cap)
            );
            policy.checkAndConsume(target, REPAY_SELECTOR, amount);
        } else {
            bool ok = policy.checkAndConsume(target, REPAY_SELECTOR, amount);
            assertTrue(ok);
        }
    }
}
