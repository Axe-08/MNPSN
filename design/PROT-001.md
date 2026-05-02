# PROT-001: Sequencing Protocol Spec

## 1. Time Model

The system operates on continuous, discretized time intervals called slots. All calculations use millisecond-precision timestamps.

Let:
* $\Delta$: Slot duration (default: `5000ms`). May be temporarily extended during skip recovery (see §8).
* $\epsilon$: Cutoff buffer within the slot (default: `1000ms`).
* $\delta$: Maximum permissible clock drift between nodes (enforced $\le 50\text{ms}$).

### Slot Boundaries
A slot $t$ begins at Unix timestamp $S_t = t \times \Delta$ and terminates at $E_t = (t + 1) \times \Delta$.
The freeze timestamp for a slot $t$ occurs at $F_t = E_t - \epsilon$.

---

## 2. Slot State Machine

Each node transitions through the following phases per slot:

```
COLLECT [0 → Δ-ε] → FREEZE [Δ-ε] → SYNC [Δ-ε → Δ] → PROPOSE [Δ → Δ+500ms] → FINALIZE [Δ+500ms → Δ+1500ms]
```

### COLLECT Phase
* **Duration**: $[S_t, F_t)$.
* **Action**: Accept new transactions from p2p pubsub and assign them to the mempool bucket for slot $t$. Include any carry-forward transactions from skipped or excluded sets of previous slots.

### FREEZE Phase
* **Trigger**: $t_{\text{current}} = F_t = E_t - \epsilon$.
* **Action**: Seal the mempool bucket for slot $t$. Any new incoming transaction with an arrival timestamp $> F_t$ is pushed to the mempool bucket for slot $t+1$.

### SYNC Phase
* **Duration**: $[F_t, E_t)$ (occupies the cutoff buffer window $\epsilon$).
* **Action**: Exchange mempool digests with peers and compute the common transaction subset. Details in §9.

### PROPOSE Phase
* **Trigger**: $t_{\text{current}} = E_t$.
* **Action**: The node generates a VRF proof over the slot seed, orders the common subset using the VRF output, constructs a candidate batch proposal, and gossips it to the network on the `/batch` topic.

### FINALIZE Phase
* **Trigger**: $t_{\text{current}} = E_t + 500\text{ms}$.
* **Action**: Evaluate incoming valid proposals using the deterministic fork choice rule. Select exactly one winning batch. If no valid proposals exist, record a null batch sentinel (see §8) and carry transactions forward.

---

## 3. Transaction Assignment

Every incoming transaction must be immediately and immutably assigned to exactly one slot bucket upon receipt.

### Assignment Rules
```ts
function assignTransactionToSlot(tx: Transaction, arrivalTime: number): number {
  const currentSlot = Math.floor(arrivalTime / Δ);
  const slotStartTime = currentSlot * Δ;
  const cutoffTime = slotStartTime + Δ - ε;

  if (arrivalTime <= cutoffTime) {
    return currentSlot;
  } else {
    return currentSlot + 1;
  }
}
```

### Invariants
1. **No Slot Duplication**: A transaction exists in exactly one slot mempool bucket at any point in time.
2. **No Retroactive Inclusion**: A transaction cannot be assigned to a past slot ($t < t_{\text{current}}$).
3. **Carry-Forward Preservation**: Transactions excluded from a common subset or present in a skipped slot are re-assigned to slot $t+1$.

---

## 4. VRF Randomness Function

To establish a fair and verifiable ordering mechanism that is unpredictable prior to proposal broadcast, the network uses an ECVRF (Elliptic Curve Verifiable Random Function) construction.

### Slot Seed (shared, deterministic)
$$\text{seed}_t = H(\text{prev\_root} \mathbin{\Vert} \text{slot\_id})$$
where:
* $H(\cdot)$ is the standard Keccak-256 hash output as a hexadecimal string.
* $\text{prev\_root}$ is the Merkle root of the most recent non-null winning batch. For genesis slot $t=0$, or if no batch has ever been finalized, use the fixed 32-byte zero string: `0x0000000000000000000000000000000000000000000000000000000000000000`.
* $\text{slot\_id}$ is the string serialization of the current slot number.

### VRF Proof Generation (per-proposer, unpredictable)
Each proposer $p$ computes:
$$(\text{vrf\_output}_p, \text{vrf\_proof}_p) = \text{VRF.prove}(\text{sk}_p, \text{seed}_t)$$
where:
* $\text{sk}_p$ is the proposer's secret VRF key (never broadcast).
* $\text{vrf\_output}_p$ serves as the slot randomness $r_t$ for that proposer's batch.
* $\text{vrf\_proof}_p$ is the proof that allows any peer to verify the output.

### VRF Verification (by receiving nodes)
Upon receiving a proposal, nodes verify:
$$\text{VRF.verify}(\text{pk}_p, \text{seed}_t, \text{vrf\_output}_p, \text{vrf\_proof}_p) = \text{true}$$
where $\text{pk}_p$ is the proposer's public VRF key, loaded from the static `nodes.json` configuration.

### Library
Use ECVRF-P256-SHA256 from `@noble/curves` (audited, pure JS).

---

## 5. Ordering Function

To prevent transaction frontrunning and ensure identical output across nodes, the sorting relies entirely on the VRF-generated randomness.

### Key Computation
For every transaction $tx$ in the common subset:
$$\text{key}(tx) = H(\text{tx\_hash} \mathbin{\Vert} r_t)$$
where:
* $\text{tx\_hash}$ is the Keccak-256 hash of the transaction body.
* $r_t$ is the proposer's VRF output for the current slot.

### Sorting Execution
Transactions are sorted ascending based on the lexicographical comparison of the hexadecimal string representation of their keys.
$$\text{ordered\_batch} = \text{sort\_ascending}(\text{key}(tx))$$
To guarantee sorting stability, if two keys are identical, the transactions are ordered lexicographically by their raw $\text{tx\_hash}$ string.

---

## 6. Batch Construction

A batch for slot $t$ is composed of:
1. **Metadata**:
   * `slot`: Slot ID (integer)
   * `proposer`: Node Peer ID (string)
   * `randomness`: The VRF output $r_t$ (hex string)
   * `vrfProof`: The VRF proof for verification (hex string)
   * `publicKey`: The proposer's VRF public key (hex string)
2. **Body**:
   * `txs`: Sorted array of transaction objects from the common subset
3. **Commitment**:
   * `root`: Merkle Root of the transaction hashes within this batch (hex string)

### Invariants
* **Common Subset Inclusion**: The proposer must include ALL transactions in the post-SYNC common subset — no more, no less.
* **Lexicographical Stability**: Any consumer parsing the raw JSON must produce identical serialized representations.

---

## 7. Batch Hashing

The Merkle root is calculated using a standard binary Merkle tree of transaction hashes.
$$H_{tx} = \text{keccak256}(tx)$$
```text
                  Root = H(H_left || H_right)
                        /             \
            H_left = H(tx1 || tx2)   H_right = H(tx3 || tx3)
                  /         \                 |
              H(tx1)      H(tx2)            H(tx3)
```

If the number of transaction hashes is odd, the last hash is duplicated to form the next level of the tree.

For an empty transaction set (e.g., null batch), the Merkle root is the fixed constant:
$$\text{EMPTY\_MERKLE\_ROOT} = H(\text{0x00})$$

---

## 8. Empty Slot Handling (Skip Protocol)

When no valid proposal is finalized for a slot, the system must handle it gracefully.

### Null Batch Sentinel
If no valid proposal is accepted during FINALIZE, the system records:
```ts
const NULL_BATCH: Batch = {
  slot: t,
  proposer: "SKIP",
  randomness: "0x0",
  vrfProof: "0x0",
  publicKey: "0x0",
  txs: [],
  root: EMPTY_MERKLE_ROOT
};
```

### Prev Root Fallback
The randomness seed for slot $t+1$ uses the most recent non-null batch root:
```
prev_root(t+1) =
  if batch(t) is not NULL_BATCH:
    batch(t).root
  else:
    prev_root(t)    // recurse to last successful batch
```

### Transaction Carry-Forward
All transactions from the common subset of a skipped slot are automatically re-assigned to slot $t+1$:
```
On slot t skip:
  carry_forward_txs = common_subset(t)
  mempool(t+1) = mempool(t+1) ∪ carry_forward_txs
```

### Skip Counter and Circuit Breaker
To prevent cascading failures:
```ts
let consecutiveSkips = 0;
const MAX_CONSECUTIVE_SKIPS = 3;

function onSlotFinalize(slot: number, batch: Batch | null) {
  if (batch === null) {
    consecutiveSkips++;
    // Double effective slot duration on each consecutive skip (cap at 4×Δ)
    effectiveΔ = Math.min(Δ * Math.pow(2, consecutiveSkips), 4 * Δ);
    logger.warn({ slot, consecutiveSkips, effectiveΔ }, "Slot skipped");

    if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
      // Enter emergency resync: pause proposing, exchange full mempool state
      triggerEmergencyResync();
    }
  } else {
    consecutiveSkips = 0;
    effectiveΔ = Δ;  // Reset to normal slot duration
  }
}
```

### Emergency Resync Procedure
When `MAX_CONSECUTIVE_SKIPS` is reached:
1. All nodes pause normal slot progression.
2. Nodes broadcast their full mempool state on the `/mempool-sync` topic.
3. After receiving mempool state from $\ge \lceil n/2 \rceil + 1$ peers, compute the new common subset.
4. Resume slot progression with the merged mempool and reset `consecutiveSkips = 0`.

### On-Chain Skip Recording
The EVM anchor contract accepts skip markers. A batch root equal to `EMPTY_MERKLE_ROOT` signals a skipped slot.

---

## 9. Mempool Synchronization (SYNC Protocol)

During the SYNC phase, nodes exchange mempool digests and compute a common transaction subset.

### Digest Format
Each node computes and broadcasts a **sorted hash set** of its frozen mempool:
```ts
const hashes: string[] = localTxs.map(tx => tx.hash).sort();
const digest: string = keccak256(JSON.stringify(hashes));
broadcast("/mempool-digest", { slot: t, digest, hashes });
```

### Digest Collection
Nodes collect digests from peers during the SYNC window ($\epsilon = 1000\text{ms}$).

### Common Subset Computation
A transaction is included in the common subset if it appears in the digests of at least a **simple majority** of nodes:
$$tx \in C_t \iff \left| \{ N_i : tx.\text{hash} \in \text{digest}(N_i) \} \right| \ge \left\lceil \frac{n}{2} \right\rceil + 1$$

### Excluded Transaction Handling
Transactions in the local mempool but NOT in the common subset are re-assigned to slot $t+1$:
```
excluded_txs = local_snapshot(t) - common_subset(t)
mempool(t+1) = mempool(t+1) ∪ excluded_txs
```

### SYNC Failure
If fewer than $\lceil n/2 \rceil + 1$ digests are received during the SYNC window:
* The node uses its own local mempool snapshot as the proposal basis.
* This proposal may be rejected by peers who computed a different common subset.
* In the worst case, the slot is skipped and handled by §8.
