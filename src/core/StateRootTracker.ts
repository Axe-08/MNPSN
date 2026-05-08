import { keccak256 } from "viem";
import { logger } from "../utils/logger.js";

const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * StateRootTracker computes and stores cumulative state roots.
 *
 * Each state root chains the previous state root with the current batch root
 * and slot number, forming a Merkle-like chain where the latest root commits
 * to the entire history.
 *
 * Formula: stateRoot(t) = keccak256(stateRoot(t-1) ‖ batchRoot(t) ‖ encode(t))
 *
 * See PROT-002 for the full specification.
 */
export class StateRootTracker {
  private latestStateRoot: string = ZERO_ROOT;
  private latestSlot: number = -1;
  private history: Map<number, string> = new Map();

  /**
   * Compute and store the cumulative state root for a slot.
   *
   * @param slot      - The current slot number
   * @param batchRoot - Merkle root of the batch (EMPTY_MERKLE_ROOT for null batches)
   * @returns The new cumulative state root (hex string)
   */
  computeStateRoot(slot: number, batchRoot: string): string {
    // Encode slot as 32-byte big-endian uint256
    const slotHex = ("0x" +
      slot.toString(16).padStart(64, "0")) as `0x${string}`;

    // Concatenate: prevStateRoot (32 bytes) ‖ batchRoot (32 bytes) ‖ slot (32 bytes)
    const preimage = (this.latestStateRoot.slice(2) +
      batchRoot.slice(2) +
      slotHex.slice(2)) as `0x${string}`;

    const stateRoot = keccak256(`0x${preimage}`);

    this.latestStateRoot = stateRoot;
    this.latestSlot = slot;
    this.history.set(slot, stateRoot);

    logger.info(
      `State root for slot ${slot}: ${stateRoot} (batchRoot: ${batchRoot})`,
    );

    return stateRoot;
  }

  /** Get the latest computed state root. Returns zero hash if no slots processed. */
  getLatestStateRoot(): string {
    return this.latestStateRoot;
  }

  /** Get the slot number of the latest computed state root. Returns -1 if none. */
  getLatestSlot(): number {
    return this.latestSlot;
  }

  /** Get the state root for a specific slot, if computed. */
  getStateRoot(slot: number): string | undefined {
    return this.history.get(slot);
  }
}
