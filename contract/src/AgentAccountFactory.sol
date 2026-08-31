// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AgentAccount} from "./AgentAccount.sol";

/// @title AgentAccountFactory
/// @notice Deploys AgentAccount instances via CREATE2 so their addresses
///         are known before deployment (the standard ERC-4337 pattern —
///         a UserOperation's initCode can trigger first-time deployment
///         in the same operation that first uses the account).
contract AgentAccountFactory {
    IEntryPoint public immutable entryPoint;

    event AgentAccountCreated(address indexed account, address indexed owner, address indexed agentSigner, address policyModule, uint256 salt);

    constructor(IEntryPoint anEntryPoint) {
        entryPoint = anEntryPoint;
    }

    /// @notice Deploys (or returns the existing) AgentAccount for the given
    ///         parameters + salt. Idempotent: calling twice with identical
    ///         args returns the same already-deployed account instead of
    ///         reverting, matching the ERC-4337 factory convention used by
    ///         initCode.
    function createAccount(address owner, address agentSigner, address policyModule, uint256 salt)
        external
        returns (AgentAccount account)
    {
        address predicted = getAddress(owner, agentSigner, policyModule, salt);
        uint256 codeSize = predicted.code.length;
        if (codeSize > 0) {
            return AgentAccount(payable(predicted));
        }

        account = new AgentAccount{salt: bytes32(salt)}(entryPoint, owner, agentSigner, policyModule);
        emit AgentAccountCreated(address(account), owner, agentSigner, policyModule, salt);
    }

    /// @notice Computes the counterfactual address for a given parameter
    ///         set without deploying anything.
    function getAddress(address owner, address agentSigner, address policyModule, uint256 salt)
        public
        view
        returns (address predicted)
    {
        bytes memory bytecode = abi.encodePacked(
            type(AgentAccount).creationCode,
            abi.encode(entryPoint, owner, agentSigner, policyModule)
        );
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), keccak256(bytecode)));
        predicted = address(uint160(uint256(hash)));
    }
}
