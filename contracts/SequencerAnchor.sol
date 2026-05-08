// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SequencerAnchor
 * @dev On-chain anchor for the Multi-Node Probabilistic Sequencer Network (MNPSN).
 *      Stores cumulative state roots that chain the entire batch history.
 *      See ARCH-002 and PROT-002 for the state root specification.
 */
contract SequencerAnchor {
    // slot -> cumulative state root
    mapping(uint256 => bytes32) public batches;
    
    // For MVP, we allow an owner or a registered set of operators to submit.
    // In production, this would verify the VRF proof and proposer score on-chain.
    address public owner;

    /**
     * @dev Emitted when a batch with transactions is anchored.
     * @param slot The slot number.
     * @param stateRoot The cumulative state root (chains all prior batch roots).
     * @param txCount Number of transactions in this batch.
     */
    event BatchSubmitted(uint256 indexed slot, bytes32 stateRoot, uint256 txCount);

    /**
     * @dev Emitted when an empty batch (no transactions) is anchored.
     * @param slot The slot number.
     * @param stateRoot The cumulative state root (still advances even for empty batches).
     */
    event SlotEmpty(uint256 indexed slot, bytes32 stateRoot);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can submit");
        _;
    }

    /**
     * @dev Submit a batch commitment for a given slot.
     * @param slot The slot number.
     * @param stateRoot The cumulative state root.
     * @param txCount The number of transactions in this batch (0 for empty batches).
     */
    function submitBatch(uint256 slot, bytes32 stateRoot, uint256 txCount) external onlyOwner {
        require(batches[slot] == bytes32(0), "Slot already anchored");
        
        batches[slot] = stateRoot;
        
        if (txCount == 0) {
            emit SlotEmpty(slot, stateRoot);
        } else {
            emit BatchSubmitted(slot, stateRoot, txCount);
        }
    }

    /**
     * @dev Retrieves the anchored state root for a specific slot.
     */
    function getStateRoot(uint256 slot) external view returns (bytes32) {
        return batches[slot];
    }

    /**
     * @dev Legacy alias for getStateRoot (backward compatibility).
     */
    function getBatchRoot(uint256 slot) external view returns (bytes32) {
        return batches[slot];
    }
}
