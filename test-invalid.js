import { multiaddr } from '@multiformats/multiaddr';
try { multiaddr("invalid"); } catch(e) { console.log(e.message); }
