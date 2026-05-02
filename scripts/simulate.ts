import { spawn, ChildProcess } from 'child_process';
import { VRFProvider } from '../src/crypto/VRFProvider.js';
import { logger } from '../src/utils/logger.js';
import fs from 'fs';
import http from 'http';

// Override logger level for the master script
logger.level = 'info';

async function runSimulation() {
  logger.info('--- Starting MNPSN Multi-Process Simulation Suite ---');

  const nodesCount = 3;
  const nodeSecrets: string[] = [];
  const nodeConfigs: any[] = [];

  // 1. Generate keys
  for (let i = 1; i <= nodesCount; i++) {
    const kp = VRFProvider.generateKeyPair();
    nodeSecrets.push(kp.secretKey);
    nodeConfigs.push({
      nodeId: `node-${i}`,
      vrfPublicKey: kp.publicKey
    });
  }

  // Write a temporary config for the test
  fs.writeFileSync('./nodes.json', JSON.stringify({ nodes: nodeConfigs }, null, 2));
  logger.info('Generated fresh keys and saved to nodes.json');

  // 2. Spawn child processes
  const processes: ChildProcess[] = [];
  let baseRpcPort = 8080;

  for (let i = 0; i < nodesCount; i++) {
    const env = {
      ...process.env,
      NODE_ID: nodeConfigs[i].nodeId,
      VRF_SECRET_KEY: nodeSecrets[i],
      PORT: '0',
      RPC_PORT: (baseRpcPort + i).toString(),
      SLOT_DURATION: '5000',
      CUTOFF_BUFFER: '1000'
    };

    logger.info(`Starting ${nodeConfigs[i].nodeId} on RPC ${baseRpcPort + i}...`);
    // Pass stdio: ['inherit', 'inherit', 'inherit', 'ipc'] to enable IPC while keeping colorized logs!
    const child = spawn('npx', ['tsx', 'src/index.ts'], { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    processes.push(child);
  }

  const allAddrs: string[] = [];
  let readyCount = 0;

  await new Promise<void>((resolve) => {
    for (const child of processes) {
      child.on('message', (msg: any) => {
        if (msg.type === 'READY') {
          allAddrs.push(...msg.addrs);
          readyCount++;
          if (readyCount === nodesCount) resolve();
        }
      });
    }
  });

  logger.info(`All nodes ready. Broadcasting ${allAddrs.length} multiaddrs via IPC to establish full mesh...`);
  
  for (const child of processes) {
    child.send({ type: 'PEERS', addrs: allAddrs });
  }

  // 3. Give them time to mesh
  logger.info('Waiting 3 seconds for GossipSub mesh to stabilize...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 4. Inject Transactions
  logger.info('Injecting 5 transactions into node-1 (RPC 8080)...');
  const sendTx = (port: number, payloadHex: string) => {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ sender: '0xabc', payload: payloadHex });
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/tx',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  };

  try {
    await sendTx(8080, '0xaaaa');
    await sendTx(8080, '0xbbbb');
    await sendTx(8080, '0xcccc');
    await sendTx(8080, '0xdddd');
    await sendTx(8080, '0xeeee');
    logger.info('Successfully submitted 5 txs!');
  } catch (err: any) {
    logger.error(`Failed to submit txs: ${err.message}`);
  }

  logger.info('Waiting 15 seconds to observe consensus and finalization...');
  await new Promise(resolve => setTimeout(resolve, 15000));

  // 5. Teardown
  logger.info('Shutting down nodes...');
  processes.forEach(p => p.kill('SIGINT'));
  process.exit(0);
}

runSimulation().catch(e => {
  console.error(e);
  process.exit(1);
});
