import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';

async function main() {
  const node1 = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/45454'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()]
  });
  
  const node2 = await createLibp2p({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()]
  });

  await node1.start();
  await node2.start();

  console.log("Node 1 listening on", node1.getMultiaddrs()[0].toString());
  
  try {
    await node2.dial(node1.getMultiaddrs()[0]);
    console.log("Dial succeeded!");
  } catch (e: any) {
    console.error("Dial failed:", e.message);
  }

  await node1.stop();
  await node2.stop();
}

main();
