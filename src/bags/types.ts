/**
 * Bags FM type definitions — local interfaces that wrap/complement the SDK types.
 *
 * The @bagsfm/bags-sdk exports its own types for fee claiming, fee share admin, etc.
 * These interfaces cover our client config, API response wrapping, and any shapes
 * the SDK doesn't export directly.
 */

import type { Commitment } from '@solana/web3.js';

/** Configuration for initializing our Bags client wrapper */
export interface BagsClientConfig {
  /** Bags API key — required for all API calls */
  apiKey: string;
  /** Optional Solana RPC URL — falls back to SOL_RPC_URL env or mainnet */
  rpcUrl?: string;
  /** Solana commitment level — defaults to 'confirmed' */
  commitment?: Commitment;
}

/**
 * Generic API response wrapper with success/error discrimination.
 * Mirrors the BagsApiResponse from the SDK but kept local for direct REST calls.
 */
export type BagsApiResponse<T> =
  | { success: true; response: T }
  | { success: false; error: string };

/** Response shape from the /ping endpoint */
export interface BagsPingResponse {
  message: string;
}

/**
 * Fee share admin info — the wallet that administers fee share for a set of token mints.
 * Used by FeeShareAdminService.getAdminTokenMints().
 */
export interface BagsFeeShareAdmin {
  /** Admin wallet public key (base58) */
  wallet: string;
  /** Token mints this wallet administers */
  tokenMints: string[];
}

/**
 * Fee share update config params — mirrors SDK's UpdateFeeShareConfigParams
 * but uses string addresses for serialization convenience.
 */
export interface BagsFeeShareUpdateConfig {
  /** Base (token) mint address */
  baseMint: string;
  /** Array of claimer wallet addresses */
  claimersArray: string[];
  /** Basis points per claimer (must sum <= 10000) */
  basisPointsArray: number[];
  /** Payer wallet address (signs the transaction) */
  payer: string;
  /** Optional additional lookup table addresses */
  additionalLookupTables?: string[];
}

/**
 * Simplified claim transaction shape for our use case.
 * The SDK returns Transaction[] from FeesService.getClaimTransactions().
 */
export interface BagsClaimTransaction {
  /** Base64-encoded serialized transaction */
  serializedTransaction: string;
  /** Metadata about what this claim covers */
  metadata: {
    tokenMint: string;
    wallet: string;
  };
}
