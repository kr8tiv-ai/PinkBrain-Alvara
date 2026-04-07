/**
 * Factory interaction module — typed wrapper around Alvara's BSKT factory on Base.
 *
 * Loads the discovered ABI from T01 output and provides typed functions for
 * reading factory state and creating BSKTs.
 */

import {
  type Address,
  type WalletClient,
  type Hash,
  type TransactionReceipt,
  type Abi,
  getContract,
  decodeEventLog,
  formatEther,
  parseEther,
  encodeFunctionData,
  decodeFunctionData,
  getAddress,
} from 'viem';

// Use loose typing to avoid viem chain-specific PublicClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FactoryConfig {
  factoryAddress: Address;
  abi: Abi;
  isProxy: boolean;
  chainId: number;
}

export interface CreateBasketParams {
  name: string;
  symbol: string;
  tokens: Address[];
  weights: bigint[];
  tokenURI: string;
  swapData: `0x${string}`[];
  signature: `0x${string}`;
  basketId: string;
  description: string;
  deadline: bigint;
  seedValueEth: string; // e.g. "0.1"
}

export interface CreateBasketResult {
  txHash: Hash;
  receipt: TransactionReceipt;
  bsktAddress?: Address;
  bsktPairAddress?: Address;
  creator?: Address;
  gasUsed: bigint;
}

export interface FactoryState {
  totalBSKT: bigint;
  minBSKTCreationAmount: bigint;
  paused: boolean;
  router: Address;
  weth: Address;
  alva: Address;
  bsktImplementation: Address;
  minPercentALVA: number;
}

// ── Load Config ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadFactoryConfig(): FactoryConfig {
  const configPath = resolve(__dirname, '../config/discovered-contracts.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

  if (!raw.factoryAddress || !raw.abi || !raw.chainId) {
    throw new Error('Invalid discovered-contracts.json: missing factoryAddress, abi, or chainId');
  }

  return {
    factoryAddress: getAddress(raw.factoryAddress) as Address,
    abi: raw.abi as Abi,
    isProxy: raw.isProxy ?? false,
    chainId: raw.chainId,
  };
}

// ── Factory Read Functions ─────────────────────────────────────────────────

/**
 * Read current factory state (total BSKTs, min amount, paused, etc.)
 */
export async function getFactoryState(
  client: AnyPublicClient,
  config: FactoryConfig,
): Promise<FactoryState> {
  const contract: any = getContract({
    address: config.factoryAddress,
    abi: config.abi,
    client,
  });

  // Sequential reads with small delay to avoid public RPC rate limits
  const delay = () => new Promise(r => setTimeout(r, 250));

  const totalBSKT = await contract.read.totalBSKT() as bigint;
  await delay();
  const minAmount = await contract.read.minBSKTCreationAmount() as bigint;
  await delay();
  const paused = await contract.read.paused() as boolean;
  await delay();
  const router = await contract.read.router() as Address;
  await delay();
  const weth = await contract.read.weth() as Address;
  await delay();
  const alva = await contract.read.alva() as Address;
  await delay();
  const bsktImpl = await contract.read.bsktImplementation() as Address;
  await delay();
  const minPercentALVA = await contract.read.minPercentALVA() as number;

  return {
    totalBSKT,
    minBSKTCreationAmount: minAmount,
    paused,
    router,
    weth,
    alva,
    bsktImplementation: bsktImpl,
    minPercentALVA,
  };
}

/**
 * Get a BSKT address by index from the factory's bsktList.
 */
export async function getBSKTAtIndex(
  client: AnyPublicClient,
  config: FactoryConfig,
  index: bigint,
): Promise<Address> {
  const contract: any = getContract({
    address: config.factoryAddress,
    abi: config.abi,
    client,
  });
  return contract.read.getBSKTAtIndex([index]) as Promise<Address>;
}

// ── Factory Write Functions ────────────────────────────────────────────────

/**
 * Create a new BSKT via the factory. Sends a payable transaction with ETH seed.
 *
 * On success: returns tx hash, receipt, and extracted BSKT address from events.
 * On revert: throws with decoded revert reason if possible.
 */
export async function createBasket(
  walletClient: WalletClient,
  publicClient: AnyPublicClient,
  config: FactoryConfig,
  params: CreateBasketParams,
): Promise<CreateBasketResult> {
  const seedWei = parseEther(params.seedValueEth);

  console.log(JSON.stringify({
    phase: 'create_bskt',
    action: 'sending_tx',
    factory: config.factoryAddress,
    tokens: params.tokens,
    weights: params.weights.map(String),
    seedEth: params.seedValueEth,
    deadline: String(params.deadline),
  }));

  // Estimate gas first
  let gasEstimate: bigint;
  try {
    gasEstimate = await publicClient.estimateGas({
      account: walletClient.account!,
      to: config.factoryAddress,
      value: seedWei,
      data: encodeFunctionData({
        abi: config.abi,
        functionName: 'createBSKT',
        args: [
          params.name,
          params.symbol,
          params.tokens,
          params.weights,
          params.tokenURI,
          params.swapData,
          params.signature,
          params.basketId,
          params.description,
          params.deadline,
        ],
      }),
    });
    console.log(JSON.stringify({ phase: 'create_bskt', action: 'gas_estimated', gasEstimate: String(gasEstimate) }));
  } catch (err: unknown) {
    // Gas estimation failure = will revert. Extract reason.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      phase: 'create_bskt',
      action: 'gas_estimation_failed',
      error: errMsg.slice(0, 500),
    }));
    throw err;
  }

  // Send the transaction
  const txHash = await walletClient.writeContract({
    address: config.factoryAddress,
    abi: config.abi,
    functionName: 'createBSKT',
    args: [
      params.name,
      params.symbol,
      params.tokens,
      params.weights,
      params.tokenURI,
      params.swapData,
      params.signature,
      params.basketId,
      params.description,
      params.deadline,
    ],
    value: seedWei,
    gas: gasEstimate + (gasEstimate / 10n), // +10% buffer
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  console.log(JSON.stringify({ phase: 'create_bskt', action: 'tx_sent', txHash }));

  // Wait for receipt
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  console.log(JSON.stringify({
    phase: 'create_bskt',
    action: 'tx_confirmed',
    txHash,
    status: receipt.status,
    gasUsed: String(receipt.gasUsed),
    blockNumber: String(receipt.blockNumber),
  }));

  if (receipt.status === 'reverted') {
    throw new Error(`Transaction reverted: ${txHash}`);
  }

  // Extract BSKT address from BSKTCreated event
  const result: CreateBasketResult = {
    txHash,
    receipt,
    gasUsed: receipt.gasUsed,
  };

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: config.abi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === 'BSKTCreated') {
        const args = decoded.args as any;
        result.bsktAddress = args.bskt as Address;
        result.bsktPairAddress = args.bsktPair as Address;
        result.creator = args.creator as Address;
        console.log(JSON.stringify({
          phase: 'create_bskt',
          action: 'bskt_created',
          bsktAddress: result.bsktAddress,
          bsktPairAddress: result.bsktPairAddress,
          creator: result.creator,
        }));
        break;
      }
    } catch {
      // Not our event, skip
    }
  }

  return result;
}

/**
 * Decode calldata for createBSKT — used for MEV analysis of existing transactions.
 */
export function decodeCreateBSKTCalldata(
  config: FactoryConfig,
  calldata: `0x${string}`,
): Record<string, unknown> | null {
  try {
    const decoded = decodeFunctionData({
      abi: config.abi,
      data: calldata,
    });

    if (decoded.functionName !== 'createBSKT') return null;

    const args = decoded.args as readonly unknown[] | undefined;
    if (!args) return null;
    return {
      functionName: 'createBSKT',
      name: args[0],
      symbol: args[1],
      tokens: args[2],
      weights: args[3],
      tokenURI: args[4],
      swapData: args[5],
      signature: args[6],
      basketId: args[7],
      description: args[8],
      deadline: args[9],
    };
  } catch (err: unknown) {
    console.error(JSON.stringify({
      phase: 'decode_calldata',
      error: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}
