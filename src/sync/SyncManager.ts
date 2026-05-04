import { SyncManager as ISyncManager, MempoolDigest } from '../types.js';
import { keccak256 } from 'viem';
import { logger } from '../utils/logger.js';
import stringify from 'fast-json-stable-stringify';

export class SyncManager implements ISyncManager {
  // slot -> nodeId -> MempoolDigest
  private receivedDigests: Map<number, Map<string, MempoolDigest>> = new Map();
  
  constructor(
    private readonly nodeId: string,
    private networkNode: { publishMempoolDigest: (d: MempoolDigest) => Promise<void> }
  ) {}

  async broadcastDigest(slot: number, localTxHashes: string[]): Promise<void> {
    const sortedHashes = [...localTxHashes].sort();
    const digestHash = keccak256(`0x${Buffer.from(stringify(sortedHashes)).toString('hex')}`);
    
    const digestObj: MempoolDigest = {
      slot,
      nodeId: this.nodeId,
      digest: digestHash,
      hashes: sortedHashes
    };

    logger.debug(`Broadcasting SYNC digest for slot ${slot} with ${sortedHashes.length} txs`);
    // Store our own digest
    this.receiveDigest(digestObj);
    
    await this.networkNode.publishMempoolDigest(digestObj);
  }

  receiveDigest(digest: MempoolDigest): void {
    if (!this.receivedDigests.has(digest.slot)) {
      this.receivedDigests.set(digest.slot, new Map());
    }
    const slotDigests = this.receivedDigests.get(digest.slot)!;
    slotDigests.set(digest.nodeId, digest);
    logger.debug(`Received digest from ${digest.nodeId} for slot ${digest.slot}`);
  }

  computeCommonSubset(slot: number, totalNodes: number): string[] {
    const slotDigests = this.receivedDigests.get(slot);
    if (!slotDigests) return [];

    const threshold = Math.floor(totalNodes / 2) + 1;
    const txCounts = new Map<string, number>();

    // Count occurrences of each tx hash across all received digests
    for (const [_, digest] of slotDigests.entries()) {
      for (const hash of digest.hashes) {
        txCounts.set(hash, (txCounts.get(hash) || 0) + 1);
      }
    }

    const commonSubset: string[] = [];
    for (const [hash, count] of txCounts.entries()) {
      if (count >= threshold) {
        commonSubset.push(hash);
      }
    }

    logger.info(`Computed common subset for slot ${slot}: ${commonSubset.length} txs (threshold: ${threshold}, total nodes: ${totalNodes}, digests received: ${slotDigests.size})`);
    return commonSubset.sort(); // Return sorted for lexicographical stability
  }

  getExcludedTxHashes(slot: number, localTxHashes: string[], totalNodes: number): string[] {
    const commonSubset = this.computeCommonSubset(slot, totalNodes);
    return this.getExcluded(localTxHashes, commonSubset);
  }

  public getExcluded(localTxHashes: string[], commonSubset: string[]): string[] {
    const commonSet = new Set(commonSubset);
    return localTxHashes.filter(h => !commonSet.has(h));
  }
  
  public clearSlot(slot: number) {
    this.receivedDigests.delete(slot);
  }
}
