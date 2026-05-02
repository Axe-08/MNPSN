import { createLibp2p, Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@libp2p/gossipsub';
import { mdns } from '@libp2p/mdns';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { logger } from '../utils/logger.js';
import { Tx, Batch, MempoolDigest } from '../types.js';

export const TOPIC_TX = '/tx';
export const TOPIC_BATCH = '/batch';
export const TOPIC_MEMPOOL_DIGEST = '/mempool-digest';
export const TOPIC_MEMPOOL_SYNC = '/mempool-sync';

export class NetworkNode {
  public node!: Libp2p;

  constructor(private listenPort: number = 0) {}

  async start() {
    this.node = await createLibp2p({
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${process.env.P2P_PORT || this.listenPort}`]
      },
      transports: [
        tcp()
      ],
      connectionEncrypters: [
        noise()
      ],
      streamMuxers: [
        yamux()
      ],
      peerDiscovery: [
        mdns({
          interval: 1000 // discover peers every second for local testing
        })
      ],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          allowPublishToZeroPeers: true,
          fallbackToFloodsub: true
        })
      }
    });

    this.node.addEventListener('peer:discovery', async (evt) => {
      logger.debug(`Found peer: ${evt.detail.id.toString()}`);
      try {
        if (evt.detail.multiaddrs && evt.detail.multiaddrs.length > 0) {
          await this.node.dial(evt.detail.multiaddrs[0]);
          logger.info(`Dialed discovered peer: ${evt.detail.multiaddrs[0].toString()}`);
        }
      } catch (e: any) {
        // Ignore errors if already connected or failed to dial
      }
    });

    this.node.addEventListener('peer:connect', (evt) => {
      logger.info(`Connected to peer: ${evt.detail.toString()}`);
    });

    this.node.addEventListener('peer:disconnect', (evt) => {
      logger.info(`Disconnected from peer: ${evt.detail.toString()}`);
    });

    await this.node.start();
    
    const listenAddrs = this.node.getMultiaddrs();
    logger.info(`Libp2p node started. Listening on addresses:`);
    listenAddrs.forEach((addr) => {
      logger.info(addr.toString());
    });

    if (process.env.BOOTSTRAP_NODES) {
      const addrs = process.env.BOOTSTRAP_NODES.split(',');
      for (let addr of addrs) {
        addr = addr.trim();
        if (!addr) continue;
        try {
          const ma = multiaddr(addr);
          const parts = addr.split('/p2p/');
          if (parts.length < 2) throw new Error("No peer ID found in multiaddr");
          
          const peerIdStr = parts[1];
          const peerId = peerIdFromString(peerIdStr);
          await this.node.peerStore.save(peerId, { multiaddrs: [ma] });
          await this.node.dial(peerId);
          logger.info(`Explicitly dialed bootstrap node: ${addr}`);
        } catch(e: any) {
          logger.error(`Failed to dial bootstrap node ${addr}: ${e.message}`);
        }
      }
    }



    // Subscribe to topics
    this.node.services.pubsub.subscribe(TOPIC_TX);
    this.node.services.pubsub.subscribe(TOPIC_BATCH);
    this.node.services.pubsub.subscribe(TOPIC_MEMPOOL_DIGEST);
    this.node.services.pubsub.subscribe(TOPIC_MEMPOOL_SYNC);

    logger.info(`Subscribed to GossipSub topics: ${TOPIC_TX}, ${TOPIC_BATCH}, ${TOPIC_MEMPOOL_DIGEST}, ${TOPIC_MEMPOOL_SYNC}`);
  }

  async stop() {
    await this.node.stop();
    logger.info('Libp2p node stopped.');
  }

  // Publishing methods
  private async safePublish(topic: string, msgObj: any, desc: string) {
    try {
      const data = new TextEncoder().encode(JSON.stringify(msgObj));
      await this.node.services.pubsub.publish(topic, data);
      logger.debug(`Published ${desc} to ${topic}`);
    } catch (e: any) {
      if (e.name === 'PublishError' || e.code === 'ERR_PUBLISH_NO_PEERS' || e.message.includes('NoPeers')) {
        logger.debug(`No peers subscribed to ${topic}, skipping publish of ${desc}`);
      } else {
        throw e;
      }
    }
  }

  async publishTx(tx: Tx) {
    await this.safePublish(TOPIC_TX, tx, `tx ${tx.hash}`);
  }

  async publishBatch(batch: Batch) {
    await this.safePublish(TOPIC_BATCH, batch, `batch for slot ${batch.slot}`);
  }

  async publishMempoolDigest(digest: MempoolDigest) {
    await this.safePublish(TOPIC_MEMPOOL_DIGEST, digest, `mempool digest for slot ${digest.slot}`);
  }

  async publishMempoolSync(txs: Tx[]) {
    await this.safePublish(TOPIC_MEMPOOL_SYNC, txs, `full mempool state (${txs.length} txs)`);
  }

  // Subscribe to messages
  onMessage(topic: string, handler: (msg: any, sender: string) => void) {
    this.node.services.pubsub.addEventListener('message', (evt) => {
      if (evt.detail.topic === topic) {
        try {
          const strData = new TextDecoder().decode(evt.detail.data);
          const parsed = JSON.parse(strData);
          handler(parsed, evt.detail.from.toString());
        } catch (e: any) {
          logger.error(`Error processing message from topic ${topic}: ${e.message}`);
        }
      }
    });
  }
}
