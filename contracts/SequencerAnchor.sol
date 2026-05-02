// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SequencerAnchor
 * @dev On-chain anchor for the Multi-Node Probabilistic Sequencer Network (MNPSN).
 */
contract SequencerAnchor {
    // slot -> merkle root
    mapping(uint256 => bytes32) public batches;
    
    // Constant indicating a skipped slot
    bytes32 public constant EMPTY_MERKLE_ROOT = keccak256(abi.encodePacked(uint8(0x00)));

    // For MVP, we allow an owner or a registered set of operators to submit.
    // In production, this would verify the VRF proof and proposer score on-chain.
    address public owner;

    event BatchSubmitted(uint256 indexed slot, bytes32 root);
    event SlotSkipped(uint256 indexed slot);

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
     * @param root The Merkle root of the ordered transactions.
     */
    function submitBatch(uint256 slot, bytes32 root) external onlyOwner {
        require(batches[slot] == bytes32(0), "Slot already anchored");
        
        batches[slot] = root;
        
        if (root == EMPTY_MERKLE_ROOT) {
            emit SlotSkipped(slot);
        } else {
            emit BatchSubmitted(slot, root);
        }
    }

    /**
     * @dev Retrieves the anchored root for a specific slot.
     */
    function getBatchRoot(uint256 slot) external view returns (bytes32) {
        return batches[slot];
    }
}
