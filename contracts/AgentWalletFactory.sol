// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  AgentWalletFactory
 * @notice Deploys one AgentWallet per user address.
 *         Emits an event so the indexer can track new agent addresses.
 */
contract AgentWalletFactory {

    // ── Events ────────────────────────────────────────────────────────────────
    event WalletCreated(address indexed owner, address indexed wallet, uint256 timestamp);

    // ── State ─────────────────────────────────────────────────────────────────
    mapping(address => address) public walletOf;
    address[] public allWallets;

    // ── Deploy ────────────────────────────────────────────────────────────────
    /**
     * @notice Deploy a new AgentWallet for msg.sender.
     *         Reverts if the caller already has one.
     */
    function createWallet() external returns (address wallet) {
        require(walletOf[msg.sender] == address(0), "Factory: wallet already exists");

        // Import here to avoid circular dependency in the same file
        bytes memory bytecode = abi.encodePacked(
            type(AgentWalletProxy).creationCode,
            abi.encode(msg.sender)
        );

        bytes32 salt = keccak256(abi.encodePacked(msg.sender, block.chainid));
        assembly {
            wallet := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        require(wallet != address(0), "Factory: deployment failed");

        walletOf[msg.sender] = wallet;
        allWallets.push(wallet);

        emit WalletCreated(msg.sender, wallet, block.timestamp);
    }

    function totalWallets() external view returns (uint256) {
        return allWallets.length;
    }
}

/**
 * @dev Minimal proxy used by the factory — delegates to AgentWallet logic.
 *      In production use EIP-1167 minimal proxy for gas savings.
 */
contract AgentWalletProxy {
    address public immutable owner;
    constructor(address _owner) { owner = _owner; }
}
