import { Tx, Batch, OrderingEngine as IOrderingEngine, ProposerEngine as IProposerEngine, ForkChoice as IForkChoice, EMPTY_MERKLE_ROOT } from '../types.js';
import { keccak256 } from 'viem';

export class OrderingEngine implements IOrderingEngine {
  order(txs: Tx[], randomness: string): Tx[] {
    const rClean = randomness.startsWith('0x') ? randomness.slice(2) : randomness;
    
    // Map to keys for sorting
    const txWithKeys = txs.map(tx => {
      const hClean = tx.hash.startsWith('0x') ? tx.hash.slice(2) : tx.hash;
      const key = keccak256(`0x${hClean}${rClean}`);
      return { tx, key };
    });

    // Sort ascending by key, tie-break with tx.hash
    txWithKeys.sort((a, b) => {
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      if (a.tx.hash < b.tx.hash) return -1;
      if (a.tx.hash > b.tx.hash) return 1;
      return 0;
    });

    return txWithKeys.map(item => item.tx);
  }
}

export class ProposerEngine implements IProposerEngine {
  computeScore(vrfOutput: string): bigint {
    return BigInt(vrfOutput);
  }
}

export class ForkChoice implements IForkChoice {
  constructor(private proposerEngine: ProposerEngine = new ProposerEngine()) {}

  select(batches: Batch[]): Batch | null {
    if (!batches || batches.length === 0) return null;

    let winningBatch = batches[0];
    let winningScore = this.proposerEngine.computeScore(winningBatch.randomness);

    for (let i = 1; i < batches.length; i++) {
      const batch = batches[i];
      const score = this.proposerEngine.computeScore(batch.randomness);

      if (score < winningScore) {
        winningScore = score;
        winningBatch = batch;
      } else if (score === winningScore) {
        // Tie breaker: lexicographic string compare of proposer ID
        if (batch.proposer < winningBatch.proposer) {
          winningScore = score;
          winningBatch = batch;
        }
      }
    }

    return winningBatch;
  }
}

export class BatchBuilder {
  build(
    slot: number,
    proposer: string,
    randomness: string,
    vrfProof: string,
    publicKey: string,
    orderedTxs: Tx[]
  ): Batch {
    return {
      slot,
      proposer,
      randomness,
      vrfProof,
      publicKey,
      txs: orderedTxs,
      root: this.computeMerkleRoot(orderedTxs)
    };
  }

  computeMerkleRoot(txs: Tx[]): string {
    if (txs.length === 0) return EMPTY_MERKLE_ROOT;

    let hashes = txs.map(tx => keccak256(`0x${tx.hash.startsWith('0x') ? tx.hash.slice(2) : tx.hash}`));

    while (hashes.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = i + 1 < hashes.length ? hashes[i + 1] : hashes[i]; // Duplicate last if odd
        
        const lClean = left.startsWith('0x') ? left.slice(2) : left;
        const rClean = right.startsWith('0x') ? right.slice(2) : right;
        nextLevel.push(keccak256(`0x${lClean}${rClean}`));
      }
      hashes = nextLevel;
    }

    return hashes[0];
  }
}
