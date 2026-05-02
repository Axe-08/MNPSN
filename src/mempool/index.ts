import { Mempool as IMempool, Tx } from '../types.js';
import { logger } from '../utils/logger.js';

export class Mempool implements IMempool {
  // slot -> Map<txHash, Tx>
  private buckets: Map<number, Map<string, Tx>> = new Map();

  constructor(
    private readonly baseDelta: number = 5000,
    private readonly epsilon: number = 1000,
    private readonly genesisTimestamp: number = Date.now()
  ) {}

  public assignTransactionToSlot(arrivalTime: number): number {
    const elapsed = arrivalTime - this.genesisTimestamp;
    const currentSlot = Math.max(0, Math.floor(elapsed / this.baseDelta));
    const slotStartTime = this.genesisTimestamp + (currentSlot * this.baseDelta);
    const cutoffTime = slotStartTime + this.baseDelta - this.epsilon;

    if (arrivalTime <= cutoffTime) {
      return currentSlot;
    } else {
      return currentSlot + 1;
    }
  }

  add(tx: Tx, arrivalTime: number): boolean {
    const targetSlot = this.assignTransactionToSlot(arrivalTime);
    
    if (!this.buckets.has(targetSlot)) {
      this.buckets.set(targetSlot, new Map());
    }

    const bucket = this.buckets.get(targetSlot)!;
    
    // Deduplication check
    if (bucket.has(tx.hash)) {
      return false; // Already exists
    }

    bucket.set(tx.hash, tx);
    logger.debug(`Added tx ${tx.hash} to slot ${targetSlot} bucket`);
    return true;
  }

  get(slot: number): Tx[] {
    return this.snapshot(slot);
  }

  snapshot(slot: number): Tx[] {
    const bucket = this.buckets.get(slot);
    if (!bucket) return [];
    // Convert to array
    return Array.from(bucket.values());
  }

  countBySender(sender: string, slot: number): number {
    const bucket = this.buckets.get(slot);
    if (!bucket) return 0;
    
    let count = 0;
    for (const tx of bucket.values()) {
      if (tx.sender.toLowerCase() === sender.toLowerCase()) {
        count++;
      }
    }
    return count;
  }

  evict(slot: number): void {
    if (this.buckets.has(slot)) {
      this.buckets.delete(slot);
      logger.debug(`Evicted mempool bucket for slot ${slot}`);
    }
  }

  carryForward(txs: Tx[], toSlot: number): void {
    if (!this.buckets.has(toSlot)) {
      this.buckets.set(toSlot, new Map());
    }
    const bucket = this.buckets.get(toSlot)!;
    
    let addedCount = 0;
    for (const tx of txs) {
      if (!bucket.has(tx.hash)) {
        bucket.set(tx.hash, tx);
        addedCount++;
      }
    }
    logger.debug(`Carried forward ${addedCount} txs to slot ${toSlot}`);
  }
}
