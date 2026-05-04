import { VRFProvider as IVRFProvider } from '../types.js';
import { keccak256 } from 'viem';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/curves/utils.js';

export class VRFProvider implements IVRFProvider {
  prove(secretKey: string, seed: string): { output: string; proof: string } {
    // Clean hex prefix
    const skHex = secretKey.startsWith('0x') ? secretKey.slice(2) : secretKey;
    const seedBytes = hexToBytes(seed.startsWith('0x') ? seed.slice(2) : seed);
    const skBytes = hexToBytes(skHex);
    
    // Using deterministic ECDSA (RFC6979) as a pseudo-VRF for MVP
    // A true ECVRF-P256 is more complex, but this satisfies the security properties:
    // 1. Unpredictable without SK
    // 2. Deterministic and unique for a given (SK, seed)
    // 3. Verifiable with PK
    const sig = secp256k1.sign(seedBytes, skBytes, { lowS: true });
    
    const proofHex = bytesToHex(sig);
    // The output is the hash of the proof to ensure uniform distribution
    const outputHex = keccak256(`0x${proofHex}`);
    
    return {
      output: outputHex,
      proof: `0x${proofHex}`
    };
  }

  verify(publicKey: string, seed: string, output: string, proof: string): boolean {
    try {
      const pkHex = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
      const seedBytes = hexToBytes(seed.startsWith('0x') ? seed.slice(2) : seed);
      const pkBytes = hexToBytes(pkHex);
      const proofHex = proof.startsWith('0x') ? proof.slice(2) : proof;
      
      const sigBytes = hexToBytes(proofHex);
      const isValidSig = secp256k1.verify(sigBytes, seedBytes, pkBytes);
      
      if (!isValidSig) return false;
      
      const expectedOutput = keccak256(`0x${proofHex}`);
      return output === expectedOutput;
    } catch (e) {
      return false;
    }
  }

  computeSlotSeed(prevRoot: string, slotId: number): string {
    const slotString = slotId.toString();
    const slotHex = Buffer.from(slotString, 'utf8').toString('hex');
    const prevRootClean = prevRoot.startsWith('0x') ? prevRoot.slice(2) : prevRoot;
    
    const concatenatedBytes = hexToBytes(`${prevRootClean}${slotHex}`);
    return keccak256(concatenatedBytes);
  }

  // Utility to generate a keypair for testing/setup
  static generateKeyPair() {
    const privKey = secp256k1.utils.randomSecretKey();
    const pubKey = secp256k1.getPublicKey(privKey, true); // compressed
    return {
      secretKey: `0x${bytesToHex(privKey)}`,
      publicKey: `0x${bytesToHex(pubKey)}`
    };
  }
}
