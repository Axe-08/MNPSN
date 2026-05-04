# IMPL-001: Code Architecture Spec

## 1. System Boundaries

* **Language**: Node.js (ESM, Node 20+)
* **Networking**: `@libp2p/pubsub` or equivalent p2p pubsub module for gossip communication
* **VRF**: Deterministic ECDSA (RFC6979) over `secp256k1` from `@noble/curves`
* **Crypto/Hashing**: standard `keccak256` from `viem` or `ethers` for cross-platform matching
* **State Management**: In-memory data structures, indexed maps, and structured caches

---

## 2. Module Graph

The application separates concerns cleanly into distinct, testable modules.

```text
                                [ Entry Point ]
                                       │
                                ┌──────┴──────┐
                                ▼             ▼
                            [Network]   [SlotManager]
                                │             │
                                └──────┬──────┘
                                       ▼
                                   [Mempool]
                                       │
                                       ▼
                                 [SyncManager]  ←── NEW: digest exchange + common subset
                                       │
                ┌──────────────┬───────┴──────┬──────────────┐
                ▼              ▼              ▼              ▼
          [VRFProvider]  [OrderingEngine] [ProposerEngine] [ForkChoice]
                │              │              │              │
                └──────────────┼──────────────┴──────────────┘
                               ▼
                        [BatchBuilder]
                               │
                               ▼
                        [SkipHandler]   ←── NEW: null batch + carry-forward
```

---

## 3. Core Interfaces

To ensure precise testing and multi-agent implementation safety, use the following exact TypeScript interfaces.

### Types & Data Structures

```ts
export interface Tx {
  hash: string;       // Keccak256 of the raw payload
  sender: string;     // Hexadecimal string of sender address
  nonce: number;      // Monotonically increasing counter per sender
  payload: string;    // Arbitrary data / payload bytes as a hex string
}

export interface Batch {
  slot: number;
  proposer: string;
  randomness: string;     // VRF output (hex string)
  vrfProof: string;       // VRF proof for verification (hex string)
  publicKey: string;      // Proposer's VRF public key (hex string)
  txs: Tx[];
  root: string;
}

export interface NodeConfig {
  nodeId: string;          // libp2p peer identifier
  vrfPublicKey: string;    // ECVRF public key (hex string)
}

export interface NodesRegistry {
  nodes: NodeConfig[];
}

export const EMPTY_MERKLE_ROOT: string = "<keccak256(0x00)>";

export const NULL_BATCH = (slot: number): Batch => ({
  slot,
  proposer: "SKIP",
  randomness: "0x0",
  vrfProof: "0x0",
  publicKey: "0x0",
  txs: [],
  root: EMPTY_MERKLE_ROOT,
});
```

### Mempool Interface

```ts
export interface Mempool {
  add(tx: Tx, arrivalTime: number): boolean;
  get(slot: number): Tx[];
  snapshot(slot: number): Tx[];
  countBySender(sender: string, slot: number): number;
  evict(slot: number): void;
  carryForward(txs: Tx[], toSlot: number): void;
}
```

### Slot Manager Interface

```ts
export interface SlotManager {
  getCurrentSlot(): number;
  getPhase(): "COLLECT" | "FREEZE" | "SYNC" | "PROPOSE" | "FINALIZE";
  getSlotBoundaries(slot: number): {
    start: number;
    freeze: number;
    syncEnd: number;
    end: number;
    finalizeEnd: number;
  };
  getEffectiveSlotDuration(): number;
  start(): void;
  stop(): void;
}
```

### VRF Provider Interface

```ts
export interface VRFProvider {
  prove(secretKey: string, seed: string): { output: string; proof: string };
  verify(publicKey: string, seed: string, output: string, proof: string): boolean;
  computeSlotSeed(prevRoot: string, slotId: number): string;
}
```

### Sync Manager Interface

```ts
export interface MempoolDigest {
  slot: number;
  nodeId: string;
  digest: string;       // keccak256 of sorted hash list
  hashes: string[];     // sorted array of tx hashes
}

export interface SyncManager {
  broadcastDigest(slot: number, localTxHashes: string[]): void;
  receiveDigest(digest: MempoolDigest): void;
  computeCommonSubset(slot: number, totalNodes: number): string[];
  getExcludedTxHashes(slot: number, localTxHashes: string[]): string[];
}
```

### Ordering Engine Interface

```ts
export interface OrderingEngine {
  order(txs: Tx[], randomness: string): Tx[];
}
```

### Proposer Engine Interface

```ts
export interface ProposerEngine {
  computeScore(vrfOutput: string): bigint;
}
```

### Fork Choice Interface

```ts
export interface ForkChoice {
  select(batches: Batch[]): Batch | null;
}
```

### Skip Handler Interface

```ts
export interface SkipHandler {
  recordSkip(slot: number): void;
  getConsecutiveSkips(): number;
  getEffectiveSlotDuration(baseΔ: number): number;
  shouldTriggerEmergencyResync(): boolean;
  reset(): void;
  getPrevRoot(slot: number, batchHistory: Map<number, Batch>): string;
}
```

---

## 4. Configuration

### nodes.json (Static VRF Key Registry)

```json
{
  "nodes": [
    {
      "nodeId": "12D3KooW...",
      "vrfPublicKey": "0x04abcdef..."
    },
    {
      "nodeId": "12D3KooX...",
      "vrfPublicKey": "0x04123456..."
    },
    {
      "nodeId": "12D3KooY...",
      "vrfPublicKey": "0x04789abc..."
    }
  ]
}
```

### Environment Variables

| Variable | Default | Description |
|:---|:---|:---|
| `SLOT_DURATION` | `5000` | Slot duration Δ in milliseconds |
| `CUTOFF_BUFFER` | `1000` | Cutoff buffer ε in milliseconds |
| `LOG_LEVEL` | `INFO` | Logging verbosity (ERROR, WARN, INFO, DEBUG) |
| `VRF_SECRET_KEY` | — | Node's ECVRF secret key (hex string, required) |
| `NODES_CONFIG_PATH` | `./nodes.json` | Path to the static node registry |
| `MAX_CONSECUTIVE_SKIPS` | `3` | Skip count before emergency resync |

---

## 5. Gossip Topics

| Topic | Payload | Direction |
|:---|:---|:---|
| `/tx` | Serialized `Tx` object | Broadcast on submit, receive from peers |
| `/batch` | Serialized `Batch` object (proposal) | Broadcast on PROPOSE, receive from peers |
| `/mempool-digest` | Serialized `MempoolDigest` object | Broadcast on SYNC, receive from peers |
| `/mempool-sync` | Full mempool state (emergency only) | Broadcast/receive during emergency resync |

---

## 6. Determinism Requirements

To ensure zero divergence among honest nodes, use strict formatting and canonical representations.

### String & Byte Representation
* **JSON Serialization**: Use a canonical JSON stringify routine (`fast-json-stable-stringify` or similar) when converting objects to strings for hashing.
* **Lexicographical Stability**: JavaScript's native `Array.prototype.sort()` sorts lexicographically when strings are compared. For numeric strings or large hex addresses, explicitly provide a comparator function:
  ```ts
  function stableStringCompare(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  ```

### Hashing Safety
* Always parse hex strings correctly. For example, if passing transaction contents to the hashing module, never hash variable whitespace or string formats. All payloads should be passed as standard bytes or fixed hex representations before applying Keccak-256.

### VRF Determinism
* VRF output is deterministic for a given (secret key, seed) pair. Two nodes with different secret keys will produce different outputs for the same seed — this is expected and correct.
* All VRF outputs must be compared as 256-bit unsigned integers (BigInt) for score comparison.
