/**
 * Block explorer API helper — uses Blockscout (free, no key required) as primary,
 * with Etherscan V2 as fallback when BASESCAN_API_KEY is set.
 *
 * Blockscout Base API: https://base.blockscout.com/api/v2/
 * Etherscan V2 API: https://api.etherscan.io/v2/api?chainid=8453
 */

import 'dotenv/config';
import type { Address } from 'viem';

// ── Config ─────────────────────────────────────────────────────────────────

const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api/v2';
const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = '8453';
const API_KEY = process.env.BASESCAN_API_KEY ?? process.env.ETHERSCAN_API_KEY ?? '';

/** Use Etherscan V2 if we have an API key, otherwise Blockscout */
const USE_ETHERSCAN = !!API_KEY;

/** Minimum ms between API calls */
const MIN_DELAY_MS = USE_ETHERSCAN ? 210 : 300;
let lastCallAt = 0;

// ── Types ──────────────────────────────────────────────────────────────────

export interface BasescanTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  input: string;
  contractAddress: string;
  isError: string;
  functionName: string;
  methodId: string;
}

export interface ContractCreation {
  contractAddress: string;
  contractCreator: string;
  txHash: string;
}

export interface InternalTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  input: string;
  type: string;
  isError: string;
}

// ── Rate limiting ──────────────────────────────────────────────────────────

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_DELAY_MS - elapsed));
  }
  lastCallAt = Date.now();
}

// ── Fetch with retries ─────────────────────────────────────────────────────

async function fetchWithRetry(url: string, maxRetries = 3): Promise<unknown> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await rateLimit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (resp.status === 429) {
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        console.error(JSON.stringify({ phase: 'api_rate_limit', attempt, backoffMs: backoff }));
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }

      return await resp.json();
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        console.error(JSON.stringify({
          phase: 'api_retry',
          attempt,
          error: err instanceof Error ? err.message : String(err),
          backoffMs: backoff,
        }));
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      throw err;
    }
  }
  throw new Error('API: exhausted retries');
}

// ── Etherscan V2 helpers ───────────────────────────────────────────────────

async function etherscanFetch<T>(params: Record<string, string>): Promise<T> {
  const url = new URL(ETHERSCAN_V2_BASE);
  url.searchParams.set('chainid', CHAIN_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (API_KEY) url.searchParams.set('apikey', API_KEY);

  const json = await fetchWithRetry(url.toString()) as { status: string; message: string; result: T };

  if (json.status === '0') {
    const msg = String(json.message ?? '');
    if (msg.includes('No transactions found') || msg.includes('No records found')) {
      return [] as unknown as T;
    }
    throw new Error(`Etherscan API error: ${json.message} — ${JSON.stringify(json.result).slice(0, 300)}`);
  }
  return json.result;
}

// ── Blockscout helpers ─────────────────────────────────────────────────────

function blockscoutUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(`${BLOCKSCOUT_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  return url.toString();
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the creator address and creation tx hash for a contract.
 */
export async function getContractCreationTxs(
  addresses: Address | Address[],
): Promise<ContractCreation[]> {
  const list = Array.isArray(addresses) ? addresses : [addresses];

  if (USE_ETHERSCAN) {
    return etherscanFetch<ContractCreation[]>({
      module: 'contract',
      action: 'getcontractcreation',
      contractaddresses: list.join(','),
    });
  }

  // Blockscout: one address at a time
  const results: ContractCreation[] = [];
  for (const addr of list) {
    const data = await fetchWithRetry(blockscoutUrl(`/addresses/${addr}`)) as {
      creator_address_hash?: string;
      creation_tx_hash?: string;
    };
    if (data.creator_address_hash) {
      results.push({
        contractAddress: addr,
        contractCreator: data.creator_address_hash,
        txHash: data.creation_tx_hash ?? '',
      });
    }
  }
  return results;
}

/**
 * Get normal transactions for an address.
 */
export async function getTransactionsByAddress(
  address: Address,
  opts: { startBlock?: number; endBlock?: number; page?: number; offset?: number; sort?: 'asc' | 'desc' } = {},
): Promise<BasescanTx[]> {
  if (USE_ETHERSCAN) {
    return etherscanFetch<BasescanTx[]>({
      module: 'account',
      action: 'txlist',
      address,
      startblock: String(opts.startBlock ?? 0),
      endblock: String(opts.endBlock ?? 99999999),
      page: String(opts.page ?? 1),
      offset: String(opts.offset ?? 100),
      sort: opts.sort ?? 'asc',
    });
  }

  // Blockscout: /addresses/{addr}/transactions
  const items: unknown[] = [];
  let nextPageParams: Record<string, string> | null = null;
  const maxPages = Math.ceil((opts.offset ?? 100) / 50);

  for (let p = 0; p < maxPages; p++) {
    const params: Record<string, string> = {};
    if (nextPageParams) {
      for (const [k, v] of Object.entries(nextPageParams)) params[k] = String(v);
    }

    const data = await fetchWithRetry(blockscoutUrl(`/addresses/${address}/transactions`, params)) as {
      items: unknown[];
      next_page_params: Record<string, string> | null;
    };

    items.push(...data.items);
    nextPageParams = data.next_page_params;
    if (!nextPageParams) break;
  }

  return items.map(normalizeBlockscoutTx);
}

/**
 * Get internal transactions for an address.
 */
export async function getInternalTxsByAddress(
  address: Address,
  opts: { startBlock?: number; endBlock?: number; page?: number; offset?: number } = {},
): Promise<InternalTx[]> {
  if (USE_ETHERSCAN) {
    return etherscanFetch<InternalTx[]>({
      module: 'account',
      action: 'txlistinternal',
      address,
      startblock: String(opts.startBlock ?? 0),
      endblock: String(opts.endBlock ?? 99999999),
      page: String(opts.page ?? 1),
      offset: String(opts.offset ?? 100),
      sort: 'asc',
    });
  }

  // Blockscout: /addresses/{addr}/internal-transactions
  const items: unknown[] = [];
  let nextPageParams: Record<string, string> | null = null;
  const maxPages = Math.ceil((opts.offset ?? 100) / 50);

  for (let p = 0; p < maxPages; p++) {
    const params: Record<string, string> = {};
    if (nextPageParams) {
      for (const [k, v] of Object.entries(nextPageParams)) params[k] = String(v);
    }

    const data = await fetchWithRetry(blockscoutUrl(`/addresses/${address}/internal-transactions`, params)) as {
      items: unknown[];
      next_page_params: Record<string, string> | null;
    };

    items.push(...data.items);
    nextPageParams = data.next_page_params;
    if (!nextPageParams) break;
  }

  return items.map(normalizeBlockscoutInternalTx);
}

/**
 * Get internal transactions for a specific tx hash.
 */
export async function getInternalTxsByHash(txHash: string): Promise<InternalTx[]> {
  if (USE_ETHERSCAN) {
    return etherscanFetch<InternalTx[]>({
      module: 'account',
      action: 'txlistinternal',
      txhash: txHash,
    });
  }

  // Blockscout: /transactions/{hash}/internal-transactions
  const data = await fetchWithRetry(blockscoutUrl(`/transactions/${txHash}/internal-transactions`)) as {
    items: unknown[];
  };

  return data.items.map(normalizeBlockscoutInternalTx);
}

/**
 * Try to get verified ABI for a contract. Returns null if not verified.
 */
export async function getContractABI(address: Address): Promise<string | null> {
  try {
    if (USE_ETHERSCAN) {
      const result = await etherscanFetch<string>({
        module: 'contract',
        action: 'getabi',
        address,
      });
      return result;
    }

    // Blockscout: /smart-contracts/{addr}
    const data = await fetchWithRetry(blockscoutUrl(`/smart-contracts/${address}`)) as {
      abi?: unknown[];
      is_verified?: boolean;
    };
    if (data.abi && data.is_verified) {
      return JSON.stringify(data.abi);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get address info from Blockscout (token info, contract info, etc.)
 */
export async function getAddressInfo(address: Address): Promise<{
  is_contract: boolean;
  name?: string;
  creator_address_hash?: string;
  creation_tx_hash?: string;
  token?: { name: string; symbol: string; type: string };
}> {
  const data = await fetchWithRetry(blockscoutUrl(`/addresses/${address}`)) as Record<string, unknown>;
  return {
    is_contract: !!data.is_contract,
    name: data.name as string | undefined,
    creator_address_hash: data.creator_address_hash as string | undefined,
    creation_tx_hash: data.creation_tx_hash as string | undefined,
    token: data.token as { name: string; symbol: string; type: string } | undefined,
  };
}

// ── Blockscout → Etherscan-compatible type normalizers ─────────────────────

function normalizeBlockscoutTx(raw: unknown): BasescanTx {
  const tx = raw as Record<string, unknown>;
  const decoded = tx.decoded_input as { method_call?: string; method_id?: string } | null;
  return {
    blockNumber: String(tx.block ?? ''),
    timeStamp: tx.timestamp ? String(Math.floor(new Date(tx.timestamp as string).getTime() / 1000)) : '',
    hash: String(tx.hash ?? ''),
    from: String((tx.from as Record<string, unknown>)?.hash ?? tx.from ?? ''),
    to: String((tx.to as Record<string, unknown>)?.hash ?? tx.to ?? ''),
    value: String(tx.value ?? '0'),
    input: String(tx.raw_input ?? ''),
    contractAddress: String((tx.created_contract as Record<string, unknown>)?.hash ?? ''),
    isError: tx.status === 'error' ? '1' : '0',
    functionName: decoded?.method_call?.split('(')[0] ?? '',
    methodId: tx.method ? String(tx.method) : (decoded?.method_id ?? ''),
  };
}

function normalizeBlockscoutInternalTx(raw: unknown): InternalTx {
  const tx = raw as Record<string, unknown>;
  return {
    blockNumber: String(tx.block ?? tx.block_number ?? ''),
    timeStamp: tx.timestamp ? String(Math.floor(new Date(tx.timestamp as string).getTime() / 1000)) : '',
    hash: String(tx.transaction_hash ?? ''),
    from: String((tx.from as Record<string, unknown>)?.hash ?? tx.from ?? ''),
    to: String((tx.to as Record<string, unknown>)?.hash ?? tx.to ?? ''),
    value: String(tx.value ?? '0'),
    contractAddress: String((tx.created_contract as Record<string, unknown>)?.hash ?? ''),
    input: String(tx.input ?? ''),
    type: String(tx.type ?? ''),
    isError: tx.success === false ? '1' : '0',
  };
}
