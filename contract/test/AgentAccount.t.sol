// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./helpers/TestBase.sol";
import {AgentAccount} from "../src/AgentAccount.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

contract AgentAccountTest is TestBase {
    function test_AccountDeployedWithCorrectRoles() public view {
        assertEq(agent.owner(), admin);
        assertEq(agent.agentSigner(), agentSigner);
        assertEq(address(agent.policyModule()), address(policy));
        assertEq(address(agent.entryPoint()), address(entryPoint));
    }

    function test_FactoryIsIdempotent() public {
        AgentAccount again = factory.createAccount(admin, agentSigner, address(policy), 1);
        assertEq(address(again), address(agent));
    }

    function test_FactoryPredictsAddressBeforeDeployment() public {
        address predicted = factory.getAddress(admin, agentSigner, address(policy), 2);
        assertEq(predicted.code.length, 0);

        AgentAccount deployed = factory.createAccount(admin, agentSigner, address(policy), 2);
        assertEq(address(deployed), predicted);
        assertGt(predicted.code.length, 0);
    }

    function test_OwnerCanRotateAgentSigner() public {
        address newSigner = makeAddr("newSigner");
        vm.prank(admin);
        agent.rotateAgentSigner(newSigner);
        assertEq(agent.agentSigner(), newSigner);
    }

    function test_NonOwnerCannotRotateAgentSigner() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(AgentAccount.NotOwner.selector);
        agent.rotateAgentSigner(makeAddr("newSigner"));
    }

    function test_OwnerCanPauseAndUnpause() public {
        vm.prank(admin);
        agent.pause();
        assertTrue(agent.paused());

        vm.prank(admin);
        agent.unpause();
        assertFalse(agent.paused());
    }

    function test_ExecuteRevertsWhenPaused() public {
        vm.prank(admin);
        agent.pause();

        vm.prank(admin); // owner-direct path
        vm.expectRevert(AgentAccount.AccountPaused.selector);
        agent.execute(address(collateral), 0, "");
    }

    function test_OwnerCanExecuteDirectly() public {
        vm.prank(admin);
        policy.setRule(address(agent), address(collateral), bytes4(keccak256("approve(address,uint256)")), true, 0);

        bytes memory approveCall = abi.encodeCall(collateral.approve, (address(pool), 2 ether));
        vm.prank(admin);
        agent.execute(address(collateral), 0, approveCall);

        assertEq(collateral.allowance(address(agent), address(pool)), 2 ether);
    }

    function test_NonOwnerNonEntryPointCannotExecute() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(AgentAccount.UnauthorizedCaller.selector);
        agent.execute(address(collateral), 0, "");
    }

    function test_SetPolicyModuleOnlyOwner() public {
        address newPolicy = makeAddr("newPolicy");
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(AgentAccount.NotOwner.selector);
        agent.setPolicyModule(newPolicy);

        vm.prank(admin);
        agent.setPolicyModule(newPolicy);
        assertEq(address(agent.policyModule()), newPolicy);
    }

    function test_TransferOwnership() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(admin);
        agent.transferOwnership(newOwner);
        assertEq(agent.owner(), newOwner);

        // old owner can no longer administer
        vm.prank(admin);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        agent.pause();
    }

    // -----------------------------------------------------------
    // Real ERC-4337 flow: sign a UserOperation with the agent key,
    // submit through the actual EntryPoint, and confirm it lands.
    // -----------------------------------------------------------

    function test_ValidUserOperationExecutesThroughEntryPoint() public {
        vm.prank(admin);
        policy.setRule(address(agent), address(collateral), bytes4(keccak256("approve(address,uint256)")), true, 0);

        bytes memory approveCall = abi.encodeCall(collateral.approve, (address(pool), 5 ether));
        submitAgentExecute(address(collateral), 0, approveCall);

        assertEq(collateral.allowance(address(agent), address(pool)), 5 ether);
    }

    function test_UserOperationSignedByOwnerAlsoValid() public {
        uint256 ownerKey = 0xB0B;
        address ownerAddr = vm.addr(ownerKey);

        vm.prank(admin);
        AgentAccount ownerSignableAgent = factory.createAccount(ownerAddr, agentSigner, address(policy), 99);
        vm.prank(admin);
        policy.registerAccount(address(ownerSignableAgent));
        vm.prank(admin);
        policy.setRule(
            address(ownerSignableAgent), address(collateral), bytes4(keccak256("approve(address,uint256)")), true, 0
        );
        vm.deal(address(ownerSignableAgent), 1 ether);

        bytes memory approveCall = abi.encodeCall(collateral.approve, (address(pool), 1 ether));
        submitExecuteFor(address(ownerSignableAgent), address(collateral), 0, approveCall, ownerKey);

        assertEq(collateral.allowance(address(ownerSignableAgent), address(pool)), 1 ether);
    }

    function test_UserOperationWithInvalidSignatureFailsValidation() public {
        vm.prank(admin);
        policy.setRule(address(agent), address(collateral), bytes4(keccak256("approve(address,uint256)")), true, 0);

        uint256 wrongKey = 0xBAD;
        bytes memory approveCall = abi.encodeCall(collateral.approve, (address(pool), 1 ether));

        PackedUserOperation memory op =
            buildAndSignExecuteOp(address(agent), address(collateral), 0, approveCall, wrongKey);

        vm.expectRevert(); // EntryPoint reverts with FailedOp on sig validation failure
        submitOp(op);
    }

    function test_UserOperationBlockedByPolicyRevertsAtExecution() public {
        // Deliberately do NOT set a policy rule — signature validation
        // succeeds, so per real ERC-4337 semantics EntryPoint.handleOps
        // itself does NOT revert (it catches execution-phase failures,
        // emits UserOperationRevertReason + UserOperationEvent(success:
        // false), and still pays the bundler). What matters — and what
        // this test actually proves — is that the blocked call never
        // touched application state, confirming enforcement happens in
        // execute(), not merely as an off-chain courtesy the agent could
        // route around.
        bytes memory approveCall = abi.encodeCall(collateral.approve, (address(pool), 1 ether));
        PackedUserOperation memory op =
            buildAndSignExecuteOp(address(agent), address(collateral), 0, approveCall, agentSignerKey);

        submitOp(op); // does not revert — the individual op fails inside the bundle
        assertEq(collateral.allowance(address(agent), address(pool)), 0, "blocked action must not have applied");
    }

    function test_ExecuteBatchAppliesPolicyToEachCallIndependently() public {
        vm.startPrank(admin);
        policy.setRule(address(agent), address(collateral), bytes4(keccak256("approve(address,uint256)")), true, 0);
        // Deliberately do not allowlist a second target — batch must revert entirely.
        vm.stopPrank();

        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory datas = new bytes[](2);

        targets[0] = address(collateral);
        datas[0] = abi.encodeCall(collateral.approve, (address(pool), 1 ether));
        targets[1] = address(usdc); // not allowlisted
        datas[1] = abi.encodeCall(usdc.approve, (address(pool), 1e6));

        vm.prank(admin);
        vm.expectRevert(); // PolicyModule.NotAllowlisted for the second call
        agent.executeBatch(targets, values, datas);

        // Confirm atomicity: the first (allowlisted) call must not have applied either
        assertEq(collateral.allowance(address(agent), address(pool)), 0);
    }
}
