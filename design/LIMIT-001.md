# LIMIT-001: Known Limitations & Post-MVP Roadmap

## 1. Known Limitations (MVP)

The following are inherent constraints of the current design that are accepted for the MVP scope. Each limitation includes its risk severity, impact description, and the planned post-MVP mitigation.

---

### L1 — No Sybil Resistance

| Severity | Impact Area |
|:---|:---|
| **Critical (post-MVP)** | Network integrity |

**Description**: The proposer set is defined statically in `nodes.json`. Any party with access to the network configuration can add arbitrary nodes. There is no staking, bonding, or identity verification mechanism.

**Impact**: An attacker can spin up $k$ nodes, each with a valid VRF key pair registered in the config, and increase their probability of winning the fork choice rule to $k / (k + n)$ where $n$ is the honest node count.

**Current Mitigation**: Trusted operator model — only authorized parties modify `nodes.json`.

---

### L2 — No Censorship Resistance

| Severity | Impact Area |
|:---|:---|
| **High** | Transaction inclusion fairness |

**Description**: The winning proposer has full discretion over which transactions appear in the batch, subject only to the common subset constraint. While the common subset forces inclusion of majority-seen transactions, a colluding majority of nodes could exclude specific transactions from their mempools to prevent them from reaching the majority threshold.

**Impact**: A censored transaction may never reach the common subset if enough nodes refuse to gossip it.

**Current Mitigation**: None. Assumes honest majority behavior.

---

### L3 — No BFT Finality

| Severity | Impact Area |
|:---|:---|
| **Medium** | Settlement guarantees |

**Description**: The system achieves soft consensus via deterministic convergence. There is no explicit finality vote, no commit certificates, and no slashing for equivocation. Finality is inherited only when the batch root is anchored to the EVM settlement layer.

**Impact**: Until the L1 anchor transaction confirms, the batch ordering is theoretically reversible if a network partition heals and reveals a lower-scoring proposal.

**Current Mitigation**: Rapid L1 anchoring minimizes the window of reversibility.

---

### L4 — Predictable Proposer Identity

| Severity | Impact Area |
|:---|:---|
| **Medium** | DOS resistance |

**Description**: While VRF outputs are unpredictable, the proposer scoring mechanism reveals the winner at PROPOSE time. After the VRF proof is broadcast, all peers can determine who the winning proposer is. This is inherent to the design.

**Impact**: A targeted DOS attacker who observes the VRF scores could attempt to suppress the winning proposer's batch during the FINALIZE window. However, since the PROPOSE → FINALIZE window is only 500ms, this is difficult to exploit in practice.

**Current Mitigation**: Short FINALIZE window limits attacker reaction time.

---

### L5 — In-Memory State Only

| Severity | Impact Area |
|:---|:---|
| **High** | Durability, crash recovery |

**Description**: All state (mempool, batch history, skip counters) is held in-memory. A node crash results in complete state loss.

**Impact**: A crashed node cannot resume from its previous state. It must re-sync the full batch history from peers and rebuild its mempool from the gossip stream.

**Current Mitigation**: None. Nodes restart from scratch.

---

### L6 — Fixed Gossip Topology

| Severity | Impact Area |
|:---|:---|
| **Low** | Scalability |

**Description**: All gossip topics are full-mesh pubsub. Every message is propagated to every peer. With $n$ nodes and $m$ transactions per slot, network bandwidth is $O(n \times m)$ per slot for `/tx` and $O(n^2)$ for digest exchange.

**Impact**: The system performs well for 3–10 nodes. Beyond ~20 nodes, gossip bandwidth becomes a bottleneck, particularly during the SYNC phase.

**Current Mitigation**: MVP targets 3–5 nodes.

---

### L7 — NTP Dependency

| Severity | Impact Area |
|:---|:---|
| **Medium** | Clock synchronization |

**Description**: The protocol requires $\delta \le 50\text{ms}$ clock drift across all nodes. This is enforced solely by each node's local NTP configuration. There is no protocol-level clock consensus or drift detection mechanism.

**Impact**: If a node's NTP source becomes unreliable (e.g., network firewall blocks NTP, or NTP server returns stale data), the node may silently drift out of sync, causing its proposals to arrive in wrong phases and its SYNC digests to cover wrong time windows.

**Current Mitigation**: NTP validation check at node startup. No runtime monitoring.

---

### L8 — No Transaction Fee Model

| Severity | Impact Area |
|:---|:---|
| **Low (MVP)** | Spam prevention, economic sustainability |

**Description**: There is no gas pricing, fee market, or economic cost to submitting transactions. The mempool accepts any well-formed transaction regardless of economic value.

**Impact**: The system is vulnerable to mempool flooding — an attacker can submit millions of zero-value transactions to bloat the common subset and slow ordering.

**Current Mitigation**: None. Assumes honest usage patterns.

---

### L9 — SYNC Phase Adds Latency

| Severity | Impact Area |
|:---|:---|
| **Low** | Slot throughput |

**Description**: The SYNC phase consumes the $\epsilon = 1000\text{ms}$ cutoff buffer window. This means the effective COLLECT window is $\Delta - \epsilon = 4000\text{ms}$ out of a $5000\text{ms}$ slot, reducing the time available for transaction ingestion by 20%.

**Impact**: Under high transaction load, the shortened COLLECT window may cause more transactions to spill into the next slot.

**Current Mitigation**: Acceptable for MVP throughput targets.

---

### L10 — No Batch Compression

| Severity | Impact Area |
|:---|:---|
| **Low** | Bandwidth efficiency |

**Description**: Proposals on the `/batch` topic include full transaction objects. Since all honest nodes already have these transactions in their mempool (they passed the SYNC phase), only the tx hash list + ordering + Merkle root would be necessary.

**Impact**: Unnecessary bandwidth usage, proportional to transaction payload size.

**Current Mitigation**: None. Full transaction objects are sent.

---

## 2. Post-MVP Upgrade Roadmap

The following features are planned for future iterations, ordered by priority.

---

### Tier 1 — Security Hardening (Critical Path)

#### U1 — On-Chain VRF Key Registry
**Replaces**: Static `nodes.json` configuration.
**Design**: Deploy a `NodeRegistry.sol` contract where nodes register their VRF public keys by submitting a staking deposit. The contract enforces:
* Minimum stake threshold for proposer eligibility.
* Slashing conditions for equivocation (submitting two different batches for the same slot).
* Graceful exit with unbonding period.

**Impact**: Enables Sybil resistance and economic security.

#### U2 — Encrypted Mempool (Threshold Decryption)
**Replaces**: Plaintext transaction gossip.
**Design**: Transactions are encrypted with a shared threshold public key before entering the gossip layer. The common subset is computed over encrypted transaction hashes. Decryption occurs only after the SYNC phase completes, using threshold decryption shares from $\ge 2n/3$ nodes.

**Impact**: Eliminates MEV extraction even for the winning proposer, since transaction contents are unknown during ordering.

#### U3 — Inclusion Lists
**Replaces**: The current "propose what's in the common subset" model.
**Design**: Nodes submit signed inclusion list attestations during SYNC, declaring which transactions they believe must be included. A transaction on $\ge f+1$ inclusion lists (where $f$ is the maximum Byzantine count) must appear in the winning batch.

**Impact**: Provides censorship resistance against colluding proposer majorities.

---

### Tier 2 — Reliability & Durability

#### U4 — Persistent State Store
**Replaces**: In-memory-only state.
**Design**: Implement a lightweight WAL (Write-Ahead Log) or embedded database (e.g., LevelDB, SQLite) for:
* Batch history (for chain sync and partition recovery).
* Mempool state (for crash recovery).
* Skip counter and configuration state.

**Impact**: Nodes can resume from crashes without full re-sync.

#### U5 — Chain Sync Protocol
**Replaces**: The under-specified "exchange historic batch chains" from CONS-001 §6 F3.
**Design**: Formal request-response protocol:
1. On reconnection, node sends `SyncRequest { latestSlot, latestRoot }`.
2. Peer responds with `SyncResponse { batches: Batch[] }` covering the gap.
3. Receiving node validates each batch's VRF proof and Merkle root, then applies the fork choice rule across the full history.

**Impact**: Enables reliable partition recovery and new-node bootstrapping.

#### U6 — Runtime Clock Drift Detection
**Replaces**: Startup-only NTP check.
**Design**: Periodic (every 10 slots) NTP validation. If drift exceeds $\delta$:
1. Node logs a `WARN` and enters observation mode (receives but does not propose).
2. After clock re-sync, node re-enters normal operation.

**Impact**: Prevents silent clock drift from corrupting proposals.

---

### Tier 3 — Performance & Scalability

#### U7 — Proposal Compression
**Replaces**: Full-transaction gossip on `/batch`.
**Design**: Proposals contain only:
* Sorted list of tx hashes (not full tx objects).
* Merkle root.
* VRF proof and metadata.

Receiving nodes reconstruct the full batch from their local mempool using the tx hash ordering.

**Impact**: Reduces `/batch` bandwidth by ~95% for typical payloads.

#### U8 — Sharded Gossip
**Replaces**: Full-mesh pubsub.
**Design**: Partition gossip topics by transaction prefix (e.g., first 2 bytes of tx hash). Nodes subscribe to a subset of shards and relay across shard boundaries.

**Impact**: Reduces per-node bandwidth from $O(n \times m)$ to $O(m / s)$ where $s$ is the shard count.

#### U9 — Parallel Slot Processing
**Replaces**: Sequential slot execution.
**Design**: Allow COLLECT for slot $t+1$ to overlap with FINALIZE for slot $t$. This requires careful mempool isolation but enables higher throughput.

**Impact**: Increases effective slot throughput by ~30%.

---

### Tier 4 — Advanced Features

#### U10 — Median Timestamp Tie-Breaking
**Design**: Within the deterministic ordering, use median arrival timestamps (collected during SYNC) as a secondary sort key after the VRF-based primary key. For each transaction, peers report their local arrival timestamp. The median of these reports is used.

**Impact**: Provides a fairness signal — transactions seen earlier by the network tend to be ordered earlier, subject to the VRF shuffle.

#### U11 — Multi-Rollup Sequencing
**Design**: Extend the batch structure to support multiple rollup namespaces. Each namespace has its own mempool partition and ordering, but shares the same slot clock, SYNC phase, and fork choice.

**Impact**: Positions the network as a shared sequencer for multiple rollup instances.

#### U12 — Proof of Sequencing
**Design**: Generate a zero-knowledge proof attesting that the batch ordering was computed correctly from the common subset using the VRF output. This proof is submitted alongside the batch root to the EVM anchor contract.

**Impact**: Allows on-chain verification of correct sequencing without replaying the full computation.

---

## 3. Limitation ↔ Upgrade Mapping

| Limitation | Resolved By | Tier |
|:---|:---|:---|
| L1 — No Sybil Resistance | U1 — On-Chain VRF Registry | Tier 1 |
| L2 — No Censorship Resistance | U2 — Encrypted Mempool, U3 — Inclusion Lists | Tier 1 |
| L3 — No BFT Finality | (Inherited from L1 settlement) | — |
| L4 — Predictable Proposer Identity | U2 — Encrypted Mempool | Tier 1 |
| L5 — In-Memory State | U4 — Persistent State Store | Tier 2 |
| L6 — Fixed Gossip Topology | U8 — Sharded Gossip | Tier 3 |
| L7 — NTP Dependency | U6 — Runtime Clock Drift Detection | Tier 2 |
| L8 — No Transaction Fee Model | (Requires U1 economic framework) | Tier 1 |
| L9 — SYNC Phase Latency | U9 — Parallel Slot Processing | Tier 3 |
| L10 — No Batch Compression | U7 — Proposal Compression | Tier 3 |
