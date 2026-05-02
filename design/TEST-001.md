# TEST-001: Verification & Simulation Spec

## 1. Determinism Test

### Objective
Verify that the ordering engine yields identical transaction sequences across any number of parallel invocations given matching initial conditions.

### Test Setup
1. Define a transaction pool containing exactly `1,000` distinct transactions with arbitrary fields.
2. Initialize 10 distinct in-memory testing instances of the `OrderingEngine`.
3. Generate a VRF output from a fixed test key pair and slot seed. Use this fixed VRF output as the randomness string.

### Execution
```ts
const fixedRandomness = VRF.prove(testSecretKey, testSeed).output;
const instances = Array.from({ length: 10 }, () => createOrderingEngine());
const outputs = instances.map(engine => engine.order(txPool, fixedRandomness));
```

### Assertions
* Every output array contains exactly the same number of elements as the input pool.
* Every output array contains identical transaction hashes in the exact same positions.
$$\forall i \in [0, 9], \text{outputs}[0] == \text{outputs}[i]$$

---

## 2. VRF Correctness Test

### Objective
Verify that VRF proof generation and verification work correctly, and that different secret keys produce different but individually verifiable outputs for the same seed.

### Test Setup
1. Generate 5 distinct ECVRF key pairs.
2. Define a shared slot seed: `seed = H(prev_root || slot_id)`.

### Execution
```ts
const keyPairs = Array.from({ length: 5 }, () => VRF.generateKeyPair());
const results = keyPairs.map(kp => ({
  output: VRF.prove(kp.secretKey, seed).output,
  proof: VRF.prove(kp.secretKey, seed).proof,
  publicKey: kp.publicKey
}));
```

### Assertions
* All 5 outputs are distinct (different keys → different outputs).
* All 5 proofs verify correctly:
$$\forall i \in [0, 4]: \text{VRF.verify}(\text{pk}_i, \text{seed}, \text{output}_i, \text{proof}_i) = \text{true}$$
* Swapping any proof/output pair with another key's data fails verification.
* The same (key, seed) pair always produces the same output (determinism).

---

## 3. Common Subset Convergence Test

### Objective
Verify that the SYNC phase correctly computes a common transaction subset via majority agreement, even when nodes have divergent mempools.

### Test Setup
1. Create 5 simulated node mempools with overlapping but non-identical transaction sets:
   * Node A: `{tx1, tx2, tx3, tx4, tx5}`
   * Node B: `{tx1, tx2, tx3, tx4, tx5}`
   * Node C: `{tx1, tx2, tx3, tx4, tx5}`
   * Node D: `{tx1, tx2, tx3, tx4}` (missed tx5)
   * Node E: `{tx1, tx2, tx3, tx4}` (missed tx5)
2. Threshold: simple majority = $\lceil 5/2 \rceil + 1 = 4$.

### Execution
* Each node computes and shares its sorted hash digest.
* Each node computes the common subset.

### Assertions
* tx5 appears in 3 digests (A, B, C) which is < threshold 4 → **excluded**.
* Common subset across all nodes: `{tx1, tx2, tx3, tx4}`.
* All 5 nodes compute identical common subsets.
$$\forall N_i, N_j: C_t^{N_i} = C_t^{N_j}$$

---

## 4. Common Subset — High Overlap Test

### Objective
Verify common subset computation under high mempool overlap with network jitter.

### Test Setup
1. 5 nodes with jittered mempools:
   * Node A: `{tx1, tx2, tx3}`
   * Node B: `{tx1, tx2, tx4}`
   * Node C: `{tx1, tx3, tx4}`
   * Node D: `{tx2, tx3, tx4}`
   * Node E: `{tx1, tx2, tx3}`
2. Threshold = 4.

### Execution
* Compute per-tx counts:
  * tx1: A, B, C, E = 4 ≥ 4 → **included**
  * tx2: A, B, D, E = 4 ≥ 4 → **included**
  * tx3: A, C, D, E = 4 ≥ 4 → **included**
  * tx4: B, C, D = 3 < 4 → **excluded**

### Assertions
* Common subset = `{tx1, tx2, tx3}`.
* tx4 is carried forward to slot $t+1$ on nodes B, C, D.
* All nodes produce identical common subsets.

---

## 5. Multi-Node Convergence (End-to-End)

### Objective
Simulate a virtual local network where transactions are received at slightly different times, verifying that honest nodes settle on matching proposals using the full pipeline (SYNC + VRF + fork choice).

### Test Setup
1. Spawn exactly `5` virtual libp2p nodes using in-memory pubsub transports.
2. Load a shared `nodes.json` with all 5 VRF public keys.
3. Direct an agent script to inject `200` unique transactions into random nodes across the network over the COLLECT phase ($t \in [0, 4000\text{ms}]$).

### Execution
* Run the node state machines concurrently for `3` consecutive slots.
* Each slot executes: COLLECT → FREEZE → SYNC → PROPOSE → FINALIZE.
* Monitor the winning batches finalized by each node.

### Assertions
* At the completion of each slot $t$, all 5 nodes have selected the exact same winning proposal:
$$\forall N_i, N_j: \text{selected\_batch}_{N_i}(t) == \text{selected\_batch}_{N_j}(t)$$
* The winning batch contains the same Merkle root across all instances.
* The winning batch's VRF proof verifies against the winner's public key.

---

## 6. MEV Simulation

### Objective
Evaluate the susceptibility of the VRF-based ordering function to frontrunning and intentional reordering.

### Test Setup
1. Define a target "victim" transaction $tx_v$ and a set of $k \in [1, 20]$ distinct "attacker" transactions $tx_{a1}, \dots, tx_{ak}$.
2. The attacker does NOT know the VRF output in advance (unlike the previous hash-based design). The attacker can only submit transactions with chosen hashes.

### Execution
* Run the ordering logic across 1,000 randomized simulations for varied values of $k$.
* For each simulation, generate a fresh VRF output from a random key.
* Record the probability of attacker precedence: $P(\text{attacker\_precedes\_victim})$.

### Assertions
* Since the VRF output is unpredictable, the attacker's success rate should match the random baseline:
$$P(\text{attacker\_precedes\_victim}) \approx \frac{k}{k + 1}$$
* Crucially, verify that the attacker **cannot improve** this probability by choosing specific transaction hashes (because the VRF output is unknown when the transaction is submitted).

---

## 7. Boundary Condition Test

### Objective
Validate that the transaction assignment rule explicitly moves transaction records to the subsequent slot once the cutoff buffer threshold is crossed.

### Test Setup
1. Define parameters: $\Delta = 5000\text{ms}, \epsilon = 1000\text{ms}$.
2. Prepare two transactions: $tx_1$ and $tx_2$.
3. Set simulated arrival timestamps:
   * $t_1 = 3999\text{ms} = \Delta - \epsilon - 1\text{ms}$
   * $t_2 = 4001\text{ms} = \Delta - \epsilon + 1\text{ms}$

### Execution
```ts
const slot1 = assignTransactionToSlot(tx1, 3999);
const slot2 = assignTransactionToSlot(tx2, 4001);
```

### Assertions
* $tx_1$ is correctly assigned to the current slot 0:
$$\text{slot}(tx_1) == 0$$
* $tx_2$ is correctly assigned to the subsequent slot 1:
$$\text{slot}(tx_2) == 1$$

---

## 8. Empty Slot (Skip) Test

### Objective
Verify that the system correctly handles slots with no valid proposals, including null batch recording, transaction carry-forward, and prev_root fallback.

### Test Setup
1. Spawn 3 virtual nodes.
2. For slot $t$, ensure no proposals are broadcast (simulate by disabling the PROPOSE phase on all nodes).

### Execution
* Slot $t$ enters FINALIZE with zero valid proposals.
* Observe slot $t+1$ behavior.

### Assertions
* All nodes record a null batch for slot $t$ with `root == EMPTY_MERKLE_ROOT`.
* Transactions from slot $t$'s common subset appear in slot $t+1$'s mempool.
* The slot seed for $t+1$ uses `prev_root(t)` (the last successful batch's root), not the null batch root.
* Consecutive skip counter increments to 1.

---

## 9. Consecutive Skip Circuit Breaker Test

### Objective
Verify that the circuit breaker activates after `MAX_CONSECUTIVE_SKIPS` and that slot duration extends correctly.

### Test Setup
1. Set `MAX_CONSECUTIVE_SKIPS = 3`, `Δ = 5000ms`.
2. Force 4 consecutive slot skips.

### Execution
* Monitor `effectiveΔ` after each skip.
* Monitor whether emergency resync is triggered.

### Assertions
* After skip 1: `effectiveΔ = 10000ms` (2× base).
* After skip 2: `effectiveΔ = 20000ms` (4× base, capped).
* After skip 3: emergency resync triggered. Nodes exchange full mempool state.
* After resync completes and a successful batch is produced: `effectiveΔ` resets to `5000ms`, `consecutiveSkips` resets to 0.

---

## 10. Partition Test

### Objective
Confirm the network's capacity to eventually merge historic chains and converge on a uniform batch sequence following the recovery of a communication split.

### Test Setup
1. Spawn 6 virtual nodes.
2. Split network connectivity exactly in half: partition $A = \{N_1, N_2, N_3\}$, partition $B = \{N_4, N_5, N_6\}$.
3. Run 2 slots under partitioned conditions; insert distinct sets of transactions into $A$ and $B$.

### Execution
* Each partition computes its own common subset (within-partition majority) and produces independent batches.
* Re-establish full connectivity across the 6 nodes.
* Trigger chain synchronization where nodes compare historic proposals.

### Assertions
* The nodes resolve the temporary fork by evaluating deterministic VRF-based fork choice over the partition history.
* The partition whose winning batch has the lower VRF score is selected as canonical.
* All 6 nodes converge on a single consistent sequence of finalized batches.
* Transactions from the discarded fork's batches re-enter the mempool for future inclusion.

---

## 11. Carry-Forward Test

### Objective
Verify that transactions excluded from the common subset in slot $t$ are correctly carried forward and included in slot $t+1$.

### Test Setup
1. 3 nodes. Threshold = $\lceil 3/2 \rceil + 1 = 3$ (all nodes must agree).
2. Node A has `{tx1, tx2, tx3}`, Node B has `{tx1, tx2}`, Node C has `{tx1, tx2}`.

### Execution
* SYNC phase: tx3 appears in 1/3 digests → excluded.
* Common subset = `{tx1, tx2}`.
* Slot $t$ finalizes with batch over `{tx1, tx2}`.

### Assertions
* Node A carries `tx3` forward to slot $t+1$.
* In slot $t+1$, after gossip propagation, `tx3` appears in all 3 node mempools.
* `tx3` is included in slot $t+1$'s common subset and finalized batch.
