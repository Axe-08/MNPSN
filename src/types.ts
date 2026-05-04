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

export const EMPTY_MERKLE_ROOT: string = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"; // keccak256(0x00)

export const NULL_BATCH = (slot: number): Batch => ({
  slot,
  proposer: "SKIP",
  randomness: "0x0",
  vrfProof: "0x0",
  publicKey: "0x0",
  txs: [],
  root: EMPTY_MERKLE_ROOT,
});

export interface Mempool {
  add(tx: Tx, arrivalTime: number): boolean;
  get(slot: number): Tx[];
  snapshot(slot: number): Tx[];
  countBySender(sender: string, slot: number): number;
  evict(slot: number): void;
  carryForward(txs: Tx[], toSlot: number): void;
}

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

export interface VRFProvider {
  prove(secretKey: string, seed: string): { output: string; proof: string };
  verify(publicKey: string, seed: string, output: string, proof: string): boolean;
  computeSlotSeed(prevRoot: string, slotId: number): string;
}

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
  getExcludedTxHashes(slot: number, localTxHashes: string[], totalNodes: number): string[];
}

export interface OrderingEngine {
  order(txs: Tx[], randomness: string): Tx[];
}

export interface ProposerEngine {
  computeScore(vrfOutput: string): bigint;
}

export interface ForkChoice {
  select(batches: Batch[]): Batch | null;
}

export interface SkipHandler {
  recordSkip(slot: number): void;
  getConsecutiveSkips(): number;
  getEffectiveSlotDuration(baseΔ: number): number;
  shouldTriggerEmergencyResync(): boolean;
  reset(): void;
  getPrevRoot(slot: number, batchHistory: Map<number, Batch>): string;
}
