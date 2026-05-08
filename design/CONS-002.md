# CONS-002: Cumulative State Root — Consensus Addendum

> **Extends**: CONS-001 (Soft Consensus & Fork Choice Spec)
> **Status**: Draft
> **Author**: Auto-generated
> **Date**: 2026-05-09

---

## 1. Motivation

CONS-001 defines convergent fork choice (§4) and convergence conditions (§5) for individual slot proposals. This addendum formalizes the consensus implications of the cumulative state root introduced in ARCH-002 and PROT-002.

---

## 2. Extended Convergence Condition

The convergence condition from CONS-001 §5 is extended with an additional requirement:

### C4 — State Root Agreement (New)

All honest nodes must compute the same cumulative state root for every finalized slot:

$$\forall N_i, N_j \in \mathcal{H}: \text{stateRoot}(t)_{N_i} = \text{stateRoot}(t)_{N_j}$$

This follows directly from C1–C3 (common subset agreement, identical valid sets, sufficient propagation) because:

1. If all honest nodes agree on the winning batch for slot $t$ → they agree on `batchRoot(t)`.
2. If they agreed on `stateRoot(t-1)` (inductive assumption) and agree on `batchRoot(t)` and slot number $t$ → they compute the same `stateRoot(t)`.
3. **Base case**: `stateRoot(-1) = 0x00...00` is hardcoded, so all nodes start from the same value.

### Proof (by induction)

$$\text{Base: } \text{stateRoot}(-1) = \texttt{0x00}^{32} \text{ (identical for all nodes)}$$

$$\text{Step: } \text{stateRoot}(t) = H(\text{stateRoot}(t-1) \;\Vert\; \text{batchRoot}(t) \;\Vert\; t)$$

If nodes agree on $\text{stateRoot}(t-1)$ and $\text{batchRoot}(t)$, they must agree on $\text{stateRoot}(t)$. Since $\text{batchRoot}(t)$ agreement is guaranteed by C1–C3 from CONS-001, state root agreement follows. $\square$

---

## 3. Impact on Fork Choice

The fork choice rule (CONS-001 §4) is **unchanged**. The state root is computed AFTER fork choice, not as input to it.

```
PROPOSE → ForkChoice selects winner → compute stateRoot → anchor to L1
```

The state root does not influence which proposal wins. It is a post-consensus commitment, not a consensus input.

---

## 4. Impact on Failure Modes

### F3 — Network Partition (Updated)

In CONS-001 §6.3, upon reconnection after a partition, nodes exchange historic batch chains and adopt the canonical fork. With cumulative state roots:

* The state root at the fork point will diverge between partitions.
* Upon reconnection, the canonical chain is determined by the fork choice rule per slot (same as before).
* The non-canonical partition discards its state root history and recomputes from the canonical batch chain.

### F6 — State Root Divergence (New)

* **Symptom**: Two honest nodes compute different `stateRoot(t)` for the same slot.
* **Root Cause**: This can ONLY happen if they disagree on `batchRoot(t)` (which implies a fork choice disagreement, covered by F3) or if one node missed a slot transition.
* **Detection**: Compare `stateRoot` values in L1 anchor events. If node A anchors `stateRoot_A(t)` and node B anchors `stateRoot_B(t)`, a divergence is immediately visible.
* **Recovery**: The node with the non-canonical state root replays the canonical batch history from L1 events and recomputes its state root chain.

---

## 5. Relationship to VRF Chain

The VRF seed chain and the state root chain are **parallel but independent**:

```
VRF Chain:     seed(t) = H(prev_batch_root ∥ slot_id)  →  used for ordering
State Chain:   stateRoot(t) = H(stateRoot(t-1) ∥ batchRoot(t) ∥ slot)  →  used for L1 commitment
```

| Aspect | VRF Seed | State Root |
|:---|:---|:---|
| Purpose | Unpredictable ordering randomness | Cumulative history commitment |
| Input | Last non-null batch root | Previous state root + current batch root |
| Skip handling | Falls back to last non-null root | Always chains (includes empty root) |
| Consumers | `OrderingEngine`, `ForkChoice` | `AnchorClient` (L1 submission) |
| Network exposure | Included in proposals (public) | Computed locally, anchored to L1 |
