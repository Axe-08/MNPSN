import { VRFProvider } from './src/crypto/VRFProvider.js';
import * as fs from 'fs';

const kp1 = VRFProvider.generateKeyPair();
const kp2 = VRFProvider.generateKeyPair();
const kp3 = VRFProvider.generateKeyPair();

const nodes = {
  nodes: [
    { nodeId: "node-1", vrfPublicKey: kp1.publicKey },
    { nodeId: "node-2", vrfPublicKey: kp2.publicKey },
    { nodeId: "node-3", vrfPublicKey: kp3.publicKey }
  ]
};

fs.writeFileSync('nodes.json', JSON.stringify(nodes, null, 2));

console.log("SECRET1=" + kp1.secretKey);
console.log("SECRET2=" + kp2.secretKey);
console.log("SECRET3=" + kp3.secretKey);
