// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./helpers/TestBase.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {PolicyModule} from "../src/PolicyModule.sol";
import {LendingPool} from "../src/LendingPool.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @notice End-to-end scenarios exercising the full loop this hackathon
///         project demos: the agent's smart account holds a position on
///         LendingPool, and every action it takes is routed through a real
///         ERC-4337 UserOperation, gated by PolicyModule, executed against
///         the real pool contract.
contract IntegrationTest is TestBase {
    bytes4 constant SUPPLY_SELECTOR = bytes4(keccak256("supplyCollateral(uint256)"));
    bytes4 constant BORROW_SELECTOR = bytes4(keccak256("borrow(uint256)"));
    bytes4 constant REPAY_SELECTOR = bytes4(keccak256("repay(uint256)"));
    bytes4 constant WITHDRAW_SELECTOR = bytes4(keccak256("withdrawCollateral(uint256)"));
    bytes4 constant APPROVE_SELECTOR = bytes4(keccak256("approve(address,uint256)"));

    function _allowlistStandardAgentActions(uint256 maxSupply, uint256 maxBorrow, uint256 maxRepay, uint256 maxWithdraw)
        internal
    {
        vm.startPrank(admin);
        policy.setRule(address(agent), address(collateral), APPROVE_SELECTOR, true, 0);
        policy.setRule(address(agent), address(usdc), APPROVE_SELECTOR, true, 0);
        policy.setRule(address(agent), address(pool), SUPPLY_SELECTOR, true, maxSupply);
        policy.setRule(address(agent), address(pool), BORROW_SELECTOR, true, maxBorrow);
        policy.setRule(address(agent), address(pool), REPAY_SELECTOR, true, maxRepay);
        policy.setRule(address(agent), address(pool), WITHDRAW_SELECTOR, true, maxWithdraw);
        vm.stopPrank();
    }

    /// @notice The core demo path: agent supplies collateral, borrows
    ///         against it, then — simulating a "reduce risk" decision from
    ///         the reasoning loop — partially repays, all as real signed
    ///         UserOperations through the real EntryPoint.
    function test_AgentManagesFullPositionLifecycleViaUserOperations() public {
        _allowlistStandardAgentActions({maxSupply: 10 ether, maxBorrow: 2500e6, maxRepay: 2500e6, maxWithdraw: 10 ether});

        // 1. Agent approves the pool to pull its collateral
        submitAgentExecute(address(collateral), 0, abi.encodeCall(collateral.approve, (address(pool), 10 ether)));

        // 2. Agent supplies 1 collateral token (worth 3000 USDC at test price)
        submitAgentExecute(address(pool), 0, abi.encodeCall(LendingPool.supplyCollateral, (1 ether)));
        (uint256 supplied,) = pool.positions(address(agent));
        assertEq(supplied, 1 ether);

        // 3. Agent borrows 2000 USDC (HF = (3000*0.8)/2000 = 1.2 — healthy but not comfortable)
        submitAgentExecute(address(pool), 0, abi.encodeCall(LendingPool.borrow, (2000e6)));
        assertApproxEqAbs(pool.healthFactor(address(agent)), 1.2e18, 1e12);
        assertEq(usdc.balanceOf(address(agent)), 2000e6);

        // 4. Reasoning loop (simulated here, not actually calling an LLM)
        //    decides risk is too tight and repays 1000 USDC to improve HF.
        submitAgentExecute(address(usdc), 0, abi.encodeCall(usdc.approve, (address(pool), 1000e6)));
        submitAgentExecute(address(pool), 0, abi.encodeCall(LendingPool.repay, (1000e6)));

        (, uint256 debtAfter) = pool.positions(address(agent));
        assertEq(debtAfter, 1000e6);
        // HF = (3000*0.8)/1000 = 2.4 — materially safer
        assertApproxEqAbs(pool.healthFactor(address(agent)), 2.4e18, 1e12);
    }

    /// @notice Guardrail proof: even with a valid signature from the agent
    ///         key, an action exceeding the configured spend cap is
    ///         rejected on-chain — the LLM's judgment is not the final
    ///         authority.
    function test_AgentCannotBorrowBeyondPolicyCapEvenIfPositionAllows() public {
        // Position could safely support up to 2400 USDC borrow (80% of 3000),
        // but policy caps this agent to 500 USDC per borrow call regardless.
        _allowlistStandardAgentActions({maxSupply: 10 ether, maxBorrow: 500e6, maxRepay: 2500e6, maxWithdraw: 10 ether});

        submitAgentExecute(address(collateral), 0, abi.encodeCall(collateral.approve, (address(pool), 10 ether)));
        submitAgentExecute(address(pool), 0, abi.encodeCall(LendingPool.supplyCollateral, (1 ether)));

        PackedUserOperation memory op = buildAndSignExecuteOp(
            address(agent), address(pool), 0, abi.encodeCall(LendingPool.borrow, (1000e6)), agentSignerKey
        );
        // PolicyModule.ExceedsCap fails inside the bundle (1000 USDC > 500
        // USDC cap); handleOps itself does not revert — see comment in
        // AgentAccountTest.test_UserOperationBlockedByPolicyRevertsAtExecution.
        submitOp(op);

        (, uint256 debt) = pool.positions(address(agent));
        assertEq(debt, 0, "blocked borrow must not have partially applied");
    }

    /// @notice Guardrail proof: a target/selector the admin never
    ///         allowlisted is rejected even though the position and the
    ///         signature are both otherwise valid — e.g. the agent
    ///         attempting to call liquidate() on an unrelated position,
    ///         which was never part of its scoped job.
    function test_AgentCannotCallNonAllowlistedFunction() public {
        _allowlistStandardAgentActions({maxSupply: 10 ether, maxBorrow: 2500e6, maxRepay: 2500e6, maxWithdraw: 10 ether});
        // liquidate(address,uint256) intentionally never allowlisted

        PackedUserOperation memory op = buildAndSignExecuteOp(
            address(agent),
            address(pool),
            0,
            abi.encodeCall(LendingPool.liquidate, (makeAddr("someOtherUser"), 100e6)),
            agentSignerKey
        );
        submitOp(op); // NotAllowlisted fails inside the bundle, not at the handleOps level

        // Nothing about the target position should have moved.
        (, uint256 targetDebt) = pool.positions(makeAddr("someOtherUser"));
        assertEq(targetDebt, 0);
    }

    /// @notice Guardrail proof: cooldown throttles a compromised or
    ///         malfunctioning reasoning loop from firing rapid repeated
    ///         actions, even when each individual action is within cap
    ///         and allowlisted.
    function test_CooldownThrottlesRapidActions() public {
        _allowlistStandardAgentActions({maxSupply: 10 ether, maxBorrow: 2500e6, maxRepay: 2500e6, maxWithdraw: 10 ether});
        vm.prank(admin);
        policy.setCooldown(address(agent), 1 hours);

        submitAgentExecute(address(collateral), 0, abi.encodeCall(collateral.approve, (address(pool), 10 ether)));

        PackedUserOperation memory op = buildAndSignExecuteOp(
            address(agent), address(pool), 0, abi.encodeCall(LendingPool.supplyCollateral, (1 ether)), agentSignerKey
        );
        submitOp(op); // CooldownActive fails inside the bundle — approve() above already consumed the window

        (uint256 suppliedBeforeCooldown,) = pool.positions(address(agent));
        assertEq(suppliedBeforeCooldown, 0, "supply must not have applied during cooldown");

        vm.warp(block.timestamp + 1 hours + 1);
        submitAgentExecute(address(pool), 0, abi.encodeCall(LendingPool.supplyCollateral, (1 ether)));

        (uint256 supplied,) = pool.positions(address(agent));
        assertEq(supplied, 1 ether);
    }

    /// @notice Emergency path: owner can pause the account (e.g. having
    ///         detected anomalous reasoning-loop behavior) and no further
    ///         UserOperations execute, regardless of policy or signature
    ///         validity, until explicitly unpaused.
    function test_OwnerPauseHaltsAgentEvenWithValidSignatureAndPolicy() public {
        _allowlistStandardAgentActions({maxSupply: 10 ether, maxBorrow: 2500e6, maxRepay: 2500e6, maxWithdraw: 10 ether});

        vm.prank(admin);
        agent.pause();

        PackedUserOperation memory op = buildAndSignExecuteOp(
            address(agent),
            address(collateral),
            0,
            abi.encodeCall(collateral.approve, (address(pool), 1 ether)),
            agentSignerKey
        );
        submitOp(op); // AccountPaused fails inside the bundle, not at the handleOps level
        assertEq(collateral.allowance(address(agent), address(pool)), 0, "paused account must not execute");

        vm.prank(admin);
        agent.unpause();

        submitAgentExecute(address(collateral), 0, abi.encodeCall(collateral.approve, (address(pool), 1 ether)));
        assertEq(collateral.allowance(address(agent), address(pool)), 1 ether);
    }

    /// @notice A rotated-out agent signer immediately loses the ability to
    ///         act — proving key rotation is a real, enforced control and
    ///         not merely cosmetic.
    function test_RotatedOutSignerCanNoLongerAct() public {
        _allowlistStandardAgentActions({maxSupply: 10 ether, maxBorrow: 2500e6, maxRepay: 2500e6, maxWithdraw: 10 ether});

        uint256 oldSignerKey = agentSignerKey;
        address newSigner = makeAddr("rotatedSigner");

        vm.prank(admin);
        agent.rotateAgentSigner(newSigner);

        bytes memory approveCall = abi.encodeCall(collateral.approve, (address(pool), 1 ether));
        PackedUserOperation memory op =
            buildAndSignExecuteOp(address(agent), address(collateral), 0, approveCall, oldSignerKey);
        vm.expectRevert();
        submitOp(op);
    }
}
