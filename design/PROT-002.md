# PROT-002: Cumulative State Root — Protocol Addendum

> **Extends**: PROT-001 (Sequencing Protocol Spec)
> **Status**: Draft
> **Author**: Auto-generated
> **Date**: 2026-05-09

---

## 1. State Root Definition

The cumulative state root is a Keccak-256 hash that chains all finalized batch roots into a single running commitment. It is computed locally by each node after the FINALIZE phase and does not require any network communication.

### Formula

$$\text{stateRoot}(t) = \text{keccak256}\big(\text{stateRoot}(t-1) \;\Vert\; \text{batchRoot}(t) \;\Vert\; \text{encode}(t)\big)$$

Where:
* $\text{stateRoot}(t-1)$: The cumulative state root from the previous slot (32 bytes, hex).
* $\text{batchRoot}(t)$: The Merkle root of the current slot's transaction batch (32 bytes, hex). For null batches, this is `EMPTY_MERKLE_ROOT`.
* $\text{encode}(t)$: The slot number encoded as a 32-byte big-endian unsigned integer (left-padded with zeros).
* $\Vert$: Byte-level concatenation (not string concatenation).

### Genesis State Root

For the first slot ($t = 0$), the previous state root is the 32-byte zero value:

$$\text{stateRoot}(-1) = \texttt{0x0000000000000000000000000000000000000000000000000000000000000000}$$

Therefore:

$$\text{stateRoot}(0) = \text{keccak256}\big(\texttt{0x00}^{32} \;\Vert\; \text{batchRoot}(0) \;\Vert\; \text{encode}(0)\big)$$

---

## 2. Computation Procedure

### Pseudocode

```ts
function computeStateRoot(
  prevStateRoot: string,   // hex string, 32 bytes
  batchRoot: string,       // hex string, 32 bytes (EMPTY_MERKLE_ROOT for null batches)
  slot: number             // current slot number
): string {
  // Encode slot as 32-byte big-endian uint256
  const slotBytes = slot.toString(16).padStart(64, '0');

  // Strip 0x prefixes and concatenate raw bytes
  const preimage = prevStateRoot.slice(2) + batchRoot.slice(2) + slotBytes;

  // Hash the concatenation
  return keccak256('0x' + preimage);
}
```

### Example Trace

Given a 3-slot chain:

| Slot | Batch Root | State Root |
|:---|:---|:---|
| 0 | `0xabc...` (1 tx) | `keccak256(0x00..00 ∥ 0xabc... ∥ encode(0))` |
| 1 | `EMPTY_MERKLE_ROOT` (0 txs) | `keccak256(stateRoot(0) ∥ EMPTY_ROOT ∥ encode(1))` |
| 2 | `0xdef...` (3 txs) | `keccak256(stateRoot(1) ∥ 0xdef... ∥ encode(2))` |

Note that slot 1 (empty) still produces a **unique** state root because the slot number is included in the preimage.

---

## 3. Integration with Existing Protocol

### Relationship to VRF Seed (PROT-001 §4)

The VRF seed for slot $t$ continues to use the **batch root** (not the state root):

$$\text{seed}_t = H(\text{prev\_batch\_root} \;\Vert\; \text{slot\_id})$$

This is unchanged from PROT-001. The state root is a higher-level commitment that wraps the batch root chain; the VRF operates on the lower-level batch root chain.

### Relationship to Skip Protocol (PROT-001 §8)

When a slot is skipped:
* `batchRoot(t)` = `EMPTY_MERKLE_ROOT` (as before)
* `stateRoot(t)` = `keccak256(stateRoot(t-1) ∥ EMPTY_MERKLE_ROOT ∥ encode(t))`
* The `prev_root` fallback for VRF seed is unchanged (uses last non-null batch root)

### Relationship to L1 Anchor

The `submitBatch(slot, root)` call to `SequencerAnchor.sol` now passes:
* `slot`: The slot number (unchanged)
* `root`: The **cumulative state root** (changed from batch root)

---

## 4. State Root Storage

Each node maintains an in-memory map of state roots indexed by slot:

```ts
private stateRootHistory: Map<number, string> = new Map();
```

### Persistence
* The latest state root is persisted implicitly via L1 anchoring.
* On node restart with `RESUME_SLOT`, the node can reconstruct the state root by replaying from the last L1-anchored root.

### Pruning
* State roots older than `PRUNING_WINDOW` slots (default: 1000) may be evicted from memory.
* The latest state root must always be retained.

---

## 5. Verification Algorithm

An external verifier can validate the entire chain by:

1. Fetch all `(slot, stateRoot)` pairs from the L1 contract events.
2. Fetch all batch roots from the sequencer network (or L1 events).
3. Starting from `stateRoot(-1) = 0x00...00`, recompute each state root:
   ```
   for slot = 0 to latest:
     expected = keccak256(prevStateRoot ∥ batchRoot(slot) ∥ encode(slot))
     assert expected == anchored_stateRoot(slot)
     prevStateRoot = expected
   ```
4. Any mismatch proves tampering or data corruption.

---

## 6. Security Considerations

### Collision Resistance

The preimage includes three distinct fields of fixed length (32 + 32 + 32 = 96 bytes). There is no ambiguity in field boundaries, so second-preimage attacks are not applicable.

### Slot Number Inclusion

Including the slot number in the hash preimage prevents:
* **Replay attacks**: The same batch root in different slots produces different state roots.
* **Empty slot ambiguity**: Consecutive empty slots produce distinct state roots.
* **Reordering attacks**: Swapping two batches between slots changes both state roots.
