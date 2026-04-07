/**
 * Jupiter Ultra V3 API types — request/response shapes for SOL→USDC swaps.
 *
 * Covers the two Ultra endpoints:
 *   - GET  /ultra/v1/order  (get swap order with transaction)
 *   - POST /ultra/v1/execute (submit signed transaction)
 *
 * Reference: https://docs.jup.ag/docs/ultra-api
 */

/** Query parameters for GET /ultra/v1/order */
export interface JupiterOrderRequest {
  /** Input token mint address */
  inputMint: string;
  /** Output token mint address */
  outputMint: string;
  /** Amount in atomic units (lamports for SOL) */
  amount: number;
  /** Taker wallet public key (the signer) */
  taker: string;
}

/** Response from GET /ultra/v1/order */
export interface JupiterOrderResponse {
  /** Base64-encoded VersionedTransaction to sign */
  transaction: string;
  /** Unique request identifier — must be passed to execute */
  requestId: string;
  /** Order type (e.g. "Ultra") */
  type: string;
  /** Input token mint */
  inputMint: string;
  /** Output token mint */
  outputMint: string;
  /** Input amount in atomic units (string) */
  inAmount: string;
  /** Output amount in atomic units (string) */
  outAmount: string;
}

/** Request body for POST /ultra/v1/execute */
export interface JupiterExecuteRequest {
  /** Base64-encoded signed VersionedTransaction */
  signedTransaction: string;
  /** Request ID from the order response */
  requestId: string;
}

/** Response from POST /ultra/v1/execute */
export interface JupiterExecuteResponse {
  /** Execution status (e.g. "Success", "Failed") */
  status: string;
  /** On-chain transaction signature */
  signature: string;
  /** Error message if execution failed */
  error?: string;
}

/** Result of a high-level swapSolToUsdc call */
export interface SwapResult {
  /** On-chain transaction signature */
  signature: string;
  /** Input amount in lamports (string) */
  inAmount: string;
  /** Output amount in USDC atomic units (string) */
  outAmount: string;
}
