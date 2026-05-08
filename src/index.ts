import fs from "fs";
import { logger } from "./utils/logger.js";
import { NodesRegistry } from "./types.js";
import { NodeDaemon } from "./NodeDaemon.js";
import { VRFProvider } from "./crypto/VRFProvider.js";
import { multiaddr } from "@multiformats/multiaddr";

async function main() {
  const listenPort = parseInt(process.env.PORT || "0");
  const rpcPort = parseInt(process.env.RPC_PORT || "8080");
  const baseDelta = parseInt(process.env.SLOT_DURATION || "5000");
  const epsilon = parseInt(process.env.CUTOFF_BUFFER || "1000");
  const rawGenesis = parseInt(process.env.GENESIS_TIMESTAMP || "0");
  // If GENESIS_TIMESTAMP is 0 or unset, use current time so slots start from 0
  const genesisTimestamp = rawGenesis > 0 ? rawGenesis : Date.now();
  if (rawGenesis === 0) {
    logger.info(`GENESIS_TIMESTAMP not set or 0, using current time: ${genesisTimestamp}`);
  } else {
    logger.info(`Using GENESIS_TIMESTAMP: ${genesisTimestamp}`);
  }

  let secretKey = process.env.VRF_SECRET_KEY;
  const nodesConfigPath = process.env.NODES_CONFIG_PATH || "./nodes.json";

  // Load nodes config
  let registry: NodesRegistry;
  try {
    const configData = fs.readFileSync(nodesConfigPath, "utf-8");
    registry = JSON.parse(configData);
  } catch (e: any) {
    logger.error(`Failed to load nodes.json: ${e.message}`);
    process.exit(1);
  }

  const nodeId = process.env.NODE_ID || "node-1";

  // Find our node config
  const ourConfig = registry.nodes.find((n) => n.nodeId === nodeId);
  if (!ourConfig) {
    logger.error(`Node config not found for NODE_ID: ${nodeId}`);
    process.exit(1);
  }

  if (!secretKey) {
    // For local dev convenience, generate a random key if none provided
    // Note: This won't match nodes.json, so it won't be able to propose valid blocks!
    logger.warn(
      "No VRF_SECRET_KEY provided, generating a dummy key for testing",
    );
    const kp = VRFProvider.generateKeyPair();
    secretKey = kp.secretKey;
  }

  const daemon = new NodeDaemon(
    nodeId,
    secretKey,
    ourConfig,
    registry,
    listenPort,
    rpcPort,
    baseDelta,
    epsilon,
    genesisTimestamp,
  );

  await daemon.start();

  // --- Readiness check: wait until peers are connected before starting consensus ---
  const expectedPeers = registry.nodes.length - 1; // N-1 other nodes
  const maxWaitMs = 60_000; // 60 second timeout
  const pollIntervalMs = 2_000;
  const startWait = Date.now();

  logger.info(`Waiting for at least ${expectedPeers} peer(s) to connect (timeout: ${maxWaitMs / 1000}s)...`);

  while (Date.now() - startWait < maxWaitMs) {
    const connectedPeers = daemon.network.getConnectedPeerCount();
    logger.info(`Peer check: ${connectedPeers}/${expectedPeers} peers connected (elapsed: ${Math.round((Date.now() - startWait) / 1000)}s)`);

    if (connectedPeers >= expectedPeers) {
      logger.info(`All ${expectedPeers} peers connected!`);
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Additional GossipSub mesh stabilization time after peers connect
  logger.info("Peers connected. Waiting 5s for GossipSub mesh stabilization...");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Log full mesh diagnostics before starting consensus
  daemon.network.logMeshStatus();

  logger.info("Starting consensus slot manager.");
  daemon.slotManager.start();

  // IPC for simulation suite
  if (process.send) {
    const addrs = daemon.network.node
      .getMultiaddrs()
      .map((a: any) => a.toString());
    process.send({ type: "READY", addrs });

    process.on("message", async (msg: any) => {
      if (msg.type === "PEERS") {
        for (const addr of msg.addrs) {
          try {
            const ma = multiaddr(addr);
            await daemon.network.node.dial(ma);
            logger.info(`Successfully dialed peer via IPC multiaddr: ${addr}`);
          } catch (e: any) {
            // Ignore dialect failure for self-addrs or disconnected peers
          }
        }
      }
    });
  }

  process.on("SIGINT", async () => {
    logger.info("Shutting down daemon...");
    await daemon.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
