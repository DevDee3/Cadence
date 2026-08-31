// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPolicyModule} from "./interfaces/IPolicyModule.sol";

/// @title PolicyModule
/// @notice Deterministic guardrail contract for autonomous AgentAccounts.
///         Mirrors the AegisX split: the LLM proposes and reasons, this
///         contract is the sole authority on whether an action executes.
///         Three independent controls, all enforced on-chain (never in
///         off-chain application code the agent could route around):
///           1. Function-level allowlist  — target + selector must be
///              explicitly approved per agent account.
///           2. Per-call spend cap        — numeric amount argument (when
///              present) must not exceed the configured ceiling.
///           3. Cooldown                  — minimum spacing between any two
///              actions from the same agent account, bounding blast radius
///              from a compromised or misbehaving reasoning loop.
contract PolicyModule is IPolicyModule, Ownable {
    struct Rule {
        bool allowed;
        uint256 maxAmountPerCall; // 0 == no numeric argument expected / cap not applicable
    }

    /// account => target => selector => rule
    mapping(address => mapping(address => mapping(bytes4 => Rule))) public rules;

    /// account => cooldown window in seconds between consumed actions
    mapping(address => uint256) public cooldownSeconds;

    /// account => timestamp of the last consumed (successful) action
    mapping(address => uint256) public lastActionAt;

    /// account => whether this contract has been configured to guard it.
    /// Purely informational / for indexers — does not gate checkAndConsume.
    mapping(address => bool) public isRegisteredAccount;

    event RuleSet(address indexed account, address indexed target, bytes4 indexed selector, bool allowed, uint256 maxAmountPerCall);
    event CooldownSet(address indexed account, uint256 cooldownSeconds);
    event AccountRegistered(address indexed account);
    event ActionConsumed(address indexed account, address indexed target, bytes4 indexed selector, uint256 amount, uint256 timestamp);

    error NotAllowlisted(address account, address target, bytes4 selector);
    error ExceedsCap(address account, address target, bytes4 selector, uint256 amount, uint256 cap);
    error CooldownActive(address account, uint256 readyAt);

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------
    // Admin configuration (owner only — the human operator, never the
    // agent signer itself)
    // ---------------------------------------------------------------

    function registerAccount(address account) external onlyOwner {
        isRegisteredAccount[account] = true;
        emit AccountRegistered(account);
    }

    function setRule(address account, address target, bytes4 selector, bool allowed, uint256 maxAmountPerCall)
        external
        onlyOwner
    {
        rules[account][target][selector] = Rule({allowed: allowed, maxAmountPerCall: maxAmountPerCall});
        emit RuleSet(account, target, selector, allowed, maxAmountPerCall);
    }

    function setCooldown(address account, uint256 newCooldownSeconds) external onlyOwner {
        cooldownSeconds[account] = newCooldownSeconds;
        emit CooldownSet(account, newCooldownSeconds);
    }

    // ---------------------------------------------------------------
    // Enforcement — called by the AgentAccount itself (msg.sender ==
    // the agent account) on every execute()
    // ---------------------------------------------------------------

    /// @inheritdoc IPolicyModule
    function checkAndConsume(address target, bytes4 selector, uint256 amount) external returns (bool) {
        address account = msg.sender;
        Rule memory rule = rules[account][target][selector];

        if (!rule.allowed) revert NotAllowlisted(account, target, selector);
        if (rule.maxAmountPerCall != 0 && amount > rule.maxAmountPerCall) {
            revert ExceedsCap(account, target, selector, amount, rule.maxAmountPerCall);
        }

        uint256 cd = cooldownSeconds[account];
        uint256 last = lastActionAt[account];
        if (cd != 0 && last != 0 && block.timestamp < last + cd) {
            revert CooldownActive(account, last + cd);
        }

        lastActionAt[account] = block.timestamp;
        emit ActionConsumed(account, target, selector, amount, block.timestamp);
        return true;
    }

    /// @inheritdoc IPolicyModule
    function wouldAllow(address account, address target, bytes4 selector, uint256 amount)
        external
        view
        returns (bool allowed, string memory reason)
    {
        Rule memory rule = rules[account][target][selector];
        if (!rule.allowed) {
            return (false, "not allowlisted");
        }
        if (rule.maxAmountPerCall != 0 && amount > rule.maxAmountPerCall) {
            return (false, "exceeds per-call cap");
        }
        uint256 cd = cooldownSeconds[account];
        uint256 last = lastActionAt[account];
        if (cd != 0 && last != 0 && block.timestamp < last + cd) {
            return (false, "cooldown active");
        }
        return (true, "");
    }
}
