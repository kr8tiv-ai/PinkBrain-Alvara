/**
 * Bags FM client — SDK initialization factory, direct REST helpers, and structured logging.
 *
 * Pattern mirrors src/debridge/api.ts: structured JSON logs, fetchWithTimeout, thin wrapper.
 * Uses @bagsfm/bags-sdk for on-chain operations; direct REST for lightweight endpoints like /ping.
 */

import { BagsSDK } from '@bagsfm/bags-sdk';
import { createSolanaConnection } from '../config/solana.js';
import type { BagsClientConfig, BagsPingResponse } from './types.js';

/** Bags public API v2 base URL — used for direct REST calls outside the SDK */
export const BAGS_API_BASE = 'https://public-api-v2.bags.fm/api/v1';

/** Default timeout for direct Bags REST calls (ms) */
const BAGS_TIMEOUT_MS = 10_000;

/**
 * Structured log entry — JSON to stdout, greppable by module/phase/action.
 * Matches the debridge logging pattern for consistency.
 */
export function log(
  phase: string,
  action: string,
  data: Record<string, unknown> = {}
): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'bags',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

/**
 * Fetch with abort-controller timeout.
 * Reuses the same pattern as debridge/api.ts.
 */
export async function fetchWithTimeout(
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
      throw new Error(`Bags API request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ping the Bags API to validate an API key.
 * Calls GET /ping with x-api-key header.
 *
 * @throws On timeout, non-200 response, or missing `message` field
 */
export async function pingApi(apiKey: string): Promise<BagsPingResponse> {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('Bags API key is required — set BAGS_API_KEY env var');
  }

  const url = `${BAGS_API_BASE}/ping`;

  log('init', 'ping:start', { url });

  const res = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    },
    BAGS_TIMEOUT_MS
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`Bags API /ping failed: HTTP ${res.status} — ${body}`);
  }

  const data = await res.json();

  // Validate response has expected shape
  if (typeof data?.message !== 'string') {
    throw new Error(
      `Bags API /ping: unexpected response shape — missing 'message' field`
    );
  }

  log('init', 'ping:ok', { message: data.message });

  return data as BagsPingResponse;
}

/**
 * Create a configured BagsSDK instance.
 * Wraps the SDK constructor with our config shape and Solana connection factory.
 *
 * @throws If apiKey is missing
 */
export function createBagsClient(config: BagsClientConfig): BagsSDK {
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error('Bags API key is required — set BAGS_API_KEY env var');
  }

  const connection = createSolanaConnection(config.rpcUrl);
  const commitment = config.commitment ?? 'confirmed';

  log('init', 'createClient', {
    rpcUrl: config.rpcUrl ?? 'default',
    commitment,
  });

  return new BagsSDK(config.apiKey, connection, commitment);
}
