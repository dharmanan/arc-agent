// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  ArcRevenuePool
 * @notice Collects platform fees from Tier-2 paid agent tasks and distributes
 *         them via owner-controlled withdrawals or community raffles.
 *
 * Flow:
 *  1. Platform (relayer) calls depositFee() after each paid task execution.
 *  2. Owner can withdraw() accumulated fees at any time.
 *  3. Owner can award raffle() prizes to winning addresses.
 *
 * Only USDC is accepted (Arc Testnet USDC = 0x3600000000000000000000000000000000000000).
 */
contract ArcRevenuePool is ReentrancyGuard {

    // ── State ─────────────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    address public          owner;
    address public          platform;   // relayer / backend address allowed to call depositFee

    uint256 public totalDeposited;
    uint256 public totalWithdrawn;

    // ── Events ────────────────────────────────────────────────────────────────
    event FeeDeposited(address indexed from, uint256 amount, uint256 poolBalance);
    event Withdrawn(address indexed to, uint256 amount);
    event RaffleWinner(address indexed winner, uint256 amount);
    event PlatformUpdated(address indexed oldPlatform, address indexed newPlatform);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // ── Modifiers ─────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "ArcRevenuePool: caller is not owner");
        _;
    }

    modifier onlyPlatform() {
        require(
            msg.sender == platform || msg.sender == owner,
            "ArcRevenuePool: caller is not platform"
        );
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    /**
     * @param _usdc     USDC token address on this chain.
     * @param _platform Relayer / backend address allowed to deposit fees.
     */
    constructor(address _usdc, address _platform) {
        require(_usdc     != address(0), "ArcRevenuePool: zero usdc address");
        require(_platform != address(0), "ArcRevenuePool: zero platform address");
        usdc     = IERC20(_usdc);
        owner    = msg.sender;
        platform = _platform;
    }

    // ── Platform functions ────────────────────────────────────────────────────

    /**
     * @notice Deposit a platform fee from a paid task execution.
     *         The caller must have already approved this contract to spend `amount` USDC.
     * @param amount USDC amount (6 decimals).
     */
    function depositFee(uint256 amount) external onlyPlatform nonReentrant {
        require(amount > 0, "ArcRevenuePool: zero amount");
        uint256 before = usdc.balanceOf(address(this));
        require(usdc.transferFrom(msg.sender, address(this), amount), "ArcRevenuePool: transfer failed");
        uint256 received = usdc.balanceOf(address(this)) - before;
        totalDeposited += received;
        emit FeeDeposited(msg.sender, received, usdc.balanceOf(address(this)));
    }

    // ── Owner functions ───────────────────────────────────────────────────────

    /**
     * @notice Withdraw USDC from the pool to `to`.
     * @param to     Recipient address.
     * @param amount USDC amount (6 decimals). Pass 0 to withdraw entire balance.
     */
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "ArcRevenuePool: zero recipient");
        uint256 balance = usdc.balanceOf(address(this));
        uint256 payout  = amount == 0 ? balance : amount;
        require(payout > 0, "ArcRevenuePool: nothing to withdraw");
        require(payout <= balance, "ArcRevenuePool: insufficient balance");
        totalWithdrawn += payout;
        require(usdc.transfer(to, payout), "ArcRevenuePool: transfer failed");
        emit Withdrawn(to, payout);
    }

    /**
     * @notice Award a raffle prize to `winner`.
     * @param winner Winning address.
     * @param amount USDC prize amount (6 decimals).
     */
    function raffle(address winner, uint256 amount) external onlyOwner nonReentrant {
        require(winner != address(0), "ArcRevenuePool: zero winner");
        require(amount > 0, "ArcRevenuePool: zero amount");
        uint256 balance = usdc.balanceOf(address(this));
        require(amount <= balance, "ArcRevenuePool: insufficient balance");
        totalWithdrawn += amount;
        require(usdc.transfer(winner, amount), "ArcRevenuePool: transfer failed");
        emit RaffleWinner(winner, amount);
    }

    /**
     * @notice Update the platform address (e.g. after relayer key rotation).
     */
    function setPlatform(address _platform) external onlyOwner {
        require(_platform != address(0), "ArcRevenuePool: zero address");
        emit PlatformUpdated(platform, _platform);
        platform = _platform;
    }

    /**
     * @notice Transfer contract ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ArcRevenuePool: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    /**
     * @notice Current USDC balance held by the pool.
     */
    function getPoolBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
