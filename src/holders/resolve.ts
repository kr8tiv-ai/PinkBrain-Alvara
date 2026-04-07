/**
 * Dual-strategy SPL token holder resolution.
 *
 * Strategies:
 *   1. Helius DAS `getTokenAccounts` — preferred when Helius RPC detected (paginated, fast)
 *   2. `getProgramAccounts` with SPL Token filters — universal fallback
 *
 * Entry point: getTopHolders(mint, count, connection?)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { SOLANA_KNOWN_ADDRESSES, createSolanaConnection } from '../config/solana.js';
import type { HolderInfo, HolderResolutionResult } from './types.js';

// Re-export types for convenience
export type { HolderInfo, HolderResolutionResult } from './types.js';

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'holders',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// SPL Token account layout constants
// ---------------------------------------------------------------------------

/** SPL Token account data is exactly 165 bytes */
const SPL_TOKEN_ACCOUNT_SIZE = 165;

/** Offsets within the 165-byte SPL Token account layout:
 *   0-31:  mint (32 bytes)
 *  32-63:  owner (32 bytes)
 *  64-71:  amount (8 bytes, u64 LE)
 */
const OWNER_OFFSET = 32;
const AMOUNT_OFFSET = 64;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Base58 character set */
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Validate a mint address is plausible base58 and correct length.
 * Throws with descriptive message on invalid input.
 */
export function validateMint(mint: string): void {
  if (!mint || mint.trim().length === 0) {
    throw new Error('Holder resolution: mint address is required (got empty string)');
  }
  const trimmed = mint.trim();
  if (trimmed.length < 32 || trimmed.length > 44) {
    throw new Error(
      `Holder resolution: mint address must be 32-44 characters (got ${trimmed.length}): ${trimmed.slice(0, 10)}...`
    );
  }
  if (!BASE58_REGEX.test(trimmed)) {
    throw new Error(
      `Holder resolution: mint address contains invalid base58 characters: ${trimmed.slice(0, 10)}...`
    );
  }
}

/**
 * Validate holder count is within acceptable range.
 */
export function validateCount(count: number): void {
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`Holder resolution: count must be >= 1 (got ${count})`);
  }
  if (count > 10_000) {
    throw new Error(`Holder resolution: count must be <= 10000 (got ${count})`);
  }
}

// ---------------------------------------------------------------------------
// Helius detection
// ---------------------------------------------------------------------------

/**
 * Detect whether an RPC URL is a Helius endpoint.
 * Helius DAS provides `getTokenAccounts` which is faster than getProgramAccounts.
 */
export function isHeliusRpc(url: string): boolean {
  return url.toLowerCase().includes('helius');
}

// ---------------------------------------------------------------------------
// Strategy 1: getProgramAccounts (universal)
// ---------------------------------------------------------------------------

/**
 * Resolve holders via getProgramAccounts with SPL Token filters.
 * Works on any Solana RPC endpoint that supports getProgramAccounts.
 */
export async function resolveHoldersViaProgramAccounts(
  connection: Connection,
  mint: string,
  count: number,
): Promise<HolderResolutionResult> {
  const startMs = Date.now();
  const mintPubkey = new PublicKey(mint);
  const tokenProgramId = new PublicKey(SOLANA_KNOWN_ADDRESSES.SPL_TOKEN_PROGRAM_ID);

  log('gpa', 'start', { mint, count });

  const accounts = await connection.getProgramAccounts(tokenProgramId, {
    filters: [
      { dataSize: SPL_TOKEN_ACCOUNT_SIZE },
      { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } },
    ],
    encoding: 'base64',
  });

  log('gpa', 'fetched', { mint, rawAccountCount: accounts.length, elapsedMs: Date.now() - startMs });

  // Parse accounts — skip malformed ones with a warning
  const parsed: HolderInfo[] = [];
  let skipped = 0;

  for (const { account } of accounts) {
    const data = account.data as unknown;

    let buf: Buffer;
    if (Buffer.isBuffer(data)) {
      buf = data;
    } else if (Array.isArray(data) && typeof data[0] === 'string') {
      // [base64string, 'base64'] format from RPC
      buf = Buffer.from(data[0] as string, 'base64');
    } else {
      skipped++;
      continue;
    }

    if (buf.length < SPL_TOKEN_ACCOUNT_SIZE) {
      skipped++;
      log('gpa', 'malformedAccount', { dataLength: buf.length, expected: SPL_TOKEN_ACCOUNT_SIZE });
      continue;
    }

    const owner = new PublicKey(buf.subarray(OWNER_OFFSET, OWNER_OFFSET + 32)).toBase58();
    const amount = buf.readBigUInt64LE(AMOUNT_OFFSET);

    // Filter zero-balance accounts
    if (amount === 0n) continue;

    parsed.push({ owner, amount, percentage: 0 });
  }

  if (skipped > 0) {
    log('gpa', 'skippedMalformed', { count: skipped });
  }

  // Sort descending by amount
  parsed.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));

  // Calculate total supply held (across ALL non-zero holders, before slicing)
  const totalSupplyHeld = parsed.reduce((sum, h) => sum + h.amount, 0n);

  // Take top N
  const top = parsed.slice(0, count);

  // Calculate percentages
  if (totalSupplyHeld > 0n) {
    for (const holder of top) {
      holder.percentage = Number((holder.amount * 10000n) / totalSupplyHeld) / 100;
    }
  }

  log('gpa', 'done', {
    mint,
    totalHolders: parsed.length,
    topN: top.length,
    elapsedMs: Date.now() - startMs,
  });

  return {
    holders: top,
    totalSupplyHeld,
    strategy: 'getProgramAccounts',
    mint,
  };
}

// ---------------------------------------------------------------------------
// Strategy 2: Helius DAS getTokenAccounts (preferred when available)
// ---------------------------------------------------------------------------

interface HeliusDasTokenAccount {
  owner: string;
  amount: number;
}

interface HeliusDasResponse {
  result?: {
    token_accounts?: HeliusDasTokenAccount[];
    cursor?: string;
  };
  error?: { message: string };
}

/**
 * Resolve holders via Helius DAS getTokenAccounts.
 * Paginates with cursor to collect all accounts up to a reasonable limit.
 */
export async function resolveHoldersViaHelius(
  rpcUrl: string,
  mint: string,
  count: number,
): Promise<HolderResolutionResult> {
  const startMs = Date.now();
  log('helius', 'start', { mint, count });

  const allAccounts: HeliusDasTokenAccount[] = [];
  let cursor: string | undefined;
  const pageLimit = 1000;
  const maxPages = Math.ceil(Math.min(count * 2, 10_000) / pageLimit); // Fetch up to 2x count for filtering

  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: `holders-${page}`,
      method: 'getTokenAccounts',
      params: {
        mint,
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
      },
    };

    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Helius DAS getTokenAccounts HTTP ${res.status}: ${await res.text().catch(() => '<unreadable>')}`);
    }

    const json = (await res.json()) as HeliusDasResponse;

    if (json.error) {
      throw new Error(`Helius DAS error: ${json.error.message}`);
    }

    if (!json.result?.token_accounts || !Array.isArray(json.result.token_accounts)) {
      throw new Error('Helius DAS: unexpected response shape — missing token_accounts array');
    }

    allAccounts.push(...json.result.token_accounts);

    log('helius', 'page', {
      page: page + 1,
      accountsThisPage: json.result.token_accounts.length,
      totalSoFar: allAccounts.length,
    });

    // Stop if no more pages
    if (!json.result.cursor || json.result.token_accounts.length < pageLimit) {
      break;
    }
    cursor = json.result.cursor;
  }

  // Parse into HolderInfo, filter zero-balance
  const parsed: HolderInfo[] = allAccounts
    .filter((a) => a.amount > 0)
    .map((a) => ({
      owner: a.owner,
      amount: BigInt(a.amount),
      percentage: 0,
    }));

  // Sort descending
  parsed.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));

  // Total supply from all discovered holders
  const totalSupplyHeld = parsed.reduce((sum, h) => sum + h.amount, 0n);

  // Take top N
  const top = parsed.slice(0, count);

  // Calculate percentages
  if (totalSupplyHeld > 0n) {
    for (const holder of top) {
      holder.percentage = Number((holder.amount * 10000n) / totalSupplyHeld) / 100;
    }
  }

  log('helius', 'done', {
    mint,
    totalHolders: parsed.length,
    topN: top.length,
    elapsedMs: Date.now() - startMs,
  });

  return {
    holders: top,
    totalSupplyHeld,
    strategy: 'helius-das',
    mint,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the top N holders of an SPL token mint.
 *
 * If Helius RPC is detected, tries the DAS getTokenAccounts method first
 * (faster, paginated). Falls back to getProgramAccounts on any error.
 * Non-Helius RPCs go directly to getProgramAccounts.
 *
 * @param mint - SPL token mint address (base58)
 * @param count - Number of top holders to return (1-10000, default 100)
 * @param connection - Optional pre-configured Solana Connection
 */
export async function getTopHolders(
  mint: string,
  count = 100,
  connection?: Connection,
): Promise<HolderResolutionResult> {
  // Input validation
  validateMint(mint);
  validateCount(count);

  const conn = connection ?? createSolanaConnection();
  const rpcUrl = (conn as unknown as { _rpcEndpoint: string })._rpcEndpoint;

  log('resolve', 'start', { mint, count, rpcUrl: rpcUrl.replace(/api[_-]?key[^&]*/gi, 'REDACTED'), isHelius: isHeliusRpc(rpcUrl) });

  if (isHeliusRpc(rpcUrl)) {
    try {
      return await resolveHoldersViaHelius(rpcUrl, mint, count);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('resolve', 'heliusFallback', { error: msg, fallbackTo: 'getProgramAccounts' });
      // Fall back to getProgramAccounts
    }
  }

  return resolveHoldersViaProgramAccounts(conn, mint, count);
}
