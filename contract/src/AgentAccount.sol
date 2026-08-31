// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseAccount} from "account-abstraction/core/BaseAccount.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IPolicyModule} from "./interfaces/IPolicyModule.sol";

/// @title AgentAccount
/// @notice ERC-4337 smart contract account controlled by an autonomous
///         agent signer, with every outbound call gated by an external,
///         deterministic PolicyModule. This is the "wallet" half of the
///         perceive -> reason -> act loop: the off-chain agent (an LLM
///         reasoning over live chain state) decides *what* to do, but this
///         contract enforces *whether it's allowed*, on-chain, independent
///         of the agent's own judgment.
///
/// Roles:
///  - `owner`       Human operator. Can rotate the agent signer, pause the
///                   account in an emergency, and change the policy
///                   module. Never signs routine UserOperations.
///  - `agentSigner` The autonomous key used to sign day-to-day
///                   UserOperations. Compromise of this key is bounded by
///                   the PolicyModule — it can never act outside the
///                   allowlisted target/selector/amount/cooldown rules.
///
/// One AgentAccount is deployed per agent (via AgentAccountFactory using
/// CREATE2, so the address is known before deployment and can receive
/// funds counterfactually).
contract AgentAccount is BaseAccount {
    using ECDSA for bytes32;

    IEntryPoint private immutable _entryPoint;

    address public owner;
    address public agentSigner;
    IPolicyModule public policyModule;
    bool public paused;

    event AgentAccountDeployed(address indexed entryPoint, address indexed owner, address indexed agentSigner, address policyModule);
    event AgentSignerRotated(address indexed previousSigner, address indexed newSigner);
    event PolicyModuleUpdated(address indexed previousPolicy, address indexed newPolicy);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event ActionExecuted(address indexed target, bytes4 indexed selector, uint256 amount, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error AccountPaused();
    error CallReverted(bytes returnData);
    error ZeroAddress();
    error LengthMismatch();
    error UnauthorizedCaller();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert AccountPaused();
        _;
    }

    constructor(IEntryPoint anEntryPoint, address initialOwner, address initialAgentSigner, address initialPolicyModule) {
        if (initialOwner == address(0) || initialAgentSigner == address(0) || initialPolicyModule == address(0)) {
            revert ZeroAddress();
        }
        _entryPoint = anEntryPoint;
        owner = initialOwner;
        agentSigner = initialAgentSigner;
        policyModule = IPolicyModule(initialPolicyModule);
        emit AgentAccountDeployed(address(anEntryPoint), initialOwner, initialAgentSigner, initialPolicyModule);
    }

    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    // ---------------------------------------------------------------
    // Owner administration
    // ---------------------------------------------------------------

    function rotateAgentSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit AgentSignerRotated(agentSigner, newSigner);
        agentSigner = newSigner;
    }

    function setPolicyModule(address newPolicyModule) external onlyOwner {
        if (newPolicyModule == address(0)) revert ZeroAddress();
        emit PolicyModuleUpdated(address(policyModule), newPolicyModule);
        policyModule = IPolicyModule(newPolicyModule);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------
    // Execution — the only path by which this account's funds move.
    // Callable by the EntryPoint (as part of a validated UserOperation)
    // or directly by the owner (emergency / manual override, e.g. to
    // unwind a position the agent can't reach under current policy).
    // ---------------------------------------------------------------

    function execute(address target, uint256 value, bytes calldata data) external whenNotPaused {
        if (msg.sender != address(entryPoint()) && msg.sender != owner) revert UnauthorizedCaller();
        _executeChecked(target, value, data);
    }

    /// @notice Batch variant for multi-step actions (e.g. approve + repay)
    ///         that must succeed atomically. Each call is independently
    ///         policy-checked.
    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas)
        external
        whenNotPaused
    {
        if (msg.sender != address(entryPoint()) && msg.sender != owner) revert UnauthorizedCaller();
        if (targets.length != values.length || values.length != datas.length) revert LengthMismatch();

        for (uint256 i = 0; i < targets.length; i++) {
            _executeChecked(targets[i], values[i], datas[i]);
        }
    }

    function _executeChecked(address target, uint256 value, bytes calldata data) internal {
        bytes4 selector;
        uint256 amount;
        if (data.length >= 4) {
            selector = bytes4(data[:4]);
        }
        if (data.length >= 36) {
            // Deterministically decode the first calldata argument as a
            // uint256. This is the amount PolicyModule checks against for
            // the standard repay(uint256)/supply(uint256)/withdraw(uint256)
            // shape of calls this agent is scoped to make. A target
            // function with a different first-argument shape should be
            // allowlisted with maxAmountPerCall == 0 (uncapped) rather
            // than relying on this decode.
            amount = abi.decode(data[4:36], (uint256));
        }

        policyModule.checkAndConsume(target, selector, amount);

        (bool success, bytes memory ret) = target.call{value: value}(data);
        if (!success) revert CallReverted(ret);

        emit ActionExecuted(target, selector, amount, value);
    }

    // ---------------------------------------------------------------
    // ERC-4337 signature validation
    // ---------------------------------------------------------------

    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (uint256 validationData)
    {
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        address recovered = ethSignedHash.recover(userOp.signature);

        if (recovered == agentSigner || recovered == owner) {
            return _packValidationData(false, 0, 0); // valid, no time bounds
        }
        return _packValidationData(true, 0, 0); // SIG_VALIDATION_FAILED
    }

    // Allow the account to hold and receive native USDC (Arc's native gas
    // token) and act as a funding source for its own UserOperations.
    receive() external payable {}
}
