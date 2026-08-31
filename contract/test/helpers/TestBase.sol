// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {AgentAccount} from "../../src/AgentAccount.sol";
import {AgentAccountFactory} from "../../src/AgentAccountFactory.sol";
import {PolicyModule} from "../../src/PolicyModule.sol";
import {PriceOracle} from "../../src/PriceOracle.sol";
import {LendingPool} from "../../src/LendingPool.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockCollateralToken} from "../../src/mocks/MockCollateralToken.sol";

/// @title TestBase
/// @notice Deploys the full Cadence stack (EntryPoint, AgentAccount +
///         factory, PolicyModule, PriceOracle, LendingPool, mock tokens)
///         and exposes a helper to build, sign, and submit a
///         PackedUserOperation through the real EntryPoint — so tests
///         exercise the actual ERC-4337 path an Arc bundler would use,
///         not a shortcut around it.
abstract contract TestBase is Test {
    EntryPoint entryPoint;
    AgentAccountFactory factory;
    PolicyModule policy;
    PriceOracle oracle;
    LendingPool pool;
    MockUSDC usdc;
    MockCollateralToken collateral;

    address admin = makeAddr("admin");
    uint256 agentSignerKey = 0xA11CE;
    address agentSigner;
    AgentAccount agent;

    // 1 collateral token = 3000 USDC, matches a WETH-like asset
    uint256 constant INITIAL_PRICE = 3000e18;

    function setUp() public virtual {
        agentSigner = vm.addr(agentSignerKey);

        entryPoint = new EntryPoint();

        vm.startPrank(admin);
        policy = new PolicyModule(admin);
        oracle = new PriceOracle(admin);
        usdc = new MockUSDC(admin);
        collateral = new MockCollateralToken(admin);
        pool = new LendingPool(admin, collateral, usdc, oracle);
        factory = new AgentAccountFactory(IEntryPoint(address(entryPoint)));

        oracle.setPrice(address(collateral), INITIAL_PRICE);

        // Seed pool liquidity so the agent can borrow against its collateral
        usdc.mint(admin, 1_000_000e6);
        usdc.approve(address(pool), 1_000_000e6);
        pool.fundPoolLiquidity(1_000_000e6);
        vm.stopPrank();

        // Deploy the agent's smart account (owner = admin, signer = agentSigner)
        agent = factory.createAccount(admin, agentSigner, address(policy), 1);

        vm.prank(admin);
        policy.registerAccount(address(agent));

        // Fund the agent account with collateral + a little native currency
        // for gas prefunding to the EntryPoint.
        vm.startPrank(admin);
        collateral.mint(address(agent), 10 ether);
        vm.deal(address(agent), 10 ether);
        vm.stopPrank();
    }

    /// @dev Builds and signs a UserOperation targeting
    ///      `agent.execute(target, value, data)` WITHOUT submitting it.
    ///      Callers that need `vm.expectRevert()` to target the actual
    ///      `handleOps` call (not an intermediate view call inside the
    ///      build step) should call this, then `vm.expectRevert()`, then
    ///      `submitOp(op)` — never `vm.expectRevert()` immediately before
    ///      a helper that itself makes a staticcall first.
    function buildAndSignExecuteOp(address sender, address target, uint256 value, bytes memory data, uint256 signerKey)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        bytes memory callData = abi.encodeCall(AgentAccount.execute, (target, value, data));
        op = _buildUnsignedOpFor(sender, callData);
        op.signature = _sign(op, signerKey);
    }

    /// @dev Submits a single already-built-and-signed op via handleOps.
    ///      This is the call `vm.expectRevert()` should wrap directly.
    function submitOp(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(admin));
    }

    /// @dev Convenience: build, sign (with the default agent key), and
    ///      submit in one call, for happy-path tests that don't need
    ///      expectRevert precision.
    function submitAgentExecute(address target, uint256 value, bytes memory data) internal {
        PackedUserOperation memory op = buildAndSignExecuteOp(address(agent), target, value, data, agentSignerKey);
        submitOp(op);
    }

    /// @dev Same as submitAgentExecute but for an arbitrary sender account
    ///      and signer key — used to test the owner-signature path.
    ///      For revert-expectation tests, prefer buildAndSignExecuteOp +
    ///      vm.expectRevert() + submitOp instead of this.
    function submitExecuteFor(address sender, address target, uint256 value, bytes memory data, uint256 signerKey)
        internal
    {
        PackedUserOperation memory op = buildAndSignExecuteOp(sender, target, value, data, signerKey);
        submitOp(op);
    }

    function _buildUnsignedOp(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        return _buildUnsignedOpFor(address(agent), callData);
    }

    function _buildUnsignedOpFor(address sender, bytes memory callData)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        uint256 nonce = entryPoint.getNonce(sender, 0);
        op = PackedUserOperation({
            sender: sender,
            nonce: nonce,
            initCode: bytes(""),
            callData: callData,
            accountGasLimits: _packGasLimits(500_000, 500_000),
            preVerificationGas: 100_000,
            gasFees: _packGasLimits(1 gwei, 10 gwei),
            paymasterAndData: bytes(""),
            signature: bytes("")
        });
    }

    function _packGasLimits(uint256 a, uint256 b) internal pure returns (bytes32) {
        return bytes32((a << 128) | b);
    }

    function _sign(PackedUserOperation memory op, uint256 privateKey) internal view returns (bytes memory) {
        bytes32 userOpHash = entryPoint.getUserOpHash(op);
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, ethSignedHash);
        return abi.encodePacked(r, s, v);
    }
}
