// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title AgenticCommerce
 * @notice Minimal ERC-8183-style escrow for agent-to-agent job marketplace.
 *
 * Flow:
 *   1. Client calls createJob() — USDC locked in escrow
 *   2. Provider calls deliver() — submits deliverable hash
 *   3. Client calls complete() — releases USDC to provider
 *      OR client calls cancel() — refunds USDC to client (only if not delivered)
 *
 * Fees: none (Arc Machina collects fees off-chain via oracle routes).
 */
contract AgenticCommerce is ReentrancyGuard, Pausable {
    // ── Types ─────────────────────────────────────────────────────────────────
    enum JobStatus { Open, Funded, Delivered, Completed, Cancelled }

    struct Job {
        uint256 id;
        address client;
        address provider;
        uint256 amount;       // USDC (6 decimals)
        string  description;
        JobStatus status;
        bytes32 deliverableHash;
        uint256 createdAt;
        uint256 updatedAt;
    }

    // ── State ─────────────────────────────────────────────────────────────────
    IERC20  public immutable usdc;
    address public           owner;

    uint256 private _nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    // ── Events ────────────────────────────────────────────────────────────────
    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        uint256 amount,
        string  description
    );
    event JobDelivered(uint256 indexed jobId, bytes32 deliverableHash);
    event JobCompleted(uint256 indexed jobId, address provider, uint256 amount);
    event JobCancelled(uint256 indexed jobId, address client, uint256 refund);
    event OwnershipTransferred(address indexed previous, address indexed next);

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotClient();
    error NotProvider();
    error InvalidStatus(JobStatus current, JobStatus required);
    error ZeroAmount();
    error ZeroAddress();
    error JobNotFound();
    error TransferFailed();

    // ── Modifiers ─────────────────────────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier jobExists(uint256 jobId) {
        if (jobs[jobId].client == address(0)) revert JobNotFound();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _usdc, address _owner) {
        if (_usdc    == address(0)) revert ZeroAddress();
        if (_owner   == address(0)) revert ZeroAddress();
        usdc  = IERC20(_usdc);
        owner = _owner;
    }

    // ── Client actions ────────────────────────────────────────────────────────

    /**
     * @notice Create a new job. Locks `amount` USDC from caller into escrow.
     * @param provider  Address that will execute the job.
     * @param amount    USDC amount (6 decimals) to lock in escrow.
     * @param description  Human-readable job description (max 500 chars enforced off-chain).
     * @return jobId    Sequential job identifier.
     */
    function createJob(
        address provider,
        uint256 amount,
        string calldata description
    ) external nonReentrant whenNotPaused returns (uint256 jobId) {
        if (provider == address(0)) revert ZeroAddress();
        if (amount   == 0)          revert ZeroAmount();

        bool ok = usdc.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        jobId = _nextJobId++;
        jobs[jobId] = Job({
            id:              jobId,
            client:          msg.sender,
            provider:        provider,
            amount:          amount,
            description:     description,
            status:          JobStatus.Funded,
            deliverableHash: bytes32(0),
            createdAt:       block.timestamp,
            updatedAt:       block.timestamp
        });

        emit JobCreated(jobId, msg.sender, provider, amount, description);
    }

    /**
     * @notice Cancel a Funded job — returns USDC to client.
     *         Cannot cancel after provider has delivered.
     */
    function cancel(uint256 jobId)
        external
        nonReentrant
        jobExists(jobId)
    {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        if (job.status != JobStatus.Funded) revert InvalidStatus(job.status, JobStatus.Funded);

        job.status    = JobStatus.Cancelled;
        job.updatedAt = block.timestamp;

        bool ok = usdc.transfer(job.client, job.amount);
        if (!ok) revert TransferFailed();

        emit JobCancelled(jobId, job.client, job.amount);
    }

    /**
     * @notice Mark job as completed — releases USDC to provider.
     *         Called by client after reviewing the deliverable.
     */
    function complete(uint256 jobId)
        external
        nonReentrant
        jobExists(jobId)
    {
        Job storage job = jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        if (job.status != JobStatus.Delivered) revert InvalidStatus(job.status, JobStatus.Delivered);

        job.status    = JobStatus.Completed;
        job.updatedAt = block.timestamp;

        bool ok = usdc.transfer(job.provider, job.amount);
        if (!ok) revert TransferFailed();

        emit JobCompleted(jobId, job.provider, job.amount);
    }

    // ── Provider actions ──────────────────────────────────────────────────────

    /**
     * @notice Submit deliverable hash. Must be called by the designated provider.
     * @param jobId          Job to deliver.
     * @param deliverableHash  keccak256 hash of the deliverable (URL, IPFS CID, etc.)
     */
    function deliver(uint256 jobId, bytes32 deliverableHash)
        external
        jobExists(jobId)
    {
        Job storage job = jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != JobStatus.Funded) revert InvalidStatus(job.status, JobStatus.Funded);

        job.status          = JobStatus.Delivered;
        job.deliverableHash = deliverableHash;
        job.updatedAt       = block.timestamp;

        emit JobDelivered(jobId, deliverableHash);
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    /// @notice Returns full job details.
    function getJob(uint256 jobId) external view jobExists(jobId) returns (Job memory) {
        return jobs[jobId];
    }

    /// @notice Total jobs created so far.
    function totalJobs() external view returns (uint256) {
        return _nextJobId - 1;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
