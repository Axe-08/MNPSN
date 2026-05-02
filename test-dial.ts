import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr } from '@multiformats/multiaddr';

async function run() {
  const node = await createLibp2p({
    transports: [tcp()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()]
  });
  await node.start();
  
  try {
    const ma = multiaddr('/ip4/127.0.0.1/tcp/40001/p2p/12D3KooWQtjc7Ww1drxWWGDgqP1VgE7nSL9FzwwNaCRnvPK8rQsm');
    await node.dial(ma);
  } catch (e) {
    console.log("DIAL MULTIADDR ERROR:", e.message);
  }

  try {
    await node.dial('/ip4/127.0.0.1/tcp/40001/p2p/12D3KooWQtjc7Ww1drxWWGDgqP1VgE7nSL9FzwwNaCRnvPK8rQsm');
  } catch (e) {
    console.log("DIAL STRING ERROR:", e.message);
  }
  
  await node.stop();
}
run();
