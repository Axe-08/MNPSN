# CONS-001: Soft Consensus & Fork Choice Spec

## 1. Consensus Model

The network utilizes a soft consensus model where convergence is achieved without dynamic validation phases or BFT voting rounds. Instead, it relies on:
1. **Common subset agreement** (SYNC phase) to align transaction sets before proposing.
2. **VRF-based proposer scoring** to produce unpredictable yet verifiable leader election.
3. **Deterministic fork choice** to select a single winning proposal per slot.

---

## 2. Proposal Generation

At the beginning of the `PROPOSE` phase ($t_{\text{current}} = E_t$), each node computes its proposal:

### Step 1 — VRF Score Computation
The proposer generates a VRF proof over the shared slot seed:
$$(\text{vrf\_output}_p, \text{vrf\_proof}_p) = \text{VRF.prove}(\text{sk}_p, \text{seed}_t)$$
$$\text{seed}_t = H(\text{prev\_root} \mathbin{\Vert} \text{slot\_id})$$

The proposer's score is the VRF output interpreted as a 256-bit unsigned integer:
$$\text{score}(N_p, \text{seed}_t) = \text{uint256}(\text{vrf\_output}_p)$$

### Step 2 — Batch Assembly
The proposer orders the common subset (from the completed SYNC phase) using their VRF output as the randomness seed, constructs the Merkle root, and packages the full proposal:
```ts
const proposal = {
  slot: t,
  proposer: nodeId,
  randomness: vrfOutput,
  vrfProof: vrfProof,
  publicKey: vrfPublicKey,
  txs: orderedCommonSubset,
  root: merkleRoot(orderedCommonSubset)
};
```

### Step 3 — Broadcast
The proposal is broadcast on the `/batch` gossip topic.

---

## 3. Proposal Validity

Upon receiving a proposal from the network, a node checks if the proposal is structurally and protocol-valid. A proposal $P$ for slot $t$ is valid if and only if ALL of the following conditions are met:

1. **Slot Match**: $P.\text{slot} == t$.
2. **Phase Boundary**: The proposal is received before the end of the `PROPOSE` phase ($t_{\text{arrival}} \le E_t + 500\text{ms}$).
3. **Known Proposer**: $P.\text{publicKey}$ exists in the static `nodes.json` configuration file.
4. **VRF Validity**: The VRF proof verifies correctly:
   $$\text{VRF.verify}(P.\text{publicKey}, \text{seed}_t, P.\text{randomness}, P.\text{vrfProof}) = \text{true}$$
5. **Correct Ordering**: The array $P.\text{txs}$ is exactly ordered according to the deterministic algorithm in `PROT-001 §5`, using $P.\text{randomness}$ as $r_t$.
6. **Root Validity**: The claimed Merkle root matches the transactions:
   $$P.\text{root} = \text{MerkleRoot}(P.\text{txs})$$
7. **Common Subset Match**: The transaction set in the proposal exactly matches the locally computed common subset for slot $t$:
   $$P.\text{txs\_hashes} = C_t$$
   Where $C_t$ is the common subset computed during the SYNC phase. The ordering may differ (each proposer uses their own VRF output), but the set of transaction hashes must be identical.

---

## 4. Fork Choice Rule

When transitioning from the `PROPOSE` phase to the `FINALIZE` phase, nodes select exactly one proposal from the valid set $\mathcal{P}_{\text{valid}}$.

### Selection Function
The winning proposal $P_{\text{winner}}$ is the valid proposal with the minimum VRF-derived proposer score:
$$P_{\text{winner}} = \text{argmin}_{P \in \mathcal{P}_{\text{valid}}} \left( \text{uint256}(P.\text{randomness}) \right)$$

### Tie-Breaking Rule
If two or more proposals produce identical VRF outputs (astronomically unlikely but handled for completeness), the system breaks the tie by sorting the peer identifier strings lexicographically and selecting the minimum:
$$P_{\text{winner}} = \text{argmin}_{P \in \mathcal{P}_{\text{tied}}} \left( \text{string\_compare}(P.\text{proposer}) \right)$$

### No Valid Proposals
If $\mathcal{P}_{\text{valid}}$ is empty at the end of the FINALIZE phase:
* Record a null batch sentinel per `PROT-001 §8`.
* Carry forward all common subset transactions to slot $t+1$.
* Increment the consecutive skip counter.

---

## 5. Convergence Condition

Every honest node in the network will converge on identical state if and only if:
1. **Common Subset Agreement**: All honest nodes compute the same common subset $C_t$ during the SYNC phase.
2. **Identical Valid Sets**: All honest nodes receive the same set of valid proposals during the PROPOSE phase.
3. **Sufficient Propagation**: Network propagation delay is less than the PROPOSE phase window ($500\text{ms}$).

Because the common subset is computed via majority agreement (PROT-001 §9) and the ordering is deterministic per VRF output, these conditions are significantly easier to satisfy than in the previous design which required full mempool equivalence.

---

## 6. Failure Modes

### F1 — Partial SYNC Digests
* **Symptom**: A node receives digests from fewer than $\lceil n/2 \rceil + 1$ peers during the SYNC window.
* **Impact**: The node cannot reliably compute the common subset and may produce a proposal based on a divergent tx set.
* **Mitigation**: The node falls back to its local snapshot. Its proposal will likely be rejected by peers who computed a different common subset. The slot may skip (handled by PROT-001 §8).

### F2 — Timing and Slot Drift
* **Symptom**: Local node clocks drift apart by more than $\delta > 50\text{ms}$.
* **Impact**: Nodes enter SYNC or PROPOSE at different absolute moments, causing incomplete digest collection.
* **Mitigation**: NTP sync validation at node initialization. Nodes with excessive drift are warned and should not propose.

### F3 — Network Partition
* **Symptom**: The network splits into two disjoint peer subgraphs.
* **Impact**: Partitions compute different common subsets and produce independent fork histories.
* **Mitigation**: Upon reconnection, nodes exchange historic batch chains. The fork choice rule (minimum VRF score per slot) provides a deterministic canonical chain. Nodes on the non-canonical fork discard their local history and adopt the winning chain. Transactions from discarded batches re-enter the mempool for future inclusion.

### F4 — Byzantine Proposer
* **Symptom**: A malicious node broadcasts a proposal with incorrect ordering, fabricated VRF proofs, or modified tx sets.
* **Impact**: Honest nodes reject the proposal during validity checks (§3, conditions 4–7).
* **Mitigation**: No impact on honest convergence. Byzantine proposals are silently dropped.

### F5 — Consecutive Slot Skips
* **Symptom**: Multiple consecutive slots produce no valid proposals.
* **Impact**: Transactions accumulate in carry-forward queue; slot duration extends.
* **Mitigation**: Circuit breaker triggers emergency resync after `MAX_CONSECUTIVE_SKIPS = 3` (see PROT-001 §8).
