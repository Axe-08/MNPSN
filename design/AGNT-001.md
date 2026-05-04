# AGNT-001: Agent Execution Plan

## GLOBAL RULES
1. **No Invented Behavior**: Never alter, skip, or append custom protocol rules. Implement specifications exactly as outlined in `ARCH-001`, `PROT-001`, and `CONS-001`.
2. **Determinism Guaranteed**: Ensure all sorting algorithms use lexicographical stability. Use fixed serialization when processing objects into string formats for hashing.
3. **Reproducible Logs**: All test traces and outputs must provide deterministic state replay capabilities.
4. **VRF Key Safety**: Never log, broadcast, or expose VRF secret keys. Only public keys are shared via `nodes.json`.

---

## Phase 1: Network Layer

### Task N1: libp2p Gossip Network
* **Objective**: Establish the P2P networking transport layer using libp2p pubsub.
* **Deliverables**:
  * Functional `NetworkNode` class with peer auto-discovery capability.
  * Integration with four independent GossipSub topics:
    * `/tx`: broadcasting and receiving mempool transactions.
    * `/batch`: broadcasting and receiving candidate slot proposals.
    * `/mempool-digest`: broadcasting and receiving SYNC phase digests.
    * `/mempool-sync`: broadcasting and receiving full mempool state during emergency resync.
* **Acceptance Criteria**:
  * 3 independent node instances launched locally automatically connect via loopback.
  * Message propagation across the network is confirmed under 500ms.
  * All 4 gossip topics are functional and messages are correctly routed.

---

## Phase 2: Slot Engine

### Task S1: Slot State Manager
* **Objective**: Track and enforce slot timings and local state changes.
* **Deliverables**:
  * Implementation of the `SlotManager` interface matching `IMPL-001 §3`.
  * Support for 5 phases: `COLLECT → FREEZE → SYNC → PROPOSE → FINALIZE`.
  * Support for dynamic parameter adjustments: slot duration $\Delta$ and cutoff buffer $\epsilon$.
  * Support for dynamic effective slot duration (extended during skip recovery per PROT-001 §8).
* **Acceptance Criteria**:
  * Synchronized slot transitions across isolated local instances within $\pm 50\text{ms}$ clock drift.
  * Verification that local nodes correctly execute the full 5-phase sequence.
  * Effective slot duration doubles on each consecutive skip and resets on success.

---

## Phase 3: Mempool

### Task M1: Slot-Indexed Mempool
* **Objective**: Store, deduplicate, and expire transactions across designated slots.
* **Deliverables**:
  * Implementation of the `Mempool` interface matching `IMPL-001 §3`.
  * Explicit application of transaction assignment and cutoff threshold rules (`PROT-001 §3`).
  * `carryForward(txs, toSlot)` method for re-assigning excluded or skipped transactions.
* **Acceptance Criteria**:
  * Zero transaction duplication: duplicate hashes are rejected or ignored.
  * Transactions submitted after the freeze point are systematically routed to the next slot bucket.
  * Carry-forward transactions appear in the target slot's mempool and are available for SYNC.

---

## Phase 4: VRF Provider

### Task V1: ECVRF Key Management & Proof Generation
* **Objective**: Implement VRF proof generation, verification, and slot seed computation.
* **Deliverables**:
  * Implementation of the `VRFProvider` interface matching `IMPL-001 §3`.
  * Deterministic ECDSA (RFC6979) over `secp256k1` via `@noble/curves`.
  * Slot seed computation: $\text{seed}_t = H(\text{prev\_root} \| \text{slot\_id})$.
  * Integration with `nodes.json` for public key loading.
* **Reference**: `PROT-001 §4`.
* **Acceptance Criteria**:
  * `prove(sk, seed)` produces deterministic (output, proof) pairs.
  * `verify(pk, seed, output, proof)` returns `true` for valid proofs and `false` for tampered data.
  * Different secret keys produce different outputs for the same seed.

---

## Phase 5: Mempool Synchronization

### Task Y1: SYNC Phase Digest Exchange
* **Objective**: Exchange mempool digests with peers and compute the common transaction subset.
* **Deliverables**:
  * Implementation of the `SyncManager` interface matching `IMPL-001 §3`.
  * Sorted hash set digest format: `{ slot, nodeId, digest: keccak256(JSON.stringify(sortedHashes)), hashes: sortedHashes }`.
  * Common subset computation using simple majority threshold: $\lceil n/2 \rceil + 1$.
  * Excluded transaction identification and carry-forward trigger.
* **Reference**: `PROT-001 §9`.
* **Acceptance Criteria**:
  * All honest nodes compute identical common subsets given identical digest inputs.
  * Transactions not meeting the majority threshold are correctly excluded.
  * Excluded transactions are fed to `mempool.carryForward()`.

---

## Phase 6: Ordering Engine

### Task O1: Deterministic Sorting Algorithm
* **Objective**: Sort a common subset into an ordered transaction list using VRF randomness.
* **Deliverables**:
  * Implementation of the `OrderingEngine` interface matching `IMPL-001 §3`.
  * Execution of the seed-based sorting algorithm defined in `PROT-001 §5`.
* **Reference**: `PROT-001 §5`.
* **Acceptance Criteria**:
  * Given identical inputs (transaction list and VRF output), every honest node computes matching outputs.

---

## Phase 7: Proposer Engine

### Task P1: Score Generation
* **Objective**: Calculate individual node proposal scores from VRF outputs.
* **Deliverables**:
  * Implementation of the `ProposerEngine` interface matching `IMPL-001 §3`.
  * Score is the VRF output interpreted as a 256-bit unsigned integer (BigInt).
* **Reference**: `CONS-001 §2`.
* **Acceptance Criteria**:
  * All valid nodes compute exactly matching scores for a given VRF output.

---

## Phase 8: Batch Builder

### Task B1: Batch & Merkle Root Construction
* **Objective**: Build the canonical proposal batch object for the active slot.
* **Deliverables**:
  * Assembly of the `Batch` data structure matching `IMPL-001 §3`, including VRF fields.
  * Merkle root calculation engine matching `PROT-001 §7`.
  * Null batch sentinel construction for skipped slots.
* **Acceptance Criteria**:
  * Computed Merkle roots match across all identical transaction sets.
  * Null batches use `EMPTY_MERKLE_ROOT` constant.

---

## Phase 9: Fork Choice Rule

### Task F1: Proposal Selection Logic
* **Objective**: Select a single winning proposal at the conclusion of each slot, or record a null batch.
* **Deliverables**:
  * Implementation of the `ForkChoice` interface matching `IMPL-001 §3`.
  * VRF-score-based selection with lexicographic proposer-ID tie-breaking per `CONS-001 §4`.
  * Returns `null` when no valid proposals exist.
* **Acceptance Criteria**:
  * Nodes achieve deterministic convergence on a matching proposal under standard networking conditions.
  * Returns `null` correctly when the valid proposal set is empty.

---

## Phase 10: Skip Handler

### Task K1: Empty Slot Recovery
* **Objective**: Manage null batch recording, transaction carry-forward, skip counting, and circuit breaker logic.
* **Deliverables**:
  * Implementation of the `SkipHandler` interface matching `IMPL-001 §3`.
  * Exponential slot duration extension: $\text{effectiveΔ} = \min(\Delta \times 2^{\text{skips}}, 4\Delta)$.
  * Emergency resync trigger after `MAX_CONSECUTIVE_SKIPS = 3`.
  * `getPrevRoot()` with fallback chain to last successful batch.
* **Reference**: `PROT-001 §8`.
* **Acceptance Criteria**:
  * Consecutive skips correctly extend effective slot duration.
  * Emergency resync is triggered at exactly `MAX_CONSECUTIVE_SKIPS`.
  * `getPrevRoot()` never returns `EMPTY_MERKLE_ROOT` when a prior successful batch exists.
  * Successful batch resets skip counter and slot duration.

---

## Phase 11: EVM Anchor Integration

### Task C1: Contract Submission
* **Objective**: Push finalized batch commitments (or skip markers) to an EVM settlement contract.
* **Deliverables**:
  * Solidity smart contract (`SequencerAnchor.sol`) with a `submitBatch(uint256 slot, bytes32 root)` function.
  * Skip marker support: `EMPTY_MERKLE_ROOT` as root signals a skipped slot.
  * Script or adapter to send transactions to a local anvil/hardhat test node or EVM RPC URL.
* **Acceptance Criteria**:
  * On-chain commitments match locally calculated Merkle roots without divergence.
  * Skipped slots are recorded on-chain with `EMPTY_MERKLE_ROOT`.

---

## Phase 12: Testing

### Task T1: End-to-End Simulation Suite
* **Objective**: Run complete test harnesses to guarantee protocol invariants under stress.
* **Deliverables**:
  * Executable simulation scripts running all 11 test cases defined in `TEST-001`.
* **Acceptance Criteria**:
  * 100% test pass rate across all simulation scenarios.
  * Deterministic replay possible for every test run.

---

## Phase 13: Structured Logging

### Task L1: Diagnostic Information Tracking
* **Objective**: Implement structured, configurable output tracing for easier monitoring.
* **Deliverables**:
  * Context-aware logging module supporting four standard tracing levels: `ERROR`, `WARN`, `INFO`, `DEBUG`.
* **Acceptance Criteria**:
  * Verbosity can be set dynamically via the `LOG_LEVEL` environment variable.
  * Every emitted line contains the local `node_id` and active `slot` identifier.
  * Phase transitions (COLLECT, FREEZE, SYNC, PROPOSE, FINALIZE) are logged at `INFO` level.
  * Skip events and circuit breaker activations are logged at `WARN` level.
  * VRF secret keys are NEVER logged at any level.
