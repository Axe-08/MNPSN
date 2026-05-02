# ARCH-001: System Architecture Spec

## 1. System Definition

The multi-node probabilistic sequencer network is a distributed, peer-to-peer sequencing layer designed to order transactions for optimistic and valid rollup environments without requiring Byzantine Fault Tolerant (BFT) finality. The architecture guarantees deterministic, stable ordering through VRF-based randomness, common-subset mempool agreement, and a deterministic fork choice rule anchored to shared slot state.

### Core Pipeline
1. **Transaction Ingress (COLLECT)**: Clients submit transactions via the local gossip protocol or direct RPC. Transactions are indexed into the active slot's mempool bucket if received before the cutoff buffer.
2. **Mempool Seal (FREEZE)**: New arrivals for the slot are locked out; the current mempool state is sealed locally.
3. **Mempool Synchronization (SYNC)**: Nodes exchange mempool digests and compute a common transaction subset via simple majority agreement. Transactions not in the common subset carry forward to the next slot.
4. **Ordering & Scoring (PROPOSE)**: Each node generates a VRF-based randomness proof over the common subset, produces a deterministically ordered candidate batch, computes a proposer score, and gossips the proposal to the network.
5. **Soft Consensus (FINALIZE)**: The node with the minimum proposer score's batch is selected as the winning proposal. If no valid proposal exists, a null batch sentinel is recorded and transactions carry forward.
6. **L1 Anchor (POST)**: The finalized batch commitment (or skip marker) is submitted to the on-chain settlement contract.

---

## 2. Trust Model

| Component | Trust Assumption | Adversarial Action Mitigations |
| :--- | :--- | :--- |
| **Nodes** | Byzantine (untrusted) | VRF-based unpredictable ordering, common-subset agreement, deterministic fork choice with public verification. |
| **Network** | Partially synchronous | Cutoff buffer ($\epsilon$) enforces synchronized slot freeze thresholds. SYNC phase mitigates mempool divergence. |
| **Clock** | Weakly synchronized | Max clock drift ($\delta \le 50\text{ms}$) bounded via local NTP validation. |
| **Contract** | Trusted execution | Relies on the security of the underlying EVM network. |

---

## 3. Safety Properties (MVP)

The following invariants must be preserved by all honest nodes:

### S1 — Deterministic Ordering
Given an identical common transaction subset $C_t$ and an identical VRF output $r_t$, every honest node $N_i$ computes a matching transaction vector $V_t$.
$$\forall N_i, N_j \in \mathcal{H}: \text{order}(C_t, r_t)_{N_i} = \text{order}(C_t, r_t)_{N_j}$$

### S2 — Convergent Fork Choice
Given a non-partitioned network state and identical proposal propagation within a slot, nodes evaluate proposal validity deterministically and pick the winning proposal based on a deterministic VRF-score tie-breaker:
$$\text{argmin}_{p \in \mathcal{P}} \left( \text{VRF.output}(\text{sk}_p, \text{seed}_t) \right)$$

### S3 — No Retroactive Inclusion
Transactions cannot be backdated or injected into past slots. Any transaction received after the cutoff buffer for slot $t$ is explicitly moved to slot $t+1$.
$$\forall tx \in \text{Arrivals}, \text{time}(tx) > t_{\text{end}} - \epsilon \implies \text{slot}(tx) \ge t+1$$

### S4 — Common Subset Agreement
All honest nodes that complete the SYNC phase compute an identical common transaction subset for slot $t$:
$$\forall N_i, N_j \in \mathcal{H}: C_t^{N_i} = C_t^{N_j}$$

---

## 4. Liveness Properties

### L1 — Eventual Inclusion
Any valid transaction submitted to the network will be included in some future slot. Transactions excluded from the common subset in slot $t$ are automatically carried forward to slot $t+1$. Transactions in a skipped slot are also carried forward.

### L2 — Skip Recovery
If a slot produces no valid proposal, the system records a null batch sentinel and automatically advances to the next slot. Consecutive skip failures trigger exponential slot duration extension and emergency resynchronization.

---

## 5. Non-Goals (Explicit)

To maintain a lean MVP focus, the following features are out of scope for the current design iteration:
* **No Byzantine Fault Tolerant (BFT) Finality**: The network establishes soft consensus; hard finality is derived once the batch root is published to the underlying EVM layer.
* **No Sybil Resistance**: The valid set of proposer nodes is statically defined via a configuration file (`nodes.json`) for the initial MVP.
* **No Censorship Resistance Mechanisms**: The system does not incorporate threshold decryption, encrypted mempools, or inclusion lists.
* **No Timestamp-Based Ordering**: Transaction ordering is determined solely by VRF-seeded pseudorandom keys, not by arrival timestamps.
