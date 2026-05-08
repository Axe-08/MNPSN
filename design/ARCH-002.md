# ARCH-002: Cumulative State Root — Architecture Addendum

> **Extends**: ARCH-001 (System Architecture Spec)
> **Status**: Draft
> **Author**: Auto-generated
> **Date**: 2026-05-09

---

## 1. Motivation

In ARCH-001, each finalized batch produces an independent Merkle root over its transaction set. This root is anchored to L1 but does not encode any relationship to prior batches. Consequently:

* **Verification is slot-local**: A verifier can confirm a single batch's integrity but cannot prove the ordering history of the entire chain without replaying every batch independently.
* **State continuity is implicit**: The VRF seed chain (§4 of PROT-001) implicitly links batches via `prev_root`, but this chain is internal to the protocol and not exposed as a first-class commitment.
* **Empty slots break the chain visually**: Null batches always produce `EMPTY_MERKLE_ROOT`, making it impossible to distinguish "10 consecutive empty slots" from "1 empty slot" by inspecting a single root.

---

## 2. Design Goal

Introduce a **cumulative state root** that chains every finalized batch into a single, running hash commitment. The latest state root encodes the entire history of the sequencer network — a verifier need only check this single value against L1 to confirm all prior state transitions.

### Properties

| Property | Description |
|:---|:---|
| **History Binding** | Each state root commits to every prior batch root in the chain. |
| **Slot Monotonicity** | State roots are strictly ordered by slot number; no reordering is possible. |
| **Empty Slot Continuity** | Empty slots produce a new state root that differs from the previous one (encoding the slot number), preventing ambiguity. |
| **L1 Verifiability** | The on-chain `SequencerAnchor` contract stores the latest state root, not the batch root. Any observer can verify the full chain by replaying batch roots and recomputing the cumulative hash. |

---

## 3. Updated Core Pipeline

The pipeline from ARCH-001 §1 is amended as follows:

```
COLLECT → FREEZE → SYNC → PROPOSE → FINALIZE → COMMIT → POST
                                                   ↑ NEW
```

### COMMIT Phase (New)

After FINALIZE selects a winning batch (or records a null batch), the node computes the new cumulative state root:

$$\text{stateRoot}(t) = H\big(\text{stateRoot}(t-1) \;\Vert\; \text{batchRoot}(t) \;\Vert\; \text{slot}(t)\big)$$

This phase is instantaneous (no network communication) and occurs within the FINALIZE handler, before L1 anchoring.

---

## 4. Updated Safety Property

### S5 — Cumulative State Integrity (New)

The state root at slot $t$ deterministically commits to the entire batch history from genesis through slot $t$:

$$\text{stateRoot}(t) = H\big(\text{stateRoot}(t-1) \;\Vert\; \text{batchRoot}(t) \;\Vert\; t\big)$$

$$\text{stateRoot}(0) = H\big(\texttt{0x00}^{32} \;\Vert\; \text{batchRoot}(0) \;\Vert\; 0\big)$$

Any divergence in a single batch root at any historical slot will produce a completely different state root at slot $t$, making tampering immediately detectable.

---

## 5. Updated L1 Anchor Semantics

Previously, the L1 anchor contract received individual `batchRoot` values. With this change:

| Field | Before (001) | After (002) |
|:---|:---|:---|
| `submitBatch(slot, root)` | `root` = batch Merkle root | `root` = cumulative state root |
| Verification | Proves a single batch | Proves the entire chain up to this slot |
| Empty slot marker | `EMPTY_MERKLE_ROOT` constant | Unique hash per empty slot (encodes slot number) |

---

## 6. Impact Analysis

### Components Modified

| Component | Change |
|:---|:---|
| `NodeDaemon` | Compute and store `stateRoot` after FINALIZE, pass to anchor |
| `AnchorClient` | Submit `stateRoot` instead of `batchRoot` |
| `SequencerAnchor.sol` | No contract change needed (already accepts a `bytes32 root`) |
| `SkipHandler` | `getPrevRoot()` continues to use **batch root** for VRF seed (unchanged) |

### Components Unchanged

| Component | Reason |
|:---|:---|
| `SlotManager` | Phase boundaries unchanged |
| `Mempool` | Transaction handling unchanged |
| `SyncManager` | Digest/common subset logic unchanged |
| `VRFProvider` | VRF seed uses `prev_root` (batch root), not state root |
| `OrderingEngine` | Ordering logic unchanged |
| `ForkChoice` | Selection logic unchanged |
| `BatchBuilder` | Batch construction unchanged; `batch.root` remains the batch Merkle root |

> **Critical distinction**: The VRF seed chain continues to use `batch.root` (per PROT-001 §4). The cumulative `stateRoot` is a separate, higher-level commitment used exclusively for L1 anchoring.
