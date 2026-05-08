import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { logger } from '../utils/logger.js';

const ANCHOR_ABI = parseAbi([
  'function submitBatch(uint256 slot, bytes32 stateRoot, uint256 txCount) external',
  'function getStateRoot(uint256 slot) external view returns (bytes32)',
  'function getBatchRoot(uint256 slot) external view returns (bytes32)',
  'function batches(uint256 slot) external view returns (bytes32)',
  'event BatchSubmitted(uint256 indexed slot, bytes32 stateRoot, uint256 txCount)',
  'event SlotEmpty(uint256 indexed slot, bytes32 stateRoot)',
]);

export class AnchorClient {
  private walletClient;
  private publicClient;
  private account;

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

  async submitBatch(slot: number, stateRoot: `0x${string}`, txCount: number = 0): Promise<string> {
    try {
      const hash = await this.walletClient.writeContract({
        address: this.contractAddress,
        abi: ANCHOR_ABI,
        functionName: 'submitBatch',
        args: [BigInt(slot), stateRoot, BigInt(txCount)],
      });
      logger.info(`Submitted batch for slot ${slot} to L1. Tx: ${hash} (txCount: ${txCount})`);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      logger.info(`L1 tx confirmed in block ${receipt.blockNumber}`);
      return hash;
    } catch (e: any) {
      if (e.message?.includes('already anchored')) {
        logger.warn(`Slot ${slot} already anchored on L1, skipping`);
        return '';
      }
      logger.error(`L1 submit failed for slot ${slot}: ${e.message}`);
      throw e;
    }
  }

  async getStateRoot(slot: number): Promise<string> {
    return await this.publicClient.readContract({
      address: this.contractAddress,
      abi: ANCHOR_ABI,
      functionName: 'getStateRoot',
      args: [BigInt(slot)],
    }) as string;
  }

  /** @deprecated Use getStateRoot instead */
  async getBatchRoot(slot: number): Promise<string> {
    return this.getStateRoot(slot);
  }
}
