// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReputationRegistry
 * @notice Minimal ERC-8004-style reputation ledger for agent identity token ids.
 *         Authorized recorders append scored events; the contract keeps a
 *         running score per token id and emits an event for off-chain indexing.
 */
contract ReputationRegistry {
    address public owner;
    mapping(address => bool) public recorders;

    mapping(uint256 => uint256) private scores;
    mapping(uint256 => uint256) public totalEvents;

    event ReputationRecorded(
        uint256 indexed tokenId,
        string eventType,
        int256 scoreDelta,
        uint256 newScore
    );
    event RecorderUpdated(address indexed recorder, bool enabled);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "ReputationRegistry: caller is not owner");
        _;
    }

    modifier onlyRecorder() {
        require(
            msg.sender == owner || recorders[msg.sender],
            "ReputationRegistry: caller is not recorder"
        );
        _;
    }

    constructor(address initialRecorder) {
        owner = msg.sender;

        if (initialRecorder != address(0) && initialRecorder != msg.sender) {
            recorders[initialRecorder] = true;
            emit RecorderUpdated(initialRecorder, true);
        }
    }

    function recordEvent(
        uint256 tokenId,
        string calldata eventType,
        int256 scoreDelta
    ) external onlyRecorder returns (bool) {
        require(tokenId != 0, "ReputationRegistry: invalid token id");

        uint256 current = scores[tokenId];
        uint256 nextScore;

        if (scoreDelta < 0) {
            uint256 absDelta = uint256(-scoreDelta);
            nextScore = absDelta >= current ? 0 : current - absDelta;
        } else {
            nextScore = current + uint256(scoreDelta);
        }

        scores[tokenId] = nextScore;
        totalEvents[tokenId] += 1;

        emit ReputationRecorded(tokenId, eventType, scoreDelta, nextScore);
        return true;
    }

    function getScore(uint256 tokenId) external view returns (uint256) {
        return scores[tokenId];
    }

    function setRecorder(address recorder, bool enabled) external onlyOwner {
        require(recorder != address(0), "ReputationRegistry: zero recorder");
        recorders[recorder] = enabled;
        emit RecorderUpdated(recorder, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ReputationRegistry: zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}