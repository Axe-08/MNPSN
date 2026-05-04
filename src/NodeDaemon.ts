import { logger, setLoggerSlot } from './utils/logger.js';
import { NetworkNode, TOPIC_TX, TOPIC_BATCH, TOPIC_MEMPOOL_DIGEST, TOPIC_MEMPOOL_SYNC } from './network/index.js';
import { Mempool } from './mempool/index.js';
import { SlotManager, Phase } from './core/SlotManager.js';
import { SkipHandler } from './core/SkipHandler.js';
import { VRFProvider } from './crypto/VRFProvider.js';
import { SyncManager } from './sync/SyncManager.js';
import { OrderingEngine, ProposerEngine, ForkChoice, BatchBuilder } from './consensus/index.js';
import { Tx, Batch, MempoolDigest, NULL_BATCH, NodesRegistry, NodeConfig, EMPTY_MERKLE_ROOT } from './types.js';
import { AnchorClient } from './anchor/AnchorClient.js';
import { keccak256 } from 'viem';
import * as http from 'http';

export class NodeDaemon {
  public network: NetworkNode;
  public mempool: Mempool;
  public slotManager: SlotManager;
  public skipHandler: SkipHandler;
  public vrfProvider: VRFProvider;
  public syncManager: SyncManager;
  public orderingEngine: OrderingEngine;
  public proposerEngine: ProposerEngine;
  public forkChoice: ForkChoice;
  public batchBuilder: BatchBuilder;
  public anchorClient?: AnchorClient;

  public batchHistory = new Map<number, Batch>();
  public receivedProposals = new Map<number, Batch[]>();
  
  private rpcServer?: http.Server;

  constructor(
    public readonly nodeId: string,
    public readonly secretKey: string,
    public readonly ourConfig: NodeConfig,
    public readonly registry: NodesRegistry,
    public readonly listenPort: number = 0,
    public readonly rpcPort: number = 0,
    public readonly baseDelta: number = 5000,
    public readonly epsilon: number = 1000,
    public readonly genesisTimestamp: number = Date.now()
  ) {
    this.network = new NetworkNode(listenPort);
    this.mempool = new Mempool(baseDelta, epsilon, genesisTimestamp);
    this.slotManager = new SlotManager(baseDelta, epsilon, genesisTimestamp);
    this.skipHandler = new SkipHandler();
    this.vrfProvider = new VRFProvider();
    this.syncManager = new SyncManager(this.nodeId, this.network);
    
    this.orderingEngine = new OrderingEngine();
    this.proposerEngine = new ProposerEngine();
    this.forkChoice = new ForkChoice(this.proposerEngine);
    this.batchBuilder = new BatchBuilder();

    this.setupStateMachine();

    if (process.env.ANCHOR_CONTRACT_ADDRESS && process.env.DEPLOYER_PRIVATE_KEY) {
      this.anchorClient = new AnchorClient(
        process.env.ANCHOR_CONTRACT_ADDRESS as `0x${string}`,
        process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`,
        process.env.SEPOLIA_RPC_URL
      );
      logger.info(`[${this.nodeId}] AnchorClient initialized`);
    }
  }

  private setupNetworkHandlers() {
    this.network.onMessage(TOPIC_TX, (tx: Tx) => {
      this.mempool.add(tx, Date.now());
    });

    this.network.onMessage(TOPIC_MEMPOOL_DIGEST, (digest: MempoolDigest) => {
      this.syncManager.receiveDigest(digest);
    });

    this.network.onMessage(TOPIC_BATCH, (batch: Batch) => {
      const boundaries = this.slotManager.getSlotBoundaries(batch.slot);
      const now = Date.now();
      if (now > boundaries.syncEnd + 500) {
        logger.debug(`[${this.nodeId}] Rejected proposal for slot ${batch.slot} due to late arrival`);
        return;
      }
      if (!this.receivedProposals.has(batch.slot)) {
        this.receivedProposals.set(batch.slot, []);
      }
      this.receivedProposals.get(batch.slot)!.push(batch);
    });

    this.network.onMessage(TOPIC_MEMPOOL_SYNC, (txs: Tx[]) => {
      if (this.skipHandler.shouldTriggerEmergencyResync()) {
        logger.info(`[${this.nodeId}] Received emergency mempool sync from peer: ${txs.length} txs`);
        this.mempool.carryForward(txs, this.slotManager.getCurrentSlot());
      }
    });
  }

  private setupStateMachine() {
    const totalNodes = this.registry.nodes.length;

    this.slotManager.on('phase_changed', async (phase: Phase, slot: number) => {
      try {
        if (phase === 'FREEZE') {
          logger.info(`[${this.nodeId}] FREEZE slot ${slot}`);
        } 
        else if (phase === 'SYNC') {
          logger.info(`[${this.nodeId}] SYNC slot ${slot}`);
          const localTxs = this.mempool.snapshot(slot);
          const localHashes = localTxs.map(tx => tx.hash);
          await this.syncManager.broadcastDigest(slot, localHashes);
        } 
        else if (phase === 'PROPOSE') {
          logger.info(`[${this.nodeId}] PROPOSE slot ${slot}`);
          
          const commonHashes = this.syncManager.computeCommonSubset(slot, totalNodes);
          const localTxs = this.mempool.snapshot(slot);
          const localHashes = localTxs.map(tx => tx.hash);
          const excludedHashes = this.syncManager.getExcludedTxHashes(slot, localHashes, totalNodes);
          
          if (excludedHashes.length > 0) {
            const excludedTxs = localTxs.filter(tx => excludedHashes.includes(tx.hash));
            this.mempool.carryForward(excludedTxs, slot + 1);
          }

          const commonSet = new Set(commonHashes);
          const commonTxs = localTxs.filter(tx => commonSet.has(tx.hash));
          
          if (commonTxs.length !== commonHashes.length) {
            logger.warn(`[${this.nodeId}] Missing payloads for common subset! Have ${commonTxs.length}/${commonHashes.length}. Cannot propose.`);
            return;
          }

          const prevRoot = this.skipHandler.getPrevRoot(slot, this.batchHistory);
          const seed = this.vrfProvider.computeSlotSeed(prevRoot, slot);
          const { output, proof } = this.vrfProvider.prove(this.secretKey, seed);
          
          const orderedTxs = this.orderingEngine.order(commonTxs, output);
          const proposal = this.batchBuilder.build(slot, this.nodeId, output, proof, this.ourConfig.vrfPublicKey, orderedTxs);
          
          await this.network.publishBatch(proposal);
        } 
        else if (phase === 'FINALIZE') {
          logger.info(`[${this.nodeId}] FINALIZE slot ${slot}`);
          
          const proposals = this.receivedProposals.get(slot) || [];
          const prevRoot = this.skipHandler.getPrevRoot(slot, this.batchHistory);
          const seed = this.vrfProvider.computeSlotSeed(prevRoot, slot);
          const commonHashes = this.syncManager.computeCommonSubset(slot, totalNodes).sort();

          const validProposals = proposals.filter(p => {
            if (p.slot !== slot) return false;
            
            const proposerConfig = this.registry.nodes.find(n => n.nodeId === p.proposer);
            if (!proposerConfig || proposerConfig.vrfPublicKey !== p.publicKey) return false;

            const isValidVrf = this.vrfProvider.verify(p.publicKey, seed, p.randomness, p.vrfProof);
            if (!isValidVrf) return false;

            const expectedRoot = this.batchBuilder.computeMerkleRoot(p.txs);
            if (p.root !== expectedRoot) return false;

            const pHashes = p.txs.map(tx => tx.hash).sort();
            if (JSON.stringify(pHashes) !== JSON.stringify(commonHashes)) return false;

            const correctlyOrdered = this.orderingEngine.order(p.txs, p.randomness);
            for (let i = 0; i < p.txs.length; i++) {
              if (p.txs[i].hash !== correctlyOrdered[i].hash) return false;
            }

            return true;
          });

          logger.info(`[${this.nodeId}] Found ${validProposals.length}/${proposals.length} valid proposals for slot ${slot}`);

          const winner = this.forkChoice.select(validProposals);
          
          if (winner) {
            logger.info(`[${this.nodeId}] Winning batch for slot ${slot}: Proposer ${winner.proposer}, Root ${winner.root}, Txs: ${winner.txs.length}`);
            this.batchHistory.set(slot, winner);
            this.skipHandler.reset();
            this.slotManager.setEffectiveSlotDuration(this.baseDelta);

            if (this.anchorClient && winner.proposer === this.nodeId) {
              this.anchorClient.submitBatch(slot, winner.root as `0x${string}`).catch(e => logger.error(`Anchor failed: ${e.message}`));
            }
          } else {
            logger.warn(`[${this.nodeId}] No valid proposals for slot ${slot}, recording null batch`);
            const nullBatch = NULL_BATCH(slot);
            this.batchHistory.set(slot, nullBatch);
            this.skipHandler.recordSkip(slot);

            if (this.anchorClient && this.registry.nodes[0].nodeId === this.nodeId) {
              this.anchorClient.submitBatch(slot, EMPTY_MERKLE_ROOT as `0x${string}`).catch(e => logger.error(`Anchor failed: ${e.message}`));
            }
            
            const localTxs = this.mempool.snapshot(slot);
            const commonSet = new Set(commonHashes);
            const commonTxs = localTxs.filter(tx => commonSet.has(tx.hash));
            this.mempool.carryForward(commonTxs, slot + 1);

            this.slotManager.setEffectiveSlotDuration(this.skipHandler.getEffectiveSlotDuration(this.baseDelta));

            if (this.skipHandler.shouldTriggerEmergencyResync()) {
              logger.error(`[${this.nodeId}] EMERGENCY RESYNC TRIGGERED (Consecutive skips: ${this.skipHandler.getConsecutiveSkips()})`);
              const allCurrentTxs = this.mempool.snapshot(slot + 1);
              await this.network.publishMempoolSync(allCurrentTxs);
            }
          }

          this.mempool.evict(slot);
          this.syncManager.clearSlot(slot);
          this.receivedProposals.delete(slot);
        }
      } catch (e: any) {
        logger.error(`[${this.nodeId}] Error in phase ${phase}: ${e.message}`);
      }
    });
  }

  public async start() {
    await this.network.start();
    this.setupNetworkHandlers();

    // Resume from last anchored slot on L1
    if (this.anchorClient) {
      try {
        const lastSlot = await this.anchorClient.getLastAnchoredSlot();
        if (lastSlot >= 0) {
          const resumeSlot = lastSlot + 1;
          logger.info(`[${this.nodeId}] L1 reports last anchored slot: ${lastSlot}. Resuming from slot ${resumeSlot}`);
          this.slotManager.setStartSlot(resumeSlot);
        } else {
          logger.info(`[${this.nodeId}] No slots anchored on L1 yet, starting from slot 0`);
        }
      } catch (e: any) {
        logger.warn(`[${this.nodeId}] Could not query L1 for resume slot: ${e.message}. Starting from slot 0`);
      }
    }

    this.slotManager.start();

    if (this.rpcPort > 0) {
      this.rpcServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/tx') {
          let body = '';
          req.on('data', chunk => body += chunk.toString());
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const payloadHex = data.payload || '0x';
              const sender = data.sender || '0x0000000000000000000000000000000000000000';
              
              // Keccak hash to create unique tx ID
              const hash = keccak256(`0x${Buffer.from(payloadHex + sender + Date.now()).toString('hex')}`);
              
              const tx: Tx = {
                hash,
                sender,
                nonce: Date.now(), // dummy nonce for manual testing
                payload: payloadHex
              };

              this.mempool.add(tx, Date.now());
              await this.network.publishTx(tx);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, hash }));
            } catch (err: any) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: err.message }));
            }
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      this.rpcServer.listen(this.rpcPort, () => {
        logger.info(`[${this.nodeId}] RPC Server listening on port ${this.rpcPort}`);
      });
    }
  }

  public async stop() {
    this.slotManager.stop();
    await this.network.stop();
    if (this.rpcServer) {
      this.rpcServer.close();
    }
  }
}
