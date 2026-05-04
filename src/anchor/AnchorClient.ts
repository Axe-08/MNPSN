import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { logger } from '../utils/logger.js';

const ANCHOR_ABI = parseAbi([
  'function submitBatch(uint256 slot, bytes32 root) external',
  'function getBatchRoot(uint256 slot) external view returns (bytes32)',
  'function batches(uint256 slot) external view returns (bytes32)',
  'event BatchSubmitted(uint256 indexed slot, bytes32 root)',
  'event SlotSkipped(uint256 indexed slot)',
]);

export class AnchorClient {
  private walletClient;
  private publicClient;
  private account;

  private noncePromise: Promise<number> | null = null;

  constructor(
    private contractAddress: `0x${string}`,
    deployerPrivateKey: `0x${string}`,
    rpcUrl: string = 'https://rpc.sepolia.org'
  ) {
    this.account = privateKeyToAccount(deployerPrivateKey);
    this.walletClient = createWalletClient({
      account: this.account,
      chain: sepolia,
      transport: http(rpcUrl),
    });
    this.publicClient = createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl),
    });
  }

  async submitBatch(slot: number, root: `0x${string}`): Promise<string> {
    try {
      if (!this.noncePromise) {
        this.noncePromise = this.publicClient.getTransactionCount({ address: this.account.address });
      }
      const nonce = await this.noncePromise;
      this.noncePromise = Promise.resolve(nonce + 1);

      const hash = await this.walletClient.writeContract({
        address: this.contractAddress,
        abi: ANCHOR_ABI,
        functionName: 'submitBatch',
        args: [BigInt(slot), root],
        nonce,
      });
      logger.info(`Submitted batch for slot ${slot} to L1. Tx: ${hash}`);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      logger.info(`L1 tx confirmed in block ${receipt.blockNumber}`);
      return hash;
    } catch (e: any) {
      logger.error(`L1 submit failed for slot ${slot}: ${e.message}`);
      throw e;
    }
  }

  async getBatchRoot(slot: number): Promise<string> {
    return await this.publicClient.readContract({
      address: this.contractAddress,
      abi: ANCHOR_ABI,
      functionName: 'getBatchRoot',
      args: [BigInt(slot)],
    }) as string;
  }
}
