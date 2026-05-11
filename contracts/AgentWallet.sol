// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title  AgentWallet
 * @notice Non-custodial smart contract wallet for Arc Machina agents.
 *
 * Key properties:
 *  - Only the owner (user) or a valid Session Key can execute transactions.
 *  - Session Keys are time-limited + daily-spend-limited + contract-restricted.
 *  - On-chain daily limits enforce the same caps as the backend (double-safety).
 *  - Owner can pause / revoke at any time.
 *  - No upgradability — code is what it is.
 */
contract AgentWallet is ReentrancyGuard, Pausable {

    // ── Types ─────────────────────────────────────────────────────────────────
    struct SessionKey {
        bool     isActive;
        uint256  dailyLimitUsdc;     // in USDC units (6 decimals)
        uint256  dailySpent;
        uint256  lastResetTimestamp;
        uint256  expiresAt;
        address[] allowedContracts;
        mapping(address => bool) contractAllowed;
    }

    // ── State ────────────────────────────────────────────────────────────────
    address public immutable owner;

    mapping(address => SessionKey) private _sessionKeys;
    address[] public sessionKeyList;

    // ── Events ────────────────────────────────────────────────────────────────
    event Executed(address indexed to, uint256 value, bytes data, address executor);
    event TokenTransferred(address indexed token, address indexed to, uint256 amount);
    event SessionKeyGranted(address indexed key, uint256 dailyLimit, uint256 expiresAt);
    event SessionKeyRevoked(address indexed key);
    event Received(address indexed from, uint256 amount);

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address _owner) {
        require(_owner != address(0), "Invalid owner");
        owner = _owner;
    }

    // ── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "AgentWallet: not owner");
        _;
    }

    modifier onlyAuthorized(uint256 usdcAmount) {
        if (msg.sender == owner) {
            _;
            return;
        }
        SessionKey storage sk = _sessionKeys[msg.sender];
        require(sk.isActive,                          "AgentWallet: invalid session key");
        require(block.timestamp < sk.expiresAt,       "AgentWallet: session key expired");

        // Reset daily counter at midnight UTC
        uint256 today = block.timestamp / 1 days;
        uint256 lastDay = sk.lastResetTimestamp / 1 days;
        if (today > lastDay) {
            sk.dailySpent = 0;
            sk.lastResetTimestamp = block.timestamp;
        }

        require(
            sk.dailySpent + usdcAmount <= sk.dailyLimitUsdc,
            "AgentWallet: daily limit exceeded"
        );
        sk.dailySpent += usdcAmount;
        _;
    }

    // ── Session Key Management (owner only) ───────────────────────────────────
    function grantSessionKey(
        address key,
        uint256 dailyLimitUsdc,
        uint256 expiresAt,
        address[] calldata allowedContracts
    ) external onlyOwner {
        require(key != address(0),               "Invalid key address");
        require(key != owner,                    "Owner cannot be session key");
        require(expiresAt > block.timestamp,     "Expiry must be in the future");
        require(dailyLimitUsdc > 0,              "Limit must be positive");

        SessionKey storage sk = _sessionKeys[key];
        sk.isActive           = true;
        sk.dailyLimitUsdc     = dailyLimitUsdc;
        sk.dailySpent         = 0;
        sk.lastResetTimestamp = block.timestamp;
        sk.expiresAt          = expiresAt;

        // Reset allowed contracts
        for (uint i = 0; i < sk.allowedContracts.length; i++) {
            sk.contractAllowed[sk.allowedContracts[i]] = false;
        }
        delete sk.allowedContracts;

        for (uint i = 0; i < allowedContracts.length; i++) {
            sk.allowedContracts.push(allowedContracts[i]);
            sk.contractAllowed[allowedContracts[i]] = true;
        }

        sessionKeyList.push(key);
        emit SessionKeyGranted(key, dailyLimitUsdc, expiresAt);
    }

    function revokeSessionKey(address key) external onlyOwner {
        _sessionKeys[key].isActive = false;
        emit SessionKeyRevoked(key);
    }

    // ── Execution ─────────────────────────────────────────────────────────────
    /**
     * @notice Execute an arbitrary call from the wallet.
     * @param to          Target contract address.
     * @param value       ETH value to send (0 for ERC-20 operations).
     * @param data        Encoded calldata.
     * @param usdcAmount  USDC equivalent for daily limit accounting (0 for ETH ops).
     */
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 usdcAmount
    ) external nonReentrant whenNotPaused onlyAuthorized(usdcAmount) {
        // Session keys can only call pre-approved contracts
        if (msg.sender != owner) {
            require(_sessionKeys[msg.sender].contractAllowed[to], "Contract not in whitelist");
        }

        (bool success, bytes memory returnData) = to.call{value: value}(data);
        if (!success) {
            // Bubble up revert reason
            if (returnData.length > 0) {
                assembly { revert(add(returnData, 32), mload(returnData)) }
            }
            revert("AgentWallet: execution failed");
        }

        emit Executed(to, value, data, msg.sender);
    }

    /**
     * @notice Convenience: transfer ERC-20 token directly.
     * @param token       ERC-20 token address.
     * @param to          Recipient.
     * @param amount      Amount in token's native decimals.
     * @param usdcEquiv   USDC equivalent for limit accounting.
     */
    function transferToken(
        address token,
        address to,
        uint256 amount,
        uint256 usdcEquiv
    ) external nonReentrant whenNotPaused onlyAuthorized(usdcEquiv) {
        require(to != address(0), "Invalid recipient");
        require(IERC20(token).transfer(to, amount), "Transfer failed");
        emit TokenTransferred(token, to, amount);
    }

    // ── Owner controls ────────────────────────────────────────────────────────
    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ── View helpers ──────────────────────────────────────────────────────────
    function getSessionKeyInfo(address key)
        external view
        returns (
            bool    isActive,
            uint256 dailyLimit,
            uint256 dailySpent,
            uint256 expiresAt
        )
    {
        SessionKey storage sk = _sessionKeys[key];
        uint256 today   = block.timestamp / 1 days;
        uint256 lastDay = sk.lastResetTimestamp / 1 days;
        uint256 spent   = today > lastDay ? 0 : sk.dailySpent;
        return (sk.isActive, sk.dailyLimitUsdc, spent, sk.expiresAt);
    }

    // ── Receive ETH ───────────────────────────────────────────────────────────
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}
