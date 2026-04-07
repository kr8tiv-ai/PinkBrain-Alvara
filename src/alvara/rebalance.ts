/**
 * Rebalance-BSKT flow — end-to-end orchestration.
 *
 * Changes the token allocation of an existing BSKT. Manager-only operation:
 * verifies wallet is the BSKT owner before any API/gas work. Obtains
 * backend-signed swap routes, calls rebalance() on the BSKT NFT, and
 * parses the BSKTRebalanced event from the receipt logs.
 *
 * rebalance() is on the BSKT NFT (beacon proxy), same as contribute().
 * Signature: rebalance(address[] _newTokens, uint256[] _newWeights,
 *   uint256[] _amountIn, bytes[] _swapData, bytes _signature,
 *   uint256 _deadline, uint8 _mode)
 *
 * See: K005, K006, bskt-logic-abi.json
 */

import {
  type Address,
  type Hash,
  type TransactionReceipt,
  type WalletClient,
  type Abi,
  encodeFunctionData,
  decodeEventLog,
  getAddress,
} from 'viem';

import { loadBSKTLogicABI } from './contribute.js';
import { getRebalanceRoutes } from './api.js';
import type { RebalanceRoutesResponse, HexString } from './types.js';
import { getConstituents, getOwner } from './erc7621.js';
import { getLPBalance } from './bskt-pair.js';

// Use loose typing to avoid viem chain-specific PublicClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

// ── Rebalance Mode Enum ────────────────────────────────────────────────────

/** On-chain enum IBSKT.RebalanceMode */
export enum RebalanceMode {
  /** Standard rebalance — swap between constituents */
  STANDARD = 0,
  /** Emergency stables — convert to stablecoins */
  EMERGENCY_STABLES = 1,
  /** Revert emergency — restore original composition */
  REVERT_EMERGENCY = 2,
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface RebalanceOptions {
  /** Viem public client for Base reads */
  publicClient: AnyPublicClient;
  /** Viem wallet client for signing/sending transactions */
  walletClient: WalletClient;
  /** BSKT NFT contract address */
  bsktAddress: Address;
  /** New token addresses for the rebalanced composition */
  newTokens: Address[];
  /** New weights per token (basis points, must sum to 10000) */
  newWeights: number[];
  /** Amounts to swap per token (in token units, as strings) */
  amountIn: string[];
  /** Rebalance mode — default STANDARD (0) */
  mode?: RebalanceMode;
  /** BSKTPair address for LP balance verification. If not provided, reads from BSKT.bsktPair() */
  bsktPairAddress?: Address;
  /** If true, only fetch routes and estimate gas — don't send the transaction */
  dryRun?: boolean;
}

/** Decoded BSKTRebalanced event data */
export interface BSKTRebalancedEvent {
  bskt: Address;
  oldTokens: Address[];
  oldWeights: bigint[];
  newTokens: Address[];
  newWeights: bigint[];
  mode: number;
}

export interface RebalanceResult {
  /** Transaction hash (null if dry run) */
  txHash: Hash | null;
  /** Transaction receipt (null if dry run) */
  receipt: TransactionReceipt | null;
  /** Old token addresses before rebalance */
  oldTokens: Address[];
  /** Old weights before rebalance */
  oldWeights: bigint[];
  /** New token addresses after rebalance */
  newTokens: Address[];
  /** New weights after rebalance (as submitted) */
  newWeights: number[];
  /** Gas used by the transaction (0n if dry run) */
  gasUsed: bigint;
  /** Estimated gas from simulation */
  gasEstimate: bigint;
  /** Decoded BSKTRebalanced event (null if not found or dry run) */
  event: BSKTRebalancedEvent | null;
  /** LP balance before rebalance */
  lpBalanceBefore: bigint;
  /** LP balance after rebalance (same as before if dry run) */
  lpBalanceAfter: bigint;
  /** Signed route data summary */
  routeData: {
    swapDataCount: number;
    deadline: number;
  };
}

// ── Logging ────────────────────────────────────────────────────────────────

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'alvara-rebalance',
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

async function getBSKTPairAddress(
  publicClient: AnyPublicClient,
  bsktAddress: Address,
): Promise<Address> {
  const { getContract } = await import('viem');
  const contract: any = getContract({
    address: bsktAddress,
    abi: BSKT_PAIR_READER_ABI,
    client: publicClient,
  });
  return contract.read.bsktPair() as Promise<Address>;
}

// ── Event Parsing ──────────────────────────────────────────────────────────

/**
 * Parse BSKTRebalanced event from transaction receipt logs.
 * Returns null if the event is not found (logs a warning, does NOT throw).
 */
function parseBSKTRebalancedEvent(
  receipt: TransactionReceipt,
  abi: Abi,
): BSKTRebalancedEvent | null {
  for (const eventLog of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi,
        data: eventLog.data,
        topics: eventLog.topics,
      });
      if (decoded.eventName === 'BSKTRebalanced') {
        const args = decoded.args as any;
        return {
          bskt: args.bskt as Address,
          oldTokens: args.oldTokens as Address[],
          oldWeights: args.oldWeights as bigint[],
          newTokens: args.newTokens as Address[],
          newWeights: args.newWeights as bigint[],
          mode: Number(args.mode),
        };
      }
    } catch {
      // Not this event — try next log
      continue;
    }
  }
  return null;
}

// ── Core Flow ──────────────────────────────────────────────────────────────

/**
 * Execute a full rebalance-BSKT flow:
 * 1. Read current composition (getConstituents)
 * 2. Check ownership — rebalance is manager-only
 * 3. Resolve BSKTPair and read LP balance before
 * 4. Get signed swap routes from Alvara backend API
 * 5. Estimate gas for rebalance() call
 * 6. Send the transaction (unless dry run)
 * 7. Wait for confirmation and parse BSKTRebalanced event
 * 8. Verify LP balance not destroyed
 *
 * @throws on owner mismatch, API failure, gas estimation failure, or tx revert
 */
export async function rebalanceBSKT(opts: RebalanceOptions): Promise<RebalanceResult> {
  const {
    publicClient,
    walletClient,
    bsktAddress,
    newTokens,
    newWeights,
    amountIn,
    mode = RebalanceMode.STANDARD,
    dryRun = false,
  } = opts;

  const userAddress = walletClient.account!.address;
  const abi = loadBSKTLogicABI();

  log('rebalance', 'start', {
    bskt: bsktAddress,
    newTokensCount: newTokens.length,
    mode,
    dryRun,
  });

  // 1. Read current composition
  log('pre_check', 'reading_constituents', { bskt: bsktAddress });
  const currentComposition = await getConstituents(publicClient, bsktAddress);
  const oldTokens = currentComposition.tokens;
  const oldWeights = currentComposition.weights;
  log('pre_check', 'constituents_read', {
    tokenCount: oldTokens.length,
    totalWeight: String(oldWeights.reduce((sum, w) => sum + w, 0n)),
  });

  // 2. Ownership check — BEFORE any API call or gas estimation
  log('pre_check', 'verifying_ownership', { bskt: bsktAddress, wallet: userAddress });
  const owner = await getOwner(publicClient, bsktAddress);
  if (getAddress(owner) !== getAddress(userAddress)) {
    const errMsg = `Rebalance failed: wallet ${userAddress} is not the BSKT owner. Owner is ${owner}`;
    log('pre_check', 'owner_mismatch', { owner, wallet: userAddress });
    throw new Error(errMsg);
  }
  log('pre_check', 'ownership_confirmed', { owner });

  // 3. Resolve BSKTPair and read LP balance before
  let pairAddress: Address;
  if (opts.bsktPairAddress) {
    pairAddress = opts.bsktPairAddress;
  } else {
    log('pre_check', 'resolving_bskt_pair', { bskt: bsktAddress });
    pairAddress = await getBSKTPairAddress(publicClient, bsktAddress);
  }
  log('lp_verify', 'reading_balance_before', { pair: pairAddress, user: userAddress });
  const lpBalanceBefore = await getLPBalance(publicClient, pairAddress, userAddress);
  log('lp_verify', 'balance_before', { lpBalanceBefore: String(lpBalanceBefore) });

  // 4. Get signed swap routes from Alvara backend
  log('api_call', 'fetching_routes', { bskt: bsktAddress, mode });
  const routes: RebalanceRoutesResponse = await getRebalanceRoutes({
    bsktAddress,
    newTokens,
    newWeights,
    amountIn,
    chainId: 8453, // Base
    userAddress,
    mode,
  });
  log('api_call', 'routes_received', {
    swapDataCount: routes.swapData.length,
    deadline: routes.deadline,
    hasSignature: !!routes.signature,
  });

  // 5. Estimate gas
  const calldata = encodeFunctionData({
    abi,
    functionName: 'rebalance',
    args: [
      newTokens,
      newWeights.map(w => BigInt(w)),
      amountIn.map(a => BigInt(a)),
      routes.swapData as `0x${string}`[],
      routes.signature as `0x${string}`,
      BigInt(routes.deadline),
      mode,
    ],
  });

  let gasEstimate: bigint;
  try {
    gasEstimate = await publicClient.estimateGas({
      account: userAddress,
      to: bsktAddress,
      data: calldata,
    });
    log('tx_send', 'gas_estimated', { gasEstimate: String(gasEstimate) });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('tx_send', 'gas_estimation_failed', { error: errMsg.slice(0, 500) });
    throw new Error(`Gas estimation failed for rebalance(): ${errMsg.slice(0, 500)}`);
  }

  // Dry run — return without sending
  if (dryRun) {
    log('rebalance', 'dry_run_complete', {
      gasEstimate: String(gasEstimate),
      gasWithBuffer: String(gasEstimate + gasEstimate / 10n),
    });
    return {
      txHash: null,
      receipt: null,
      oldTokens,
      oldWeights,
      newTokens,
      newWeights,
      gasUsed: 0n,
      gasEstimate,
      event: null,
      lpBalanceBefore,
      lpBalanceAfter: lpBalanceBefore,
      routeData: {
        swapDataCount: routes.swapData.length,
        deadline: routes.deadline,
      },
    };
  }

  // 6. Send the transaction with 10% gas buffer
  const gasWithBuffer = gasEstimate + gasEstimate / 10n;

  log('tx_send', 'sending', {
    to: bsktAddress,
    gas: String(gasWithBuffer),
    mode,
  });

  const txHash = await walletClient.writeContract({
    address: bsktAddress,
    abi,
    functionName: 'rebalance',
    args: [
      newTokens,
      newWeights.map(w => BigInt(w)),
      amountIn.map(a => BigInt(a)),
      routes.swapData as `0x${string}`[],
      routes.signature as `0x${string}`,
      BigInt(routes.deadline),
      mode,
    ],
    gas: gasWithBuffer,
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  log('tx_send', 'tx_sent', { txHash });

  // 7. Wait for confirmation and parse event
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
    throw new Error(`rebalance() transaction reverted: ${txHash}`);
  }

  // Parse BSKTRebalanced event
  const event = parseBSKTRebalancedEvent(receipt, abi);
  if (event) {
    log('event', 'bskt_rebalanced_parsed', {
      bskt: event.bskt,
      oldTokenCount: event.oldTokens.length,
      newTokenCount: event.newTokens.length,
      mode: event.mode,
    });
  } else {
    log('event', 'bskt_rebalanced_not_found', {
      logCount: receipt.logs.length,
      warning: 'BSKTRebalanced event not found in receipt logs',
    });
  }

  // 8. Read LP balance after and check it wasn't destroyed
  log('lp_verify', 'reading_balance_after', { pair: pairAddress, user: userAddress });
  const lpBalanceAfter = await getLPBalance(publicClient, pairAddress, userAddress);
  log('lp_verify', 'balance_after', {
    lpBalanceBefore: String(lpBalanceBefore),
    lpBalanceAfter: String(lpBalanceAfter),
  });

  if (lpBalanceAfter === 0n && lpBalanceBefore > 0n) {
    log('lp_verify', 'warning_lp_destroyed', {
      before: String(lpBalanceBefore),
      after: String(lpBalanceAfter),
    });
    // Warning, not error — caller decides how to handle
  }

  log('rebalance', 'complete', {
    txHash,
    gasUsed: String(receipt.gasUsed),
    eventFound: !!event,
  });

  return {
    txHash,
    receipt,
    oldTokens,
    oldWeights,
    newTokens,
    newWeights,
    gasUsed: receipt.gasUsed,
    gasEstimate,
    event,
    lpBalanceBefore,
    lpBalanceAfter,
    routeData: {
      swapDataCount: routes.swapData.length,
      deadline: routes.deadline,
    },
  };
}
