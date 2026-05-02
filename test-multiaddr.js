import { multiaddr } from '@multiformats/multiaddr';
const ma = multiaddr('/ip4/127.0.0.1/tcp/40001/p2p/12D3KooWQtjc7Ww1drxWWGDgqP1VgE7nSL9FzwwNaCRnvPK8rQsm');
console.log(ma.toString());
