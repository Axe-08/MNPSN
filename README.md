# MNPSN: Multi-Node Probabilistic Sequencing Network

A lightweight, local, multi-node simulation of a Threshold-based Batch Finalization Consensus Network using `libp2p` and `GossipSub`.

## Overview
MNPSN simulates a decentralized Layer 2 sequencer network that achieves consensus on mempool transactions through a Time Division Multiple Access (TDMA) slot system, threshold multi-signatures, and Verifiable Random Functions (VRF) for leader election.

Each node independently manages a mempool, builds a local digest of transactions, gossips its digest using `libp2p` GossipSub, and computes a common subset. A VRF-elected leader proposes a finalized ordered batch, and the network runs a fork-choice rule to agree on the valid root.

## Installation

```bash
npm install
```

## Running the Simulation

You can run the network in two different ways: using lightweight shell processes or fully isolated Docker containers.

### Option 1: Local Shell (Recommended for quick debugging)
Spins up 3 node processes on the host machine (`127.0.0.1`) using ports `40001`, `40002`, `40003`.
```bash
# Cleans up existing node processes and starts the simulation
./scripts/test_local.sh
```

### Option 2: Docker Compose (Recommended for isolated networking)
Spins up 3 isolated Docker containers communicating over an internal Docker bridge network (`172.28.0.0/16`) via `mDNS` peer discovery.
```bash
./scripts/start_docker.sh
```

To stop the Docker network:
```bash
docker-compose down
```

## Consensus Loop

The network operates in 5-second **Slots**, which are strictly synchronized across all nodes using a shared `GENESIS_TIMESTAMP`.

Each slot progresses through 5 strict phases:
1. **COLLECT**: Nodes listen for incoming transactions and add them to their local mempool.
2. **FREEZE**: The mempool for the current slot is frozen. No new transactions are added to this slot's bucket.
3. **SYNC**: Nodes compute a deterministic `MempoolDigest` (an array of transaction hashes) and broadcast it via the `/mempool-digest` GossipSub topic.
4. **PROPOSE**: Nodes collect all digests. If a 2/3 threshold is reached, they compute the common subset intersection. The VRF-elected leader orders the subset and publishes a `Batch` proposal.
5. **FINALIZE**: Nodes evaluate all received batch proposals. The batch with the valid VRF proof and correct Merkle root is selected, added to the `batchHistory`, and consensus is reached. If no valid batch is found, a `NULL_BATCH` is recorded.

## Project Structure

- `src/index.ts`: Application entry point and configuration parsing.
- `src/NodeDaemon.ts`: The main service orchestrator wiring together networking, mempool, and consensus.
- `src/network/index.ts`: The `libp2p` networking layer configuring Noise encryption, Yamux multiplexing, and GossipSub routing.
- `src/core/SlotManager.ts`: The phase-transition loop orchestrating TDMA synchronization.
- `src/mempool/index.ts`: The time-bucketed transaction memory pool.
- `src/sync/SyncManager.ts`: Evaluates network digests and computes the intersection subsets.
- `src/crypto/VRFProvider.ts`: Cryptographic primitives for Ed25519 signatures and sortition proofs.
- `src/consensus/index.ts`: Evaluates VRF proofs, Merkle roots, and executes the final fork-choice rule.
- `nodes.json`: The network registry containing node IDs and their public keys.

## API
Each node exposes an RPC server for transaction injection. Node 1 is bound to `8080`, Node 2 to `8081`, Node 3 to `8082`.

**Inject a Transaction:**
```bash
curl -X POST http://127.0.0.1:8080/tx \
  -H "Content-Type: application/json" \
  -d '{"sender": "0xAlice", "payload": "0x1234"}'
```
