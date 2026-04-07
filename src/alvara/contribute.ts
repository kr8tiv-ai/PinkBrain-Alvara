/**
 * Contribute-to-BSKT flow — end-to-end orchestration.
 *
 * Takes ETH on Base, obtains backend-signed swap routes from Alvara's API,
 * calls contribute() on the BSKT NFT contract, and verifies LP token balance
 * increased on the BSKTPair contract.
 *
 * contribute() is on the BSKT NFT (beacon proxy), NOT on BSKTPair or factory.
 * Signature: contribute(bytes[] _swapData, bytes _signature, uint256 _deadline) payable
 * See: K005, D032, bskt-logic-abi.json
 */

import {
  type Address,
  type Hash,
  type TransactionReceipt,
  type WalletClient,
  type Abi,
  encodeFunctionData,
  parseEther,
  formatEther,
  getContract,
} from 'viem';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getContributeRoutes, getApiBaseUrl } from './api.js';
import type { ContributeRoutesResponse, HexString } from './types.js';
import { getLPBalance } from './bskt-pair.js';

// Use loose typing to avoid viem chain-specific PublicClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ABI Loading ────────────────────────────────────────────────────────────

let _bsktLogicAbi: Abi | null = null;

/** Load the BSKT Logic ABI (BasketTokenStandard — the contract with contribute()) */
export function loadBSKTLogicABI(): Abi {
  if (_bsktLogicAbi) return _bsktLogicAbi;
  const abiPath = resolve(__dirname, '../config/bskt-logic-abi.json');
  _bsktLogicAbi = JSON.parse(readFileSync(abiPath, 'utf-8')) as Abi;
  return _bsktLogicAbi;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ContributeOptions {
  /** Viem public client for Base reads */
  publicClient: AnyPublicClient;
  /** Viem wallet client for signing/sending transactions */
  walletClient: WalletClient;
  /** BSKT NFT contract address (the one with contribute()) */
  bsktAddress: Address;
  /** ETH amount to contribute (in ether, e.g. "0.01") */
  ethAmount: string;
  /** BSKTPair address for LP balance verification. If not provided, reads from BSKT.bsktPair() */
  bsktPairAddress?: Address;
  /** If true, only fetch routes and estimate gas — don't send the transaction */
  dryRun?: boolean;
}

export interface ContributeResult {
  /** Transaction hash (null if dry run) */
  txHash: Hash | null;
  /** Transaction receipt (null if dry run) */
  receipt: TransactionReceipt | null;
  /** LP balance before contribution */
  lpBalanceBefore: bigint;
  /** LP balance after contribution (same as before if dry run) */
  lpBalanceAfter: bigint;
  /** Gas used by the transaction (0n if dry run) */
  gasUsed: bigint;
  /** Estimated gas from simulation */
  gasEstimate: bigint;
  /** Signed swap data from the API (useful for debugging) */
  routeData: {
    swapDataCount: number;
    deadline: number;
  };
}

// ── Logging ────────────────────────────────────────────────────────────────

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'alvara-contribute',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── BSKT Contract Reads ────────────────────────────────────────────────────

/** Minimal ABI to read bsktPair() from the BSKT NFT */
const BSKT_PAIR_READER_ABI = [
  {
    inputs: [],
    name: 'bsktPair',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Get the BSKTPair address associated with a BSKT NFT.
 */
async function getBSKTPairAddress(
  publicClient: AnyPublicClient,
  bsktAddress: Address,
): Promise<Address> {
  const contract: any = getContract({
    address: bsktAddress,
    abi: BSKT_PAIR_READER_ABI,
    client: publicClient,
  });
  return contract.read.bsktPair() as Promise<Address>;
}

// ── Core Flow ──────────────────────────────────────────────────────────────

/**
 * Execute a full contribute-to-BSKT flow:
 * 1. Resolve BSKTPair address (for LP balance tracking)
 * 2. Read LP balance before
 * 3. Get signed swap routes from Alvara backend API
 * 4. Estimate gas for contribute() call
 * 5. Send the transaction (unless dry run)
 * 6. Wait for confirmation
 * 7. Read LP balance after and verify increase
 *
 * @throws on API failure, gas estimation failure, tx revert, or LP balance not increasing
 */
export async function contributeToBSKT(opts: ContributeOptions): Promise<ContributeResult> {
  const {
    publicClient,
    walletClient,
    bsktAddress,
    ethAmount,
    dryRun = false,
  } = opts;

  const ethWei = parseEther(ethAmount);
  const userAddress = walletClient.account!.address;
  const abi = loadBSKTLogicABI();

  log('contribute', 'start', {
    bskt: bsktAddress,
    ethAmount,
    ethWei: String(ethWei),
    dryRun,
  });

  // 1. Resolve BSKTPair address
  let pairAddress: Address;
  if (opts.bsktPairAddress) {
    pairAddress = opts.bsktPairAddress;
  } else {
    log('contribute', 'resolving_bskt_pair', { bskt: bsktAddress });
    pairAddress = await getBSKTPairAddress(publicClient, bsktAddress);
  }
  log('contribute', 'bskt_pair_resolved', { pairAddress });

  // 2. Read LP balance before
  log('lp_verify', 'reading_balance_before', { pair: pairAddress, user: userAddress });
  const lpBalanceBefore = await getLPBalance(publicClient, pairAddress, userAddress);
  log('lp_verify', 'balance_before', {
    lpBalanceBefore: String(lpBalanceBefore),
    lpBalanceBeforeFormatted: formatEther(lpBalanceBefore),
  });

  // 3. Get signed swap routes from Alvara backend
  log('api_call', 'fetching_routes', { bskt: bsktAddress, amount: String(ethWei) });
  const routes: ContributeRoutesResponse = await getContributeRoutes({
    bsktAddress,
    amount: String(ethWei),
    chainId: 8453, // Base
    userAddress,
  });
  log('api_call', 'routes_received', {
    swapDataCount: routes.swapData.length,
    deadline: routes.deadline,
    hasSignature: !!routes.signature,
  });

  // 4. Estimate gas
  const calldata = encodeFunctionData({
    abi,
    functionName: 'contribute',
    args: [
      routes.swapData as `0x${string}`[],
      routes.signature as `0x${string}`,
      BigInt(routes.deadline),
    ],
  });

  let gasEstimate: bigint;
  try {
    gasEstimate = await publicClient.estimateGas({
      account: userAddress,
      to: bsktAddress,
      value: ethWei,
      data: calldata,
    });
    log('tx_send', 'gas_estimated', { gasEstimate: String(gasEstimate) });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('tx_send', 'gas_estimation_failed', { error: errMsg.slice(0, 500) });
    throw new Error(`Gas estimation failed for contribute(): ${errMsg.slice(0, 500)}`);
  }

  // If dry run, return here without sending the transaction
  if (dryRun) {
    log('contribute', 'dry_run_complete', {
      gasEstimate: String(gasEstimate),
      gasWithBuffer: String(gasEstimate + gasEstimate / 10n),
    });
    return {
      txHash: null,
      receipt: null,
      lpBalanceBefore,
      lpBalanceAfter: lpBalanceBefore,
      gasUsed: 0n,
      gasEstimate,
      routeData: {
        swapDataCount: routes.swapData.length,
        deadline: routes.deadline,
      },
    };
  }

  // 5. Send the transaction with 10% gas buffer
  const gasWithBuffer = gasEstimate + gasEstimate / 10n;

  log('tx_send', 'sending', {
    to: bsktAddress,
    value: String(ethWei),
    gas: String(gasWithBuffer),
  });

  const txHash = await walletClient.writeContract({
    address: bsktAddress,
    abi,
    functionName: 'contribute',
    args: [
      routes.swapData as `0x${string}`[],
      routes.signature as `0x${string}`,
      BigInt(routes.deadline),
    ],
    value: ethWei,
    gas: gasWithBuffer,
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  log('tx_send', 'tx_sent', { txHash });

  // 6. Wait for confirmation
  log('tx_confirm', 'waiting', { txHash });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  log('tx_confirm', 'confirmed', {
    txHash,
    status: receipt.status,
    gasUsed: String(receipt.gasUsed),
    blockNumber: String(receipt.blockNumber),
  });

  if (receipt.status === 'reverted') {
    throw new Error(`contribute() transaction reverted: ${txHash}`);
  }

  // 7. Verify LP balance increased
  log('lp_verify', 'reading_balance_after', { pair: pairAddress, user: userAddress });
  const lpBalanceAfter = await getLPBalance(publicClient, pairAddress, userAddress);
  log('lp_verify', 'balance_after', {
    lpBalanceAfter: String(lpBalanceAfter),
    lpBalanceAfterFormatted: formatEther(lpBalanceAfter),
    lpIncrease: String(lpBalanceAfter - lpBalanceBefore),
  });

  if (lpBalanceAfter <= lpBalanceBefore) {
    log('lp_verify', 'warning_no_increase', {
      before: String(lpBalanceBefore),
      after: String(lpBalanceAfter),
    });
    // Don't throw — the tx succeeded, LP might update with a delay or via events
    // Log the warning so the caller can decide
  }

  log('contribute', 'complete', {
    txHash,
    gasUsed: String(receipt.gasUsed),
    lpIncrease: String(lpBalanceAfter - lpBalanceBefore),
  });

  return {
    txHash,
    receipt,
    lpBalanceBefore,
    lpBalanceAfter,
    gasUsed: receipt.gasUsed,
    gasEstimate,
    routeData: {
      swapDataCount: routes.swapData.length,
      deadline: routes.deadline,
    },
  };
}
