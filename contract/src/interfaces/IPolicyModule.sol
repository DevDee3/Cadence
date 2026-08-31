// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPolicyModule
/// @notice Deterministic, on-chain authorization gate every agent-initiated
///         call must pass before execution. The AI reasons; this contract
///         enforces. It has no knowledge of "why" an action was proposed —
///         only whether the target, selector, and amount fall inside the
///         rules an admin configured for that agent account.
interface IPolicyModule {
    /// @notice Checks whether `msg.sender` (the calling AgentAccount) may
    ///         invoke `selector` on `target` with `amount`, and if so,
    ///         records the action (advancing the cooldown clock). Reverts
    ///         with a descriptive reason on any violation — never returns
    ///         false silently, so a blocked action is always traceable
    ///         on-chain by revert reason.
    /// @param target   Contract the agent wants to call.
    /// @param selector Function selector being invoked.
    /// @param amount   Deterministically-extracted numeric argument (e.g.
    ///                 the `uint256` amount for repay/supply/withdraw-style
    ///                 calls). Zero for calls with no relevant amount.
    function checkAndConsume(address target, bytes4 selector, uint256 amount) external returns (bool);

    /// @notice View-only precheck, identical logic to checkAndConsume but
    ///         without mutating cooldown state. Useful for the off-chain
    ///         agent to simulate before spending gas on a doomed UserOp.
    function wouldAllow(address account, address target, bytes4 selector, uint256 amount)
        external
        view
        returns (bool allowed, string memory reason);
}
