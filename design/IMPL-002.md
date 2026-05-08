# IMPL-002: Cumulative State Root — Implementation Addendum

> **Extends**: IMPL-001 (Code Architecture Spec)
> **Status**: Draft
> **Author**: Auto-generated
> **Date**: 2026-05-09

---

## 1. Overview

This document specifies the implementation changes required to add cumulative state root chaining to the MNPSN codebase. The change is minimal — only the `NodeDaemon` FINALIZE handler and `AnchorClient` submission are affected.

---

## 2. New Interface

### StateRootTracker

A lightweight utility class responsible for computing and storing cumulative state roots.

```ts
export interface StateRootTracker {
  /**
   * Compute the cumulative state root for a given slot.
   *
   * @param slot       - The current slot number
   * @param batchRoot  - The Merkle root of the current batch (EMPTY_MERKLE_ROOT for null batches)
   * @returns The cumulative state root as a hex string
   */
  computeStateRoot(slot: number, batchRoot: string): string;

  /**
   * Get the latest computed state root.
   * Returns the 32-byte zero hash if no slots have been processed.
   */
  getLatestStateRoot(): string;

  /**
   * Get the state root for a specific slot, if it has been computed.
   */
  getStateRoot(slot: number): string | undefined;

  /**
   * Get the slot number of the latest computed state root.
   * Returns -1 if no slots have been processed.
   */
  getLatestSlot(): number;
}
```

---

## 3. File Changes

### 3.1 New File: `src/core/StateRootTracker.ts`

```ts
import { keccak256, encodePacked } from "viem";

const ZERO_ROOT = "0x" + "00".repeat(32);

export class StateRootTracker {
  private latestStateRoot: string = ZERO_ROOT;
  private latestSlot: number = -1;
  private history: Map<number, string> = new Map();

  /**
   * Compute and store the cumulative state root for a slot.
   *
   * Formula: stateRoot(t) = keccak256(stateRoot(t-1) ‖ batchRoot(t) ‖ encode(t))
   */
  computeStateRoot(slot: number, batchRoot: string): string {
    const slotHex = "0x" + slot.toString(16).padStart(64, "0") as `0x${string}`;

    const stateRoot = keccak256(
      encodePacked(
        ["bytes32", "bytes32", "bytes32"],
        [
          this.latestStateRoot as `0x${string}`,
          batchRoot as `0x${string}`,
          slotHex,
        ]
      )
    );

    this.latestStateRoot = stateRoot;
    this.latestSlot = slot;
    this.history.set(slot, stateRoot);

    return stateRoot;
  }

  getLatestStateRoot(): string {
    return this.latestStateRoot;
  }

  getLatestSlot(): number {
    return this.latestSlot;
  }

  getStateRoot(slot: number): string | undefined {
    return this.history.get(slot);
  }
}
```

---

### 3.2 Modified: `src/NodeDaemon.ts`

#### Constructor Changes

```diff
+ import { StateRootTracker } from "./core/StateRootTracker.js";

  export class NodeDaemon {
    // ... existing fields ...
+   private stateRootTracker: StateRootTracker;

    constructor(...) {
      // ... existing init ...
+     this.stateRootTracker = new StateRootTracker();
    }
  }
```

#### FINALIZE Phase Changes

After the winning batch is selected (or null batch is recorded), compute the state root before anchoring:

```diff
  // After selecting winner or recording null batch:
  const finalBatchRoot = winner ? winner.root : EMPTY_MERKLE_ROOT;

+ // Compute cumulative state root
+ const stateRoot = this.stateRootTracker.computeStateRoot(slot, finalBatchRoot);
+ logger.info(
+   `[${this.nodeId}] State root for slot ${slot}: ${stateRoot}`
+ );

  // L1 anchor — submit stateRoot instead of batchRoot
  if (this.anchorClient && winner?.proposer === this.nodeId) {
-   await this.anchorClient.submitBatch(slot, winner.root);
+   await this.anchorClient.submitBatch(slot, stateRoot);
  }
```

#### Null Batch Anchor Changes

For null batches, the designated node (first in `nodes.json`) anchors the state root:

```diff
  if (!winner) {
    // ... null batch handling ...
+   const stateRoot = this.stateRootTracker.computeStateRoot(slot, EMPTY_MERKLE_ROOT);

    if (this.anchorClient && this.registry.nodes[0].nodeId === this.nodeId) {
-     await this.anchorClient.submitBatch(slot, EMPTY_MERKLE_ROOT);
+     await this.anchorClient.submitBatch(slot, stateRoot);
    }
  }
```

---

### 3.3 Unchanged: `src/anchor/AnchorClient.ts`

The `AnchorClient.submitBatch(slot: number, root: string)` method signature remains identical. The only change is that the `root` parameter now receives a cumulative state root instead of a batch root. No code modification needed.

---

### 3.4 Unchanged: `contracts/SequencerAnchor.sol`

The on-chain contract already accepts a `bytes32 batchRoot` parameter. Since both the batch root and the state root are 32-byte hashes, no contract modification is required. The semantic meaning of the stored root changes from "batch commitment" to "cumulative state commitment", but this is transparent to the contract.

---

## 4. Logging

New log lines introduced:

| Level | Message | Fields |
|:---|:---|:---|
| INFO | `State root for slot {slot}: {stateRoot}` | `nodeId`, `slot`, `stateRoot`, `batchRoot` |

---

## 5. Testing Strategy

### Unit Tests: `StateRootTracker`

1. **Genesis slot**: Verify that `computeStateRoot(0, batchRoot)` produces `keccak256(ZERO_ROOT ∥ batchRoot ∥ encode(0))`.
2. **Chaining**: Verify that `computeStateRoot(1, root1)` after slot 0 produces `keccak256(stateRoot(0) ∥ root1 ∥ encode(1))`.
3. **Empty slots**: Verify that consecutive empty slots produce distinct state roots.
4. **Determinism**: Verify that two instances with the same input sequence produce identical state roots.

### Integration Tests

1. Run 3-node cluster for 10 slots with 1 transaction injected at slot 3.
2. Verify all 3 nodes compute identical state roots for every slot.
3. Verify L1 anchor receives state roots (not batch roots).

---

## 6. Migration Notes

### Breaking Change

The L1 `SequencerAnchor` contract will store state roots instead of batch roots after this change. Historical batch roots already anchored on-chain will not match the new format. For a clean deployment:

1. Deploy a fresh `SequencerAnchor` contract.
2. Set `RESUME_SLOT=0` in `.env`.
3. Update `ANCHOR_CONTRACT_ADDRESS` in `.env` with the new address.

Alternatively, if backward compatibility is required, add a separate `stateRoot` field to the contract alongside `batchRoot`.
