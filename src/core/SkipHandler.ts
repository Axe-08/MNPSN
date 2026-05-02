import { SkipHandler as ISkipHandler, Batch, EMPTY_MERKLE_ROOT } from '../types.js';
import { logger } from '../utils/logger.js';

export class SkipHandler implements ISkipHandler {
  private consecutiveSkips: number = 0;
  private readonly maxConsecutiveSkips: number = 3;

  recordSkip(slot: number): void {
    this.consecutiveSkips++;
    logger.warn(`Recorded skip for slot ${slot}. Consecutive skips: ${this.consecutiveSkips}`);
  }

  getConsecutiveSkips(): number {
    return this.consecutiveSkips;
  }

  getEffectiveSlotDuration(baseDelta: number): number {
    if (this.consecutiveSkips === 0) return baseDelta;
    // Double for each skip, cap at 4x
    const multiplier = Math.pow(2, this.consecutiveSkips);
    const cappedMultiplier = Math.min(multiplier, 4);
    return baseDelta * cappedMultiplier;
  }

  shouldTriggerEmergencyResync(): boolean {
    return this.consecutiveSkips >= this.maxConsecutiveSkips;
  }

  reset(): void {
    if (this.consecutiveSkips > 0) {
      logger.info('Resetting consecutive skips counter');
      this.consecutiveSkips = 0;
    }
  }

  getPrevRoot(slot: number, batchHistory: Map<number, Batch>): string {
    // Look backwards from slot - 1 to find the first non-null batch
    for (let i = slot - 1; i >= 0; i--) {
      const batch = batchHistory.get(i);
      if (batch && batch.root !== EMPTY_MERKLE_ROOT) {
        return batch.root;
      }
    }
    // Genesis or no valid batches ever finalized
    return '0x0000000000000000000000000000000000000000000000000000000000000000';
  }
}
