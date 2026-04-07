/**
 * Redeem-from-BSKT flow — end-to-end orchestration.
 *
 * Burns LP tokens on the BSKTPair, swaps underlying tokens back to ETH via
 * backend-signed 1inch routes, and verifies the ETH balance increase.
 *
 * withdrawETH() is on the BSKT NFT (beacon proxy), NOT on BSKTPair or factory.
 * Signature: withdrawETH(uint256 _liquidity, bytes[] _swapData, bytes _signature, uint256 _deadline)
 * Emits: WithdrawnETHFromBSKT(address bskt, address indexed sender, uint256 amount)
 * See: K005, bskt-logic-abi.json
 */

import {
  type Address,
  type Hash,
  type TransactionReceipt,
  type WalletClient,
  type Abi,
  encodeFunctionData,
  formatEther,
  decodeEventLog,
  getContract,
} from 'viem';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getWithdrawETHRoutes } from './api.js';
import type { WithdrawETHRoutesResponse, HexString } from './types.js';
import { getLPBalance } from './bskt-pair.js';

// Use loose typing to avoid viem chain-specific PublicClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ABI Loading ────────────────────────────────────────────────────────────

let _bsktLogicAbi: Abi | null = null;

/** Load the BSKT Logic ABI (BasketTokenStandard — the contract with withdrawETH()) */
export function loadBSKTLogicABI(): Abi {
  if (_bsktLogicAbi) return _bsktLogicAbi;
  const abiPath = resolve(__dirname, '../config/bskt-logic-abi.json');
  _bsktLogicAbi = JSON.parse(readFileSync(abiPath, 'utf-8')) as Abi;
  return _bsktLogicAbi;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface RedeemOptions {
  /** Viem public client for Base reads */
  publicClient: AnyPublicClient;
  /** Viem wallet client for signing/sending transactions */
  walletClient: WalletClient;
  /** BSKT NFT contract address (the one with withdrawETH()) */
  bsktAddress: Address;
  /** BSKTPair address for LP balance reads. If not provided, reads from BSKT.bsktPair() */
  bsktPairAddress?: Address;
  /** If true, only fetch routes and estimate gas — don't send the transaction */
  dryRun?: boolean;
}

export interface RedeemResult {
  /** Transaction hash (null if dry run) */
  txHash: Hash | null;
  /** Transaction receipt (null if dry run) */
  receipt: TransactionReceipt | null;
  /** LP balance before redemption */
  lpBalanceBefore: bigint;
  /** LP balance after redemption (same as before if dry run) */
  lpBalanceAfter: bigint;
  /** ETH received from the redemption (0n if dry run) */
  ethReceived: bigint;
  /** Gas used by the transaction (0n if dry run) */
  gasUsed: bigint;
  /** Estimated gas from simulation */
  gasEstimate: bigint;
  /** Signed swap data from the API */
  routeData: {
    swapDataCount: number;
    deadline: number;
  };
}

// ── Logging ────────────────────────────────────────────────────────────────

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'alvara-redeem',
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

// ── Event ABI for parsing WithdrawnETHFromBSKT ─────────────────────────────

const WITHDRAWN_ETH_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'address', name: 'bskt', type: 'address' },
      { indexed: true, internalType: 'address', name: 'sender', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'WithdrawnETHFromBSKT',
    type: 'event',
  },
] as const;

/**
 * Parse WithdrawnETHFromBSKT event from transaction receipt logs.
 * Returns the ETH amount withdrawn, or null if event not found.
 */
function parseWithdrawnETHEvent(receipt: TransactionReceipt): bigint | null {
  for (const receiptLog of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: WITHDRAWN_ETH_EVENT_ABI,
        data: receiptLog.data,
        topics: receiptLog.topics,
      });
      if (decoded.eventName === 'WithdrawnETHFromBSKT') {
        return (decoded.args as any).amount as bigint;
      }
    } catch {
      // Not this event — continue
    }
  }
  return null;
}

// ── Core Flow ──────────────────────────────────────────────────────────────

/**
 * Execute a full redeem-from-BSKT flow:
 * 1. Resolve BSKTPair address (for LP balance tracking)
 * 2. Read LP balance (full amount will be redeemed)
 * 3. Get signed swap routes from Alvara backend API
 * 4. Estimate gas for withdrawETH() call
 * 5. Send the transaction (unless dry run)
 * 6. Wait for confirmation
 * 7. Verify LP balance dropped to 0
 * 8. Compute ETH received from balance delta + event parsing
 *
 * @throws on zero LP balance, API failure, gas estimation failure, or tx revert
 */
export async function redeemBSKTForETH(opts: RedeemOptions): Promise<RedeemResult> {
  const {
    publicClient,
    walletClient,
    bsktAddress,
    dryRun = false,
  } = opts;

  const userAddress = walletClient.account!.address;
  const abi = loadBSKTLogicABI();

  log('redeem', 'start', {
    bskt: bsktAddress,
    dryRun,
  });

  // 1. Resolve BSKTPair address
  let pairAddress: Address;
  if (opts.bsktPairAddress) {
    pairAddress = opts.bsktPairAddress;
  } else {
    log('resolve', 'resolving_bskt_pair', { bskt: bsktAddress });
    pairAddress = await getBSKTPairAddress(publicClient, bsktAddress);
  }
  log('resolve', 'bskt_pair_resolved', { pairAddress });

  // 2. Read LP balance — redeem the full amount
  log('lp_verify', 'reading_balance_before', { pair: pairAddress, user: userAddress });
  const lpBalanceBefore = await getLPBalance(publicClient, pairAddress, userAddress);
  log('lp_verify', 'balance_before', {
    lpBalanceBefore: String(lpBalanceBefore),
    lpBalanceBeforeFormatted: formatEther(lpBalanceBefore),
  });

  if (lpBalanceBefore === 0n) {
    throw new Error(`No LP balance to redeem for BSKT ${bsktAddress} — user ${userAddress} has 0 LP`);
  }

  // 3. Get signed swap routes from Alvara backend
  log('routes', 'fetching_routes', { bskt: bsktAddress, liquidity: String(lpBalanceBefore) });
  const routes: WithdrawETHRoutesResponse = await getWithdrawETHRoutes({
    bsktAddress,
    liquidity: String(lpBalanceBefore),
    chainId: 8453, // Base
    userAddress,
  });
  log('routes', 'routes_received', {
    swapDataCount: routes.swapData.length,
    deadline: routes.deadline,
    hasSignature: !!routes.signature,
  });

  // 4. Estimate gas
  const calldata = encodeFunctionData({
    abi,
    functionName: 'withdrawETH',
    args: [
      lpBalanceBefore,
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
      data: calldata,
    });
    log('gas', 'gas_estimated', { gasEstimate: String(gasEstimate) });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('gas', 'gas_estimation_failed', { error: errMsg.slice(0, 500) });
    throw new Error(`Gas estimation failed for withdrawETH(): ${errMsg.slice(0, 500)}`);
  }

  // If dry run, return here without sending the transaction
  if (dryRun) {
    log('redeem', 'dry_run_complete', {
      gasEstimate: String(gasEstimate),
      gasWithBuffer: String(gasEstimate + gasEstimate / 10n),
    });
    return {
      txHash: null,
      receipt: null,
      lpBalanceBefore,
      lpBalanceAfter: lpBalanceBefore,
      ethReceived: 0n,
      gasUsed: 0n,
      gasEstimate,
      routeData: {
        swapDataCount: routes.swapData.length,
        deadline: routes.deadline,
      },
    };
  }

  // 5. Record ETH balance before tx (for computing delta)
  const ethBefore = (await publicClient.getBalance({ address: userAddress })) as bigint;

  // 6. Send the transaction with 10% gas buffer
  const gasWithBuffer = gasEstimate + gasEstimate / 10n;

  log('tx', 'sending', {
    to: bsktAddress,
    liquidity: String(lpBalanceBefore),
    gas: String(gasWithBuffer),
  });

  const txHash = await walletClient.writeContract({
    address: bsktAddress,
    abi,
    functionName: 'withdrawETH',
    args: [
      lpBalanceBefore,
      routes.swapData as `0x${string}`[],
      routes.signature as `0x${string}`,
      BigInt(routes.deadline),
    ],
    gas: gasWithBuffer,
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  log('tx', 'tx_sent', { txHash });

  // 7. Wait for confirmation
  log('tx', 'waiting_for_receipt', { txHash });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  log('tx', 'confirmed', {
    txHash,
    status: receipt.status,
    gasUsed: String(receipt.gasUsed),
    blockNumber: String(receipt.blockNumber),
  });

  if (receipt.status === 'reverted') {
    throw new Error(`withdrawETH() transaction reverted: ${txHash}`);
  }

  // 8. Parse WithdrawnETHFromBSKT event for ETH amount
  const eventAmount = parseWithdrawnETHEvent(receipt);
  log('verify', 'event_parsed', {
    eventAmount: eventAmount !== null ? String(eventAmount) : 'not_found',
  });

  // 9. Verify LP balance dropped
  log('verify', 'reading_balance_after', { pair: pairAddress, user: userAddress });
  const lpBalanceAfter = await getLPBalance(publicClient, pairAddress, userAddress);
  log('verify', 'balance_after', {
    lpBalanceAfter: String(lpBalanceAfter),
    lpBalanceAfterFormatted: formatEther(lpBalanceAfter),
    lpDecrease: String(lpBalanceBefore - lpBalanceAfter),
  });

  if (lpBalanceAfter > 0n) {
    log('verify', 'warning_lp_not_zero', {
      before: String(lpBalanceBefore),
      after: String(lpBalanceAfter),
    });
    // Don't throw — the tx succeeded, LP might update with a delay
  }

  // 10. Compute ETH received — prefer event data, fall back to balance delta
  let ethReceived: bigint;
  if (eventAmount !== null) {
    ethReceived = eventAmount;
  } else {
    const ethAfter = (await publicClient.getBalance({ address: userAddress })) as bigint;
    ethReceived = ethAfter - ethBefore;
    log('verify', 'eth_from_balance_delta', {
      ethBefore: String(ethBefore),
      ethAfter: String(ethAfter),
      ethReceived: String(ethReceived),
    });
  }

  log('redeem', 'complete', {
    txHash,
    gasUsed: String(receipt.gasUsed),
    ethReceived: String(ethReceived),
    ethReceivedFormatted: formatEther(ethReceived),
    lpBurned: String(lpBalanceBefore - lpBalanceAfter),
  });

  return {
    txHash,
    receipt,
    lpBalanceBefore,
    lpBalanceAfter,
    ethReceived,
    gasUsed: receipt.gasUsed,
    gasEstimate,
    routeData: {
      swapDataCount: routes.swapData.length,
      deadline: routes.deadline,
    },
  };
}
