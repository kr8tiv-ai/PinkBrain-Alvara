/**
 * Alvara backend API types — request/response shapes for the signing service.
 *
 * The Alvara backend computes optimal swap routes via 1inch and signs them
 * for on-chain verification by BSKTUtils. All BSKT operations requiring swaps
 * (create, contribute, rebalance, withdrawETH, claimFee) need backend-signed data.
 *
 * Types are runtime-validated in the API client — not just type assertions.
 */

import type { Address } from 'viem';

// ── Shared Types ───────────────────────────────────────────────────────────

/** Hex-encoded bytes string (0x-prefixed) */
export type HexString = `0x${string}`;

/** Signed swap data returned by the Alvara backend for on-chain consumption */
export interface SignedSwapData {
  /** Array of 1inch router calldata, one per constituent token swap */
  swapData: HexString[];
  /** ECDSA signature over the swap data, verified on-chain by BSKTUtils */
  signature: HexString;
  /** Unix timestamp after which the signature is invalid (typically ~1 hour ahead) */
  deadline: number;
}

// ── Contribute ─────────────────────────────────────────────────────────────

/** Request params for getting contribute swap routes */
export interface ContributeRoutesRequest {
  /** BSKT contract address to contribute to */
  bsktAddress: Address;
  /** ETH amount in wei (as string for large numbers) */
  amount: string;
  /** Chain ID — always 8453 (Base) */
  chainId: number;
  /** Address of the user making the contribution */
  userAddress: Address;
}

/** Response from the contribute routes endpoint */
export interface ContributeRoutesResponse extends SignedSwapData {
  /** Optional: estimated LP tokens to receive */
  estimatedLP?: string;
}

// ── Create BSKT ────────────────────────────────────────────────────────────

/** Request params for getting createBSKT swap routes */
export interface CreateBSKTRoutesRequest {
  /** Token addresses for the basket constituents */
  tokens: Address[];
  /** Weights per token (basis points, must sum to 10000) */
  weights: number[];
  /** Initial ETH investment amount in wei (as string) */
  amount: string;
  /** Chain ID — always 8453 (Base) */
  chainId: number;
  /** Address of the creator */
  userAddress: Address;
  /** BSKT name */
  name: string;
  /** BSKT symbol */
  symbol: string;
}

/** Response from the create BSKT routes endpoint */
export interface CreateBSKTRoutesResponse extends SignedSwapData {
  /** Optional: basket ID assigned by the backend */
  basketId?: string;
}

// ── Rebalance ──────────────────────────────────────────────────────────────

/** Request params for getting rebalance swap routes */
export interface RebalanceRoutesRequest {
  /** BSKT contract address to rebalance */
  bsktAddress: Address;
  /** New token addresses (may include additions/removals) */
  newTokens: Address[];
  /** New weights per token (basis points, must sum to 10000) */
  newWeights: number[];
  /** Amounts to swap per token (in token units) */
  amountIn: string[];
  /** Chain ID — always 8453 (Base) */
  chainId: number;
  /** Address of the BSKT manager requesting rebalance */
  userAddress: Address;
  /** Rebalance mode (0 = standard, 1 = ?) */
  mode: number;
}

/** Response from the rebalance routes endpoint */
export interface RebalanceRoutesResponse extends SignedSwapData {}

// ── WithdrawETH ────────────────────────────────────────────────────────────

/** Request params for getting withdrawETH swap routes */
export interface WithdrawETHRoutesRequest {
  /** BSKT contract address */
  bsktAddress: Address;
  /** LP token amount to burn (in wei as string) */
  liquidity: string;
  /** Chain ID — always 8453 (Base) */
  chainId: number;
  /** Address of the user withdrawing */
  userAddress: Address;
}

/** Response from the withdrawETH routes endpoint */
export interface WithdrawETHRoutesResponse extends SignedSwapData {
  /** Optional: estimated ETH output */
  estimatedETH?: string;
}

// ── Error Types ────────────────────────────────────────────────────────────

/** API error codes for structured error handling */
export enum AlvaraApiErrorCode {
  /** HTTP transport error — network unreachable, DNS failure, etc. */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** Request timed out */
  TIMEOUT = 'TIMEOUT',
  /** Server returned 4xx */
  CLIENT_ERROR = 'CLIENT_ERROR',
  /** Server returned 5xx */
  SERVER_ERROR = 'SERVER_ERROR',
  /** Response body is not valid JSON or doesn't match expected shape */
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  /** Request parameters failed validation before sending */
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

/** Structured error from the Alvara API client */
export class AlvaraApiError extends Error {
  public readonly code: AlvaraApiErrorCode;
  public readonly statusCode?: number;
  public readonly responseBody?: string;
  public readonly endpoint?: string;

  constructor(
    message: string,
    code: AlvaraApiErrorCode,
    opts?: { statusCode?: number; responseBody?: string; endpoint?: string },
  ) {
    super(message);
    this.name = 'AlvaraApiError';
    this.code = code;
    this.statusCode = opts?.statusCode;
    this.responseBody = opts?.responseBody;
    this.endpoint = opts?.endpoint;
  }
}

// ── Runtime Validation ─────────────────────────────────────────────────────

/**
 * Validate that a value looks like a hex string (0x-prefixed).
 */
export function isHexString(value: unknown): value is HexString {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Validate that a response contains valid SignedSwapData fields.
 * Throws AlvaraApiError with INVALID_RESPONSE if validation fails.
 */
export function validateSignedSwapData(
  data: unknown,
  endpoint: string,
): asserts data is SignedSwapData {
  if (data === null || typeof data !== 'object') {
    throw new AlvaraApiError(
      `Expected object response from ${endpoint}, got ${typeof data}`,
      AlvaraApiErrorCode.INVALID_RESPONSE,
      { endpoint },
    );
  }

  const obj = data as Record<string, unknown>;

  // swapData: must be an array of hex strings
  if (!Array.isArray(obj.swapData)) {
    throw new AlvaraApiError(
      `${endpoint}: swapData must be an array, got ${typeof obj.swapData}`,
      AlvaraApiErrorCode.INVALID_RESPONSE,
      { endpoint },
    );
  }
  for (let i = 0; i < obj.swapData.length; i++) {
    if (!isHexString(obj.swapData[i])) {
      throw new AlvaraApiError(
        `${endpoint}: swapData[${i}] must be a hex string, got ${JSON.stringify(obj.swapData[i])}`,
        AlvaraApiErrorCode.INVALID_RESPONSE,
        { endpoint },
      );
    }
  }

  // signature: must be a hex string
  if (!isHexString(obj.signature)) {
    throw new AlvaraApiError(
      `${endpoint}: signature must be a hex string, got ${typeof obj.signature}`,
      AlvaraApiErrorCode.INVALID_RESPONSE,
      { endpoint },
    );
  }

  // deadline: must be a positive integer
  if (typeof obj.deadline !== 'number' || !Number.isInteger(obj.deadline) || obj.deadline <= 0) {
    throw new AlvaraApiError(
      `${endpoint}: deadline must be a positive integer, got ${JSON.stringify(obj.deadline)}`,
      AlvaraApiErrorCode.INVALID_RESPONSE,
      { endpoint },
    );
  }
}
