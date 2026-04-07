/**
 * Jupiter Ultra V3 swap client — thin wrapper over the REST endpoints for SOL→USDC swaps.
 *
 * Endpoints:
 *   GET   https://api.jup.ag/ultra/v1/order
 *   POST  https://api.jup.ag/ultra/v1/execute
 *
 * Pattern: matches deBridge API client — structured logging, fetchWithTimeout, input validation.
 */

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { SOLANA_KNOWN_ADDRESSES } from '../config/solana.js';
import type {
  JupiterOrderRequest,
  JupiterOrderResponse,
  JupiterExecuteRequest,
  JupiterExecuteResponse,
  SwapResult,
} from './types.js';

const JUPITER_API_BASE = 'https://api.jup.ag';
const JUPITER_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Structured logging — JSON to stdout, greppable by module/phase/action
// ---------------------------------------------------------------------------

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'jupiter',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Fetch with timeout (same pattern as deBridge)
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate a base58-ish string is non-empty. Not a full base58 check,
 * but catches the obvious empties. On-chain validation handles the rest.
 */
function validateAddress(value: string, fieldName: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Jupiter swap: ${fieldName} is required (got empty string)`);
  }
}

function validateAmount(amount: number, fieldName: string): void {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error(`Jupiter swap: ${fieldName} must be a finite number (got ${typeof amount}: ${amount})`);
  }
  if (amount <= 0) {
    throw new Error(`Jupiter swap: ${fieldName} must be positive (got ${amount})`);
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Get a swap order (quote + unsigned transaction) from Jupiter Ultra.
 *
 * Calls GET /ultra/v1/order with query params.
 * Returns the order response including a base64-encoded VersionedTransaction.
 */
export async function getSwapOrder(
  inputMint: string,
  outputMint: string,
  amount: number,
  taker: string
): Promise<JupiterOrderResponse> {
  validateAddress(inputMint, 'inputMint');
  validateAddress(outputMint, 'outputMint');
  validateAmount(amount, 'amount');
  validateAddress(taker, 'taker');

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    taker,
  });

  const url = `${JUPITER_API_BASE}/ultra/v1/order?${params.toString()}`;

  log('swap', 'getOrder:start', {
    inputMint,
    outputMint,
    amount,
    taker,
  });

  const res = await fetchWithTimeout(url, { method: 'GET' }, JUPITER_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `Jupiter order failed: HTTP ${res.status} — ${body.slice(0, 500)}`
    );
  }

  const data = await res.json();

  // Validate response has minimum required fields.
  // Jupiter returns inAmount/outAmount even when transaction is empty (e.g. insufficient funds
  // on the taker — common in estimate-only mode with a dummy address).
  // We require requestId + at least one of transaction or quote fields.
  if (!data.requestId) {
    throw new Error(
      'Jupiter order response missing "requestId" field — unexpected shape'
    );
  }
  if (!data.transaction && !data.inAmount) {
    throw new Error(
      'Jupiter order response missing both "transaction" and "inAmount" fields — unexpected shape'
    );
  }

  log('swap', 'getOrder:done', {
    requestId: data.requestId,
    type: data.type,
    inAmount: data.inAmount,
    outAmount: data.outAmount,
  });

  return data as JupiterOrderResponse;
}

/**
 * Execute a signed swap transaction via Jupiter Ultra.
 *
 * Calls POST /ultra/v1/execute with the signed transaction and request ID.
 */
export async function executeSwap(
  signedTransaction: string,
  requestId: string
): Promise<JupiterExecuteResponse> {
  if (!signedTransaction || signedTransaction.trim().length === 0) {
    throw new Error('Jupiter execute: signedTransaction is required');
  }
  if (!requestId || requestId.trim().length === 0) {
    throw new Error('Jupiter execute: requestId is required');
  }

  const url = `${JUPITER_API_BASE}/ultra/v1/execute`;
  const body: JupiterExecuteRequest = { signedTransaction, requestId };

  log('swap', 'execute:start', { requestId });

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    JUPITER_TIMEOUT_MS
  );

  if (!res.ok) {
    const resBody = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `Jupiter execute failed: HTTP ${res.status} — ${resBody.slice(0, 500)}`
    );
  }

  const data = await res.json();

  log('swap', 'execute:done', {
    status: data.status,
    signature: data.signature,
    error: data.error,
  });

  return data as JupiterExecuteResponse;
}

/**
 * High-level helper: swap SOL to USDC via Jupiter Ultra.
 *
 * Flow: getSwapOrder → deserialize base64 VersionedTransaction →
 *       sign with wallet → serialize to base64 → executeSwap
 *
 * CRITICAL: Jupiter returns a base64-encoded VersionedTransaction with
 * ComputeBudget instructions already included. Do NOT inject additional
 * ComputeBudget instructions. Sign the transaction as-is.
 */
export async function swapSolToUsdc(
  amountLamports: number,
  wallet: Keypair,
  connection: Connection
): Promise<SwapResult> {
  validateAmount(amountLamports, 'amountLamports');

  log('swap', 'swapSolToUsdc:start', {
    amountLamports,
    taker: wallet.publicKey.toBase58(),
  });

  // Phase 1: Get swap order
  const order = await getSwapOrder(
    SOLANA_KNOWN_ADDRESSES.WRAPPED_SOL,
    SOLANA_KNOWN_ADDRESSES.USDC,
    amountLamports,
    wallet.publicKey.toBase58()
  );

  // Phase 2: Deserialize, sign, and re-serialize
  if (!order.transaction) {
    throw new Error(
      `Jupiter order returned empty transaction — likely insufficient funds or invalid taker. ` +
      `Error: ${(order as any).error ?? 'none'}`
    );
  }
  log('swap', 'swapSolToUsdc:sign', { requestId: order.requestId });

  const txBuffer = Buffer.from(order.transaction, 'base64');
  const versionedTx = VersionedTransaction.deserialize(txBuffer);

  // Sign as-is — Jupiter includes ComputeBudget internally
  versionedTx.sign([wallet]);

  const signedBase64 = Buffer.from(versionedTx.serialize()).toString('base64');

  // Phase 3: Execute via Jupiter
  const result = await executeSwap(signedBase64, order.requestId);

  if (result.status !== 'Success') {
    throw new Error(
      `Jupiter swap execution failed: status=${result.status}, error=${result.error ?? 'unknown'}`
    );
  }

  log('swap', 'swapSolToUsdc:done', {
    signature: result.signature,
    inAmount: order.inAmount,
    outAmount: order.outAmount,
  });

  return {
    signature: result.signature,
    inAmount: order.inAmount,
    outAmount: order.outAmount,
  };
}
