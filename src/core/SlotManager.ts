import { SlotManager as ISlotManager } from '../types.js';
import { logger, setLoggerSlot } from '../utils/logger.js';
import { EventEmitter } from 'events';

export type Phase = "COLLECT" | "FREEZE" | "SYNC" | "PROPOSE" | "FINALIZE";

export class SlotManager extends EventEmitter implements ISlotManager {
  private currentSlot: number = 0;
  private currentPhase: Phase = "COLLECT";
  private running: boolean = false;
  private effectiveDelta: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly baseDelta: number = 5000,
    private readonly epsilon: number = 1000,
    private genesisTimestamp: number = Date.now()
  ) {
    super();
    this.effectiveDelta = baseDelta;
    this.currentSlot = Math.floor((Date.now() - this.genesisTimestamp) / this.baseDelta);
    if (this.currentSlot < 0) this.currentSlot = 0;
  }

  getCurrentSlot(): number {
    return this.currentSlot;
  }

  getPhase(): Phase {
    return this.currentPhase;
  }

  getEffectiveSlotDuration(): number {
    return this.effectiveDelta;
  }

  setEffectiveSlotDuration(newDelta: number) {
    this.effectiveDelta = newDelta;
  }

  getSlotBoundaries(slot: number) {
    const start = this.genesisTimestamp + (slot * this.baseDelta);
    // Note: If effectiveDelta > baseDelta, the end boundaries are extended.
    // The spec extends the slot duration during recovery, mostly meaning we wait longer in COLLECT/SYNC.
    // To simplify absolute time calculations, we assume the extension just delays the transition to next slot.
    const freeze = start + this.effectiveDelta - this.epsilon;
    const syncEnd = start + this.effectiveDelta;
    const proposeEnd = syncEnd + 500;
    const finalizeEnd = proposeEnd + 1000;
    
    return {
      start,
      freeze,
      syncEnd,
      end: syncEnd, // PROPOSE starts at syncEnd
      finalizeEnd
    };
  }

  setStartSlot(slot: number) {
    this.currentSlot = slot;
    this.currentPhase = "COLLECT";
    // Shift genesis so this slot starts now
    this.genesisTimestamp = Date.now() - (slot * this.baseDelta);
    logger.info(`SlotManager starting from slot ${slot} (genesis adjusted)`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('SlotManager started');
    this.scheduleNextTransition();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    logger.info('SlotManager stopped');
  }

  // Force advance to next slot immediately (e.g. after FINALIZE or null batch)
  advanceToNextSlot() {
    this.currentSlot++;
    this.currentPhase = "COLLECT";
    setLoggerSlot(this.currentSlot);
    logger.info(`Advanced to slot ${this.currentSlot}, phase COLLECT`);
    this.emit("phase_changed", this.currentPhase, this.currentSlot);
    this.scheduleNextTransition();
  }

  private scheduleNextTransition() {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    const now = Date.now();
    const boundaries = this.getSlotBoundaries(this.currentSlot);
    
    let targetTime = 0;
    let nextPhase: Phase = "COLLECT";

    switch (this.currentPhase) {
      case "COLLECT":
        targetTime = boundaries.freeze;
        nextPhase = "FREEZE";
        break;
      case "FREEZE":
        // FREEZE is instantaneous, immediately moves to SYNC
        targetTime = now;
        nextPhase = "SYNC";
        break;
      case "SYNC":
        targetTime = boundaries.syncEnd;
        nextPhase = "PROPOSE";
        break;
      case "PROPOSE":
        targetTime = boundaries.syncEnd + 500;
        nextPhase = "FINALIZE";
        break;
      case "FINALIZE":
        targetTime = boundaries.finalizeEnd;
        nextPhase = "COLLECT"; // Next slot
        break;
    }

    const delay = Math.max(0, targetTime - now);
    
    if (delay === 0 && this.currentPhase !== "COLLECT") {
      // Execute immediately if we are falling behind, but avoid infinite loops
      setImmediate(() => this.executeTransition(nextPhase));
    } else {
      this.timer = setTimeout(() => this.executeTransition(nextPhase), delay);
    }
  }

  private executeTransition(nextPhase: Phase) {
    if (!this.running) return;

    if (nextPhase === "COLLECT") {
      // End of FINALIZE -> Next slot
      this.currentSlot++;
      setLoggerSlot(this.currentSlot);
    }

    this.currentPhase = nextPhase;
    logger.info(`Slot ${this.currentSlot} transitioned to ${this.currentPhase}`);
    this.emit("phase_changed", this.currentPhase, this.currentSlot);

    if (this.running) {
      this.scheduleNextTransition();
    }
  }
}
