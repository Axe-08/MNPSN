import fs from 'fs';
import path from 'path';
import { logger } from './utils/logger.js';
import { NetworkNode, TOPIC_TX, TOPIC_BATCH, TOPIC_MEMPOOL_DIGEST, TOPIC_MEMPOOL_SYNC } from './network/index.js';
import { Mempool } from './mempool/index.js';
import { SlotManager, Phase } from './core/SlotManager.js';
import { SkipHandler } from './core/SkipHandler.js';
import { VRFProvider } from './crypto/VRFProvider.js';
import { SyncManager } from './sync/SyncManager.js';
import { OrderingEngine, ProposerEngine, ForkChoice, BatchBuilder } from './consensus/index.js';
import { Tx, Batch, MempoolDigest, NULL_BATCH, NodesRegistry } from './types.js';

async function main() {
  const listenPort = parseInt(process.env.PORT || '0');
  const baseDelta = parseInt(process.env.SLOT_DURATION || '5000');
  const epsilon = parseInt(process.env.CUTOFF_BUFFER || '1000');
  const secretKey = process.env.VRF_SECRET_KEY;
  const nodesConfigPath = process.env.NODES_CONFIG_PATH || './nodes.json';

  if (!secretKey) {
    logger.error('VRF_SECRET_KEY is required');
    process.exit(1);
  }

  // Load nodes config
  let registry: NodesRegistry;
  try {
    const configData = fs.readFileSync(nodesConfigPath, 'utf-8');
    registry = JSON.parse(configData);
  } catch (e: any) {
    logger.error(`Failed to load nodes.json: ${e.message}`);
    process.exit(1);
  }
  const totalNodes = registry.nodes.length;
  
  // Find our public key to set NODE_ID if not set
  const kp = (new VRFProvider()).prove(secretKey, '0x00'); // Dummy prove to get pk? No, we can generate pubkey
  // Actually, we expect NODE_ID in env or we can just find it from nodes.json if needed.
  // For MVP, we assume NODE_ID is set correctly.
  const nodeId = process.env.NODE_ID || 'node-1';

  // Find our node config
  const ourConfig = registry.nodes.find(n => n.nodeId === nodeId);
  if (!ourConfig) {
    logger.error(`Node config not found for NODE_ID: ${nodeId}`);
    process.exit(1);
  }

  // Initialize components
  const network = new NetworkNode(listenPort);
  await network.start();

  const mempool = new Mempool(baseDelta, epsilon);
  const slotManager = new SlotManager(baseDelta, epsilon);
  const skipHandler = new SkipHandler();
  const vrfProvider = new VRFProvider();
  const syncManager = new SyncManager(network);
  
  const orderingEngine = new OrderingEngine();
  const proposerEngine = new ProposerEngine();
  const forkChoice = new ForkChoice(proposerEngine);
  const batchBuilder = new BatchBuilder();

  // State
  const batchHistory = new Map<number, Batch>();
  const receivedProposals = new Map<number, Batch[]>();

  // Network Handlers
  network.onMessage(TOPIC_TX, (tx: Tx) => {
    mempool.add(tx, Date.now());
  });

  network.onMessage(TOPIC_MEMPOOL_DIGEST, (digest: MempoolDigest) => {
    syncManager.receiveDigest(digest);
  });

  network.onMessage(TOPIC_BATCH, (batch: Batch) => {
    if (!receivedProposals.has(batch.slot)) {
      receivedProposals.set(batch.slot, []);
    }
    // Basic structural validation can happen here
    receivedProposals.get(batch.slot)!.push(batch);
  });

  network.onMessage(TOPIC_MEMPOOL_SYNC, (txs: Tx[]) => {
    if (skipHandler.shouldTriggerEmergencyResync()) {
      logger.info(`Received emergency mempool sync from peer: ${txs.length} txs`);
      // Add all received txs to the next slot (or current if paused)
      mempool.carryForward(txs, slotManager.getCurrentSlot());
    }
  });

  // State Machine Orchestrator
  slotManager.on('phase_changed', async (phase: Phase, slot: number) => {
    try {
      if (phase === 'FREEZE') {
        logger.info(`FREEZE slot ${slot}`);
        // No action required, mempool logic handles time checks natively
      } 
      else if (phase === 'SYNC') {
        logger.info(`SYNC slot ${slot}`);
        const localTxs = mempool.snapshot(slot);
        const localHashes = localTxs.map(tx => tx.hash);
        await syncManager.broadcastDigest(slot, localHashes);
      } 
      else if (phase === 'PROPOSE') {
        logger.info(`PROPOSE slot ${slot}`);
        
        // 1. Compute common subset
        const commonHashes = syncManager.computeCommonSubset(slot, totalNodes);
        
        // 2. Identify excluded and carry forward
        const localTxs = mempool.snapshot(slot);
        const localHashes = localTxs.map(tx => tx.hash);
        const excludedHashes = syncManager.getExcluded(localHashes, commonHashes);
        
        if (excludedHashes.length > 0) {
          const excludedTxs = localTxs.filter(tx => excludedHashes.includes(tx.hash));
          mempool.carryForward(excludedTxs, slot + 1);
        }

        // Gather the actual tx objects for the common subset
        const commonSet = new Set(commonHashes);
        const commonTxs = localTxs.filter(tx => commonSet.has(tx.hash));
        
        if (commonTxs.length !== commonHashes.length) {
          // This node is missing some txs from the common subset. 
          // For MVP, if we don't have the tx payload, we can't propose a valid batch.
          logger.warn(`Missing payloads for common subset! Have ${commonTxs.length}/${commonHashes.length}. Cannot propose.`);
          return;
        }

        // 3. VRF & Ordering
        const prevRoot = skipHandler.getPrevRoot(slot, batchHistory);
        const seed = vrfProvider.computeSlotSeed(prevRoot, slot);
        const { output, proof } = vrfProvider.prove(secretKey, seed);
        
        const orderedTxs = orderingEngine.order(commonTxs, output);
        
        // 4. Build & Broadcast
        const proposal = batchBuilder.build(slot, nodeId, output, proof, ourConfig.vrfPublicKey, orderedTxs);
        await network.publishBatch(proposal);
      } 
      else if (phase === 'FINALIZE') {
        logger.info(`FINALIZE slot ${slot}`);
        
        const proposals = receivedProposals.get(slot) || [];
        const prevRoot = skipHandler.getPrevRoot(slot, batchHistory);
        const seed = vrfProvider.computeSlotSeed(prevRoot, slot);
        const commonHashes = syncManager.computeCommonSubset(slot, totalNodes).sort();

        // Validate proposals
        const validProposals = proposals.filter(p => {
          if (p.slot !== slot) return false;
          
          const proposerConfig = registry.nodes.find(n => n.nodeId === p.proposer);
          if (!proposerConfig || proposerConfig.vrfPublicKey !== p.publicKey) return false;

          const isValidVrf = vrfProvider.verify(p.publicKey, seed, p.randomness, p.vrfProof);
          if (!isValidVrf) return false;

          const expectedRoot = batchBuilder.computeMerkleRoot(p.txs);
          if (p.root !== expectedRoot) return false;

          const pHashes = p.txs.map(tx => tx.hash).sort();
          if (JSON.stringify(pHashes) !== JSON.stringify(commonHashes)) return false;

          // Verify ordering
          const correctlyOrdered = orderingEngine.order(p.txs, p.randomness);
          for (let i = 0; i < p.txs.length; i++) {
            if (p.txs[i].hash !== correctlyOrdered[i].hash) return false;
          }

          return true;
        });

        logger.info(`Found ${validProposals.length}/${proposals.length} valid proposals for slot ${slot}`);

        const winner = forkChoice.select(validProposals);
        
        if (winner) {
          logger.info(`Winning batch for slot ${slot}: Proposer ${winner.proposer}, Root ${winner.root}`);
          batchHistory.set(slot, winner);
          skipHandler.reset();
          slotManager.setEffectiveSlotDuration(baseDelta);
          // Here we would anchor to EVM
        } else {
          logger.warn(`No valid proposals for slot ${slot}, recording null batch`);
          const nullBatch = NULL_BATCH(slot);
          batchHistory.set(slot, nullBatch);
          skipHandler.recordSkip(slot);
          
          // Carry forward common subset to next slot
          const localTxs = mempool.snapshot(slot);
          const commonSet = new Set(commonHashes);
          const commonTxs = localTxs.filter(tx => commonSet.has(tx.hash));
          mempool.carryForward(commonTxs, slot + 1);

          slotManager.setEffectiveSlotDuration(skipHandler.getEffectiveSlotDuration(baseDelta));

          if (skipHandler.shouldTriggerEmergencyResync()) {
            logger.error(`EMERGENCY RESYNC TRIGGERED (Consecutive skips: ${skipHandler.getConsecutiveSkips()})`);
            const allCurrentTxs = mempool.snapshot(slot + 1);
            await network.publishMempoolSync(allCurrentTxs);
            // In a full implementation, we would pause slot progression here until threshold sync is met
          }
        }

        // Cleanup
        mempool.evict(slot);
        syncManager.clearSlot(slot);
        receivedProposals.delete(slot);
      }
    } catch (e: any) {
      logger.error(`Error in state machine phase ${phase}: ${e.message}`);
      logger.debug(e.stack);
    }
  });

  slotManager.start();

  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    slotManager.stop();
    await network.stop();
    process.exit(0);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
