/**
 * Emergency stables conversion and revert for Alvara BSKTs.
 *
 * Wraps rebalanceBSKT() with emergency-specific logic:
 * - emergencyStables(): snapshot current composition → rebalance to ~95% USDT + 5% ALVA
 * - emergencyRevert(): restore original composition from a prior snapshot
 *
 * Both functions delegate to rebalanceBSKT() with the appropriate RebalanceMode.
 * State is parameter-based (in-memory) — S05 will persist snapshots to DB later.
 *
 * See: K005 (backend-signed routes), K006 (5% ALVA minimum)
 */

import type { Address, WalletClient } from 'viem';

import {
  rebalanceBSKT,
  RebalanceMode,
  type RebalanceResult,
} from './rebalance.js';
import { getConstituents, type ConstituentInfo } from './erc7621.js';
import { KNOWN_ADDRESSES } from '../config/chains.js';

// Use loose typing to avoid viem chain-specific PublicClient generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;

// ── Constants ──────────────────────────────────────────────────────────────

/** Emergency target: 95% USDT allocation (basis points) */
export const EMERGENCY_USDT_WEIGHT = 9500;

/** Emergency target: 5% ALVA allocation (basis points) */
export const EMERGENCY_ALVA_WEIGHT = 500;

/** Total basis points — weights must sum to this */
const TOTAL_BPS = 10000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface EmergencyStablesOptions {
  /** Viem public client for Base reads */
  publicClient: AnyPublicClient;
  /** Viem wallet client for signing/sending transactions */
  walletClient: WalletClient;
  /** BSKT NFT contract address */
  bsktAddress: Address;
  /** Amounts to swap per target token [USDT amount, ALVA amount] as strings. Defaults to ['0','0']. */
  amountIn?: string[];
  /** BSKTPair address for LP balance verification (optional — reads from BSKT if not provided) */
  bsktPairAddress?: Address;
  /** If true, only fetch routes and estimate gas — don't send the transaction */
  dryRun?: boolean;
}

export interface EmergencyRevertOptions {
  /** Viem public client for Base reads */
  publicClient: AnyPublicClient;
  /** Viem wallet client for signing/sending transactions */
  walletClient: WalletClient;
  /** BSKT NFT contract address */
  bsktAddress: Address;
  /** Original composition snapshot from emergencyStables() to restore */
  snapshot: ConstituentInfo;
  /** Amounts to swap per original token as strings. Defaults to array of '0's matching snapshot length. */
  amountIn?: string[];
  /** BSKTPair address for LP balance verification (optional) */
  bsktPairAddress?: Address;
  /** If true, only fetch routes and estimate gas — don't send the transaction */
  dryRun?: boolean;
}

export interface EmergencyStablesResult {
  /** Snapshot of original composition before emergency conversion */
  snapshot: ConstituentInfo;
  /** Result from the rebalance transaction */
  rebalanceResult: RebalanceResult;
}

// ── Logging ────────────────────────────────────────────────────────────────

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'alvara-emergency',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── Emergency Stables ──────────────────────────────────────────────────────

/**
 * Convert a BSKT to emergency stables: ~95% USDT + 5% ALVA.
 *
 * 1. Read current composition → store as snapshot
 * 2. Build emergency target [USDT, ALVA] with [9500, 500] bps
 * 3. Call rebalanceBSKT() with EMERGENCY_STABLES mode
 * 4. Validate event shows expected target tokens
 * 5. Return { snapshot, rebalanceResult }
 *
 * @throws if current composition is empty, weights don't sum to 10000, or rebalance fails
 */
export async function emergencyStables(
  opts: EmergencyStablesOptions,
): Promise<EmergencyStablesResult> {
  const {
    publicClient,
    walletClient,
    bsktAddress,
    amountIn = ['0', '0'],
    bsktPairAddress,
    dryRun = false,
  } = opts;

  log('emergency_stables', 'start', { bskt: bsktAddress, dryRun });

  // 1. Read current composition and snapshot it
  log('emergency_stables', 'reading_composition', { bskt: bsktAddress });
  const snapshot = await getConstituents(publicClient, bsktAddress);

  if (snapshot.tokens.length === 0) {
    const msg = 'Emergency stables failed: BSKT has no constituents';
    log('emergency_stables', 'empty_composition', { bskt: bsktAddress });
    throw new Error(msg);
  }

  log('emergency_stables', 'composition_snapshot', {
    tokenCount: snapshot.tokens.length,
    totalWeight: String(snapshot.weights.reduce((sum, w) => sum + w, 0n)),
  });

  // 2. Build emergency target
  const newTokens: Address[] = [
    KNOWN_ADDRESSES.USDT,
    KNOWN_ADDRESSES.ALVA,
  ];
  const newWeights: number[] = [
    EMERGENCY_USDT_WEIGHT,
    EMERGENCY_ALVA_WEIGHT,
  ];

  // Sanity check — weights must sum to 10000
  const weightSum = newWeights.reduce((sum, w) => sum + w, 0);
  if (weightSum !== TOTAL_BPS) {
    throw new Error(
      `Emergency weights sum to ${weightSum}, expected ${TOTAL_BPS}. ` +
      `USDT=${EMERGENCY_USDT_WEIGHT}, ALVA=${EMERGENCY_ALVA_WEIGHT}`,
    );
  }

  log('emergency_stables', 'target_computed', {
    tokens: newTokens,
    weights: newWeights,
    weightSum,
  });

  // 3. Call rebalanceBSKT with EMERGENCY_STABLES mode
  const rebalanceResult = await rebalanceBSKT({
    publicClient,
    walletClient,
    bsktAddress,
    newTokens,
    newWeights,
    amountIn,
    mode: RebalanceMode.EMERGENCY_STABLES,
    bsktPairAddress,
    dryRun,
  });

  // 4. Validate event shows expected target tokens (non-dry-run only)
  if (!dryRun && rebalanceResult.event) {
    const eventTokens = rebalanceResult.event.newTokens.map(t => t.toLowerCase());
    const expectedTokens = newTokens.map(t => t.toLowerCase());
    const tokensMatch = expectedTokens.every(t => eventTokens.includes(t));

    if (!tokensMatch) {
      log('emergency_stables', 'warning_token_mismatch', {
        expected: expectedTokens,
        actual: eventTokens,
      });
    } else {
      log('emergency_stables', 'event_validated', {
        newTokenCount: eventTokens.length,
        mode: rebalanceResult.event.mode,
      });
    }
  }

  log('emergency_stables', 'complete', {
    dryRun,
    txHash: rebalanceResult.txHash,
    snapshotTokenCount: snapshot.tokens.length,
  });

  return { snapshot, rebalanceResult };
}

// ── Emergency Revert ───────────────────────────────────────────────────────

/**
 * Revert a BSKT from emergency stables back to its original composition.
 *
 * 1. Validate snapshot has at least one token
 * 2. Convert snapshot weights from bigint to number[]
 * 3. Call rebalanceBSKT() with REVERT_EMERGENCY mode
 * 4. Validate event shows restoration
 * 5. Return RebalanceResult
 *
 * @throws if snapshot is empty or has no tokens, or rebalance fails
 */
export async function emergencyRevert(
  opts: EmergencyRevertOptions,
): Promise<RebalanceResult> {
  const {
    publicClient,
    walletClient,
    bsktAddress,
    snapshot,
    bsktPairAddress,
    dryRun = false,
  } = opts;

  log('emergency_revert', 'start', { bskt: bsktAddress, dryRun });

  // 1. Validate snapshot
  if (!snapshot || !snapshot.tokens || snapshot.tokens.length === 0) {
    const msg = 'Emergency revert failed: snapshot has no tokens — cannot restore composition';
    log('emergency_revert', 'invalid_snapshot', { bskt: bsktAddress });
    throw new Error(msg);
  }

  if (snapshot.tokens.length !== snapshot.weights.length) {
    const msg = `Emergency revert failed: snapshot tokens/weights length mismatch (${snapshot.tokens.length} vs ${snapshot.weights.length})`;
    log('emergency_revert', 'snapshot_mismatch', {
      tokens: snapshot.tokens.length,
      weights: snapshot.weights.length,
    });
    throw new Error(msg);
  }

  log('emergency_revert', 'snapshot_validated', {
    tokenCount: snapshot.tokens.length,
    totalWeight: String(snapshot.weights.reduce((sum, w) => sum + w, 0n)),
  });

  // 2. Convert snapshot weights from bigint to number (basis points fit in number)
  const newWeights = snapshot.weights.map(w => Number(w));

  // Default amountIn to zeros matching snapshot length
  const amountIn = opts.amountIn ?? snapshot.tokens.map(() => '0');

  // 3. Call rebalanceBSKT with REVERT_EMERGENCY mode
  const result = await rebalanceBSKT({
    publicClient,
    walletClient,
    bsktAddress,
    newTokens: snapshot.tokens,
    newWeights,
    amountIn,
    mode: RebalanceMode.REVERT_EMERGENCY,
    bsktPairAddress,
    dryRun,
  });

  // 4. Validate event shows restoration (non-dry-run only)
  if (!dryRun && result.event) {
    const eventTokens = result.event.newTokens.map(t => t.toLowerCase());
    const snapshotTokens = snapshot.tokens.map(t => t.toLowerCase());
    const tokensMatch = snapshotTokens.every(t => eventTokens.includes(t));

    if (!tokensMatch) {
      log('emergency_revert', 'warning_token_mismatch', {
        expected: snapshotTokens,
        actual: eventTokens,
      });
    } else {
      log('emergency_revert', 'event_validated', {
        restoredTokenCount: eventTokens.length,
        mode: result.event.mode,
      });
    }
  }

  log('emergency_revert', 'complete', {
    dryRun,
    txHash: result.txHash,
    restoredTokenCount: snapshot.tokens.length,
  });

  return result;
}
