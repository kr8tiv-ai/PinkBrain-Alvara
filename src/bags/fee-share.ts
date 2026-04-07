/**
 * Fee share admin operations — query admin status, claimable positions, and update config.
 * Wraps BagsSDK.feeShareAdmin and BagsSDK.fee services with input validation,
 * structured logging, and client-side basis points validation.
 */

import { PublicKey } from '@solana/web3.js';
import type { BagsSDK } from '@bagsfm/bags-sdk';
import type { BagsFeeClaimer, UpdateFeeShareConfigParams } from '@bagsfm/bags-sdk';
import { log } from './client.js';
import type { BagsFeeShareUpdateConfig } from './types.js';

/** Base58 alphabet — 32-44 chars, no 0/O/I/l */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function validateWallet(wallet: string, fn: string): void {
  if (!wallet || wallet.trim().length === 0) {
    throw new Error(`${fn}: wallet address is required`);
  }
  if (!BASE58_RE.test(wallet.trim())) {
    throw new Error(`${fn}: invalid wallet address format — expected base58`);
  }
}

function validateMint(mint: string, fn: string): void {
  if (!mint || mint.trim().length === 0) {
    throw new Error(`${fn}: token mint address is required`);
  }
  if (!BASE58_RE.test(mint.trim())) {
    throw new Error(`${fn}: invalid token mint format — expected base58`);
  }
}

/**
 * Get all token mints where the given wallet is fee share admin.
 * Wraps `sdk.feeShareAdmin.getAdminTokenMints()`.
 *
 * @returns Array of token mint addresses (base58 strings)
 */
export async function getAdminTokenList(
  sdk: BagsSDK,
  wallet: string
): Promise<string[]> {
  validateWallet(wallet, 'getAdminTokenList');

  log('fee-share', 'getAdminTokenList:start', { wallet });

  try {
    const mints = await sdk.feeShareAdmin.getAdminTokenMints(
      new PublicKey(wallet)
    );
    log('fee-share', 'getAdminTokenList:ok', { wallet, count: mints.length });
    return mints;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('fee-share', 'getAdminTokenList:error', { wallet, error: message });
    throw new Error(
      `getAdminTokenList failed for wallet ${wallet}: ${message}`
    );
  }
}

/**
 * Get all claimable fee positions for a wallet.
 * Wraps `sdk.fee.getAllClaimablePositions()`.
 *
 * @returns Array of BagsClaimablePosition objects from the SDK
 */
export async function getClaimablePositions(sdk: BagsSDK, wallet: string) {
  validateWallet(wallet, 'getClaimablePositions');

  log('fee-share', 'getClaimablePositions:start', { wallet });

  try {
    const positions = await sdk.fee.getAllClaimablePositions(
      new PublicKey(wallet)
    );
    log('fee-share', 'getClaimablePositions:ok', {
      wallet,
      count: positions.length,
    });
    return positions;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('fee-share', 'getClaimablePositions:error', {
      wallet,
      error: message,
    });
    throw new Error(
      `getClaimablePositions failed for wallet ${wallet}: ${message}`
    );
  }
}

/**
 * Build transactions to update fee share config (claimer list + basis points).
 * Validates basisPointsArray sums to 10000 **before** calling the SDK.
 * Wraps `sdk.feeShareAdmin.getUpdateConfigTransactions()`.
 *
 * @returns Array of { transaction: VersionedTransaction, blockhash } from the SDK
 */
export async function buildUpdateConfigTransaction(
  sdk: BagsSDK,
  config: BagsFeeShareUpdateConfig
) {
  const fn = 'buildUpdateConfigTransaction';

  validateMint(config.baseMint, fn);
  validateWallet(config.payer, fn);

  if (!config.claimersArray || config.claimersArray.length === 0) {
    throw new Error(`${fn}: claimersArray must not be empty`);
  }
  if (!config.basisPointsArray || config.basisPointsArray.length === 0) {
    throw new Error(`${fn}: basisPointsArray must not be empty`);
  }
  if (config.claimersArray.length !== config.basisPointsArray.length) {
    throw new Error(
      `${fn}: claimersArray length (${config.claimersArray.length}) must match basisPointsArray length (${config.basisPointsArray.length})`
    );
  }

  // Validate each claimer address
  for (const claimer of config.claimersArray) {
    validateWallet(claimer, `${fn}.claimersArray`);
  }

  // Client-side basis points validation — enforced before any API call
  const bpsSum = config.basisPointsArray.reduce((a, b) => a + b, 0);
  if (bpsSum !== 10_000) {
    throw new Error(
      `${fn}: basisPointsArray must sum to 10000, got ${bpsSum}`
    );
  }

  log('fee-share', 'buildUpdateConfig:start', {
    baseMint: config.baseMint,
    payer: config.payer,
    claimersCount: config.claimersArray.length,
  });

  // Convert string addresses to SDK's PublicKey-based params
  const feeClaimers: BagsFeeClaimer[] = config.claimersArray.map((addr, i) => ({
    user: new PublicKey(addr),
    userBps: config.basisPointsArray[i],
  }));

  const params: UpdateFeeShareConfigParams = {
    feeClaimers,
    payer: new PublicKey(config.payer),
    baseMint: new PublicKey(config.baseMint),
    ...(config.additionalLookupTables?.length && {
      additionalLookupTables: config.additionalLookupTables.map(
        (a) => new PublicKey(a)
      ),
    }),
  };

  try {
    const results = await sdk.feeShareAdmin.getUpdateConfigTransactions(params);
    log('fee-share', 'buildUpdateConfig:ok', {
      transactionCount: results.length,
    });
    return results;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('fee-share', 'buildUpdateConfig:error', { error: message });
    throw new Error(`${fn} failed: ${message}`);
  }
}
