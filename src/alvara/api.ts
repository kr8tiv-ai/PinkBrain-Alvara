/**
 * Alvara backend API client — typed interface for the signing service.
 *
 * The Alvara backend computes optimal 1inch swap routes and signs them for
 * MEV-protected on-chain execution. Every BSKT operation requiring token
 * swaps (contribute, create, rebalance, withdrawETH) needs backend-signed data.
 *
 * Base URL is configurable via ALVARA_API_URL env var. The actual URL is
 * embedded in the Cloudflare-protected frontend JS bundle — set it once discovered.
 *
 * Follows the thin REST client pattern from src/debridge/api.ts.
 */

import type { Address } from 'viem';
import {
  type SignedSwapData,
  type ContributeRoutesRequest,
  type ContributeRoutesResponse,
  type CreateBSKTRoutesRequest,
  type CreateBSKTRoutesResponse,
  type RebalanceRoutesRequest,
  type RebalanceRoutesResponse,
  type WithdrawETHRoutesRequest,
  type WithdrawETHRoutesResponse,
  AlvaraApiError,
  AlvaraApiErrorCode,
  validateSignedSwapData,
} from './types.js';

// ── Configuration ──────────────────────────────────────────────────────────

/** Default base URL — overridable via ALVARA_API_URL env var or setApiBaseUrl() */
const DEFAULT_API_BASE = 'https://api.alvara.xyz';

let _apiBaseUrl: string | null = null;

/**
 * Get the configured API base URL.
 * Priority: setApiBaseUrl() > ALVARA_API_URL env var > default.
 */
export function getApiBaseUrl(): string {
  if (_apiBaseUrl) return _apiBaseUrl;
  const envUrl = process.env.ALVARA_API_URL;
  if (envUrl) return envUrl;
  return DEFAULT_API_BASE;
}

/**
 * Override the API base URL programmatically (for testing or discovery).
 * Pass null to reset to env var / default.
 */
export function setApiBaseUrl(url: string | null): void {
  _apiBaseUrl = url;
}

/** Timeout for API requests in ms */
const API_TIMEOUT_MS = 15_000;

// ── Logging ────────────────────────────────────────────────────────────────

/** Structured log entry — JSON to stdout, greppable by module/phase/action */
function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'alvara-api',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── HTTP Helpers ───────────────────────────────────────────────────────────

/** Fetch with abort-controller timeout */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AlvaraApiError(
        `Request timed out after ${timeoutMs}ms: ${url}`,
        AlvaraApiErrorCode.TIMEOUT,
        { endpoint: url },
      );
    }
    // Network-level errors (DNS, ECONNREFUSED, etc.)
    throw new AlvaraApiError(
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
      AlvaraApiErrorCode.NETWORK_ERROR,
      { endpoint: url },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make a POST request to the Alvara backend.
 * Returns parsed JSON body. Throws AlvaraApiError on failure.
 * Never logs request bodies (may contain user addresses or sensitive params).
 */
async function apiPost<T>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${endpoint}`;

  log('request', 'start', { endpoint, baseUrl });

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    API_TIMEOUT_MS,
  );

  if (!res.ok) {
    const responseBody = await res.text().catch(() => '<unreadable>');
    const code = res.status >= 500
      ? AlvaraApiErrorCode.SERVER_ERROR
      : AlvaraApiErrorCode.CLIENT_ERROR;

    log('request', 'error', { endpoint, status: res.status });

    throw new AlvaraApiError(
      `Alvara API ${endpoint} failed: HTTP ${res.status} — ${responseBody}`,
      code,
      { statusCode: res.status, responseBody, endpoint },
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AlvaraApiError(
      `Alvara API ${endpoint}: response is not valid JSON`,
      AlvaraApiErrorCode.INVALID_RESPONSE,
      { statusCode: res.status, endpoint },
    );
  }

  log('request', 'done', { endpoint, status: res.status });

  return data as T;
}

// ── Input Validation ───────────────────────────────────────────────────────

function validateAddress(value: string, field: string, endpoint: string): void {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new AlvaraApiError(
      `${field} must be a valid Ethereum address, got "${value}"`,
      AlvaraApiErrorCode.VALIDATION_ERROR,
      { endpoint },
    );
  }
}

function validatePositiveWei(value: string, field: string, endpoint: string): void {
  if (!value || value === '0') {
    throw new AlvaraApiError(
      `${field} must be a non-zero wei amount, got "${value}"`,
      AlvaraApiErrorCode.VALIDATION_ERROR,
      { endpoint },
    );
  }
  if (!/^\d+$/.test(value)) {
    throw new AlvaraApiError(
      `${field} must be a numeric string (wei), got "${value}"`,
      AlvaraApiErrorCode.VALIDATION_ERROR,
      { endpoint },
    );
  }
}

// ── Public API Functions ───────────────────────────────────────────────────

/**
 * Get signed swap routes for contributing ETH to an existing BSKT.
 *
 * The backend computes optimal 1inch routes from ETH → each constituent token
 * (weighted by basket allocation) and returns signed calldata + signature.
 *
 * @returns Signed swap data ready for BSKT.contribute{value}(swapData, signature, deadline)
 */
export async function getContributeRoutes(
  params: ContributeRoutesRequest,
): Promise<ContributeRoutesResponse> {
  const endpoint = '/contribute';

  // Validate inputs
  validateAddress(params.bsktAddress, 'bsktAddress', endpoint);
  validatePositiveWei(params.amount, 'amount', endpoint);
  validateAddress(params.userAddress, 'userAddress', endpoint);

  const data = await apiPost<unknown>(endpoint, {
    bsktAddress: params.bsktAddress,
    amount: params.amount,
    chainId: params.chainId,
    userAddress: params.userAddress,
  });

  // Runtime-validate the signed swap data fields
  validateSignedSwapData(data, endpoint);

  return data as ContributeRoutesResponse;
}

/**
 * Get signed swap routes for creating a new BSKT.
 *
 * The backend computes 1inch routes for the initial ETH → token swaps
 * and returns signed calldata for factory.createBSKT().
 *
 * @returns Signed swap data ready for factory.createBSKT(...)
 */
export async function getCreateBSKTRoutes(
  params: CreateBSKTRoutesRequest,
): Promise<CreateBSKTRoutesResponse> {
  const endpoint = '/create-bskt';

  // Validate inputs
  if (!params.tokens.length) {
    throw new AlvaraApiError(
      'tokens array must not be empty',
      AlvaraApiErrorCode.VALIDATION_ERROR,
      { endpoint },
    );
  }
  if (params.tokens.length !== params.weights.length) {
    throw new AlvaraApiError(
      `tokens (${params.tokens.length}) and weights (${params.weights.length}) must have same length`,
      AlvaraApiErrorCode.VALIDATION_ERROR,
      { endpoint },
    );
  }
  for (const token of params.tokens) {
    validateAddress(token, 'tokens[]', endpoint);
  }
  validatePositiveWei(params.amount, 'amount', endpoint);
  validateAddress(params.userAddress, 'userAddress', endpoint);

  const data = await apiPost<unknown>(endpoint, {
    tokens: params.tokens,
    weights: params.weights,
    amount: params.amount,
    chainId: params.chainId,
    userAddress: params.userAddress,
    name: params.name,
    symbol: params.symbol,
  });

  validateSignedSwapData(data, endpoint);

  return data as CreateBSKTRoutesResponse;
}

/**
 * Get signed swap routes for rebalancing a BSKT.
 *
 * Rebalancing changes the token allocation of an existing BSKT. Only the
 * BSKT manager can execute a rebalance on-chain, but the swap routes
 * still require backend signing.
 *
 * Used by S03 for the rebalancing flow.
 *
 * @returns Signed swap data ready for BSKT.rebalance(...)
 */
export async function getRebalanceRoutes(
  params: RebalanceRoutesRequest,
): Promise<RebalanceRoutesResponse> {
  const endpoint = '/rebalance';

  // Validate inputs
  validateAddress(params.bsktAddress, 'bsktAddress', endpoint);
  if (!params.newTokens.length) {
    throw new AlvaraApiError(
      'newTokens array must not be empty',
      AlvaraApiErrorCode.VALIDATION_ERROR,
      { endpoint },
    );
  }
  if (params.newTokens.length !== params.newWeights.length) {
    throw new AlvaraApiError(
      `newTokens (${params.newTokens.length}) and newWeights (${params.newWeights.length}) must have same length`,
      AlvaraApiErrorCode.VALIDATION_ERROR,
      { endpoint },
    );
  }
  for (const token of params.newTokens) {
    validateAddress(token, 'newTokens[]', endpoint);
  }
  validateAddress(params.userAddress, 'userAddress', endpoint);

  const data = await apiPost<unknown>(endpoint, {
    bsktAddress: params.bsktAddress,
    newTokens: params.newTokens,
    newWeights: params.newWeights,
    amountIn: params.amountIn,
    chainId: params.chainId,
    userAddress: params.userAddress,
    mode: params.mode,
  });

  validateSignedSwapData(data, endpoint);

  return data as RebalanceRoutesResponse;
}

/**
 * Get signed swap routes for withdrawing ETH from a BSKT.
 *
 * Burns LP tokens and swaps underlying tokens back to ETH via 1inch routes.
 *
 * @returns Signed swap data ready for BSKT.withdrawETH(liquidity, swapData, signature, deadline)
 */
export async function getWithdrawETHRoutes(
  params: WithdrawETHRoutesRequest,
): Promise<WithdrawETHRoutesResponse> {
  const endpoint = '/withdraw-eth';

  validateAddress(params.bsktAddress, 'bsktAddress', endpoint);
  validatePositiveWei(params.liquidity, 'liquidity', endpoint);
  validateAddress(params.userAddress, 'userAddress', endpoint);

  const data = await apiPost<unknown>(endpoint, {
    bsktAddress: params.bsktAddress,
    liquidity: params.liquidity,
    chainId: params.chainId,
    userAddress: params.userAddress,
  });

  validateSignedSwapData(data, endpoint);

  return data as WithdrawETHRoutesResponse;
}
