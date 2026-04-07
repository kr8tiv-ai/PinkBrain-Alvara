/**
 * USDC → ETH swap on Base via 1inch Swap API (v6.0).
 *
 * Handles ERC-20 approval check + approve if needed, then fetches optimal
 * swap calldata from 1inch and executes the transaction on-chain.
 *
 * See: K005 (Alvara uses 1inch router for DEX swaps)
 */

import {
  type Address,
  type Hash,
  encodeFunctionData,
  erc20Abi,
} from 'viem';
import { KNOWN_ADDRESSES } from '../config/chains.js';

// Use loose typing to avoid viem chain-specific generics mismatch
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPublicClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWalletClient = any;

// ── Constants ───────────────────────────────────────────────────────────

/** 1inch Aggregation Router v6 on Base */
export const ONEINCH_ROUTER_BASE: Address = '0x111111125421cA6dc452d289314280a0f8842A65';

/** Base chain ID */
const BASE_CHAIN_ID = 8453;

/** 1inch API base URL */
const ONEINCH_API_BASE = `https://api.1inch.dev/swap/v6.0/${BASE_CHAIN_ID}`;

/** Native ETH placeholder address used by 1inch */
const NATIVE_ETH: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Request timeout for 1inch API calls (ms) */
const API_TIMEOUT_MS = 15_000;

// ── Types ───────────────────────────────────────────────────────────────

export interface SwapUsdcToEthOptions {
  /** Viem public client for Base reads */
  publicClient: AnyPublicClient;
  /** Viem wallet client for Base signing/sending */
  walletClient: AnyWalletClient;
  /** USDC amount to swap (atomic units — 6 decimals) */
  usdcAmount: bigint;
  /** Slippage tolerance in percent (default: 1) */
  slippagePercent?: number;
}

export interface SwapUsdcToEthResult {
  /** Transaction hash of the swap */
  txHash: Hash;
  /** ETH received in wei */
  ethReceived: bigint;
}

interface OneInchSwapResponse {
  tx: {
    from: string;
    to: string;
    data: string;
    value: string;
    gas: number;
    gasPrice: string;
  };
  toAmount: string;
}

// ── Logging ─────────────────────────────────────────────────────────────

function log(action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'evm-swap',
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ── Approval helpers ────────────────────────────────────────────────────

async function checkAllowance(
  publicClient: AnyPublicClient,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: KNOWN_ADDRESSES.USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  }) as Promise<bigint>;
}

async function approveUsdc(
  publicClient: AnyPublicClient,
  walletClient: AnyWalletClient,
  spender: Address,
  amount: bigint,
): Promise<Hash> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  });

  const txHash = await walletClient.sendTransaction({
    to: KNOWN_ADDRESSES.USDC,
    data,
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  log('approve_sent', { txHash, spender, amount: String(amount) });

  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  log('approve_confirmed', { txHash });

  return txHash;
}

// ── 1inch API ───────────────────────────────────────────────────────────

async function fetch1inchSwap(
  fromAddress: Address,
  usdcAmount: bigint,
  slippagePercent: number,
): Promise<OneInchSwapResponse> {
  const params = new URLSearchParams({
    src: KNOWN_ADDRESSES.USDC,
    dst: NATIVE_ETH,
    amount: usdcAmount.toString(),
    from: fromAddress,
    slippage: slippagePercent.toString(),
    disableEstimate: 'false',
    allowPartialFill: 'false',
  });

  const url = `${ONEINCH_API_BASE}/swap?${params}`;
  log('api_request', { url: url.replace(/from=[^&]+/, 'from=REDACTED') });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${process.env.ONEINCH_API_KEY ?? ''}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      throw new Error(`1inch Swap API timeout after ${API_TIMEOUT_MS}ms`);
    }
    throw new Error(`1inch Swap API request failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch { /* ignore */ }
    throw new Error(
      `1inch Swap API error ${response.status}: ${errorBody.slice(0, 500)}`,
    );
  }

  const data = await response.json() as Record<string, unknown>;

  // Validate response shape
  const tx = data.tx as Record<string, unknown> | undefined;
  if (!tx || typeof tx.data !== 'string' || typeof tx.to !== 'string') {
    throw new Error(
      `1inch Swap API returned invalid response: missing tx.data or tx.to — got keys: ${Object.keys(data).join(', ')}`,
    );
  }

  if (typeof data.toAmount !== 'string') {
    throw new Error(
      `1inch Swap API returned invalid response: missing toAmount — got keys: ${Object.keys(data).join(', ')}`,
    );
  }

  log('api_response', {
    toAmount: data.toAmount,
    gasEstimate: tx.gas,
  });

  return data as unknown as OneInchSwapResponse;
}

// ── Main swap function ──────────────────────────────────────────────────

/**
 * Swap USDC → ETH on Base via 1inch.
 *
 * 1. Check USDC allowance for 1inch router, approve if insufficient.
 * 2. Fetch swap calldata from 1inch Swap API.
 * 3. Send the swap transaction.
 * 4. Wait for confirmation, read ETH balance delta.
 *
 * @throws on API failure, timeout, approval failure, or tx revert.
 */
export async function swapUsdcToEth(opts: SwapUsdcToEthOptions): Promise<SwapUsdcToEthResult> {
  const { publicClient, walletClient, usdcAmount, slippagePercent = 1 } = opts;
  const account = walletClient.account!.address as Address;

  if (usdcAmount <= 0n) {
    throw new Error('swapUsdcToEth: usdcAmount must be > 0');
  }

  log('start', { account, usdcAmount: String(usdcAmount), slippagePercent });

  // 1. Check and handle USDC approval
  const allowance = await checkAllowance(publicClient, account, ONEINCH_ROUTER_BASE);
  log('allowance_checked', { current: String(allowance), needed: String(usdcAmount) });

  if (allowance < usdcAmount) {
    log('approval_needed', { deficit: String(usdcAmount - allowance) });
    await approveUsdc(publicClient, walletClient, ONEINCH_ROUTER_BASE, usdcAmount);
  }

  // 2. Get ETH balance before swap
  const ethBefore = (await publicClient.getBalance({ address: account })) as bigint;

  // 3. Fetch swap calldata from 1inch
  const swapResponse = await fetch1inchSwap(account, usdcAmount, slippagePercent);

  // 4. Send the swap transaction
  const txHash = await walletClient.sendTransaction({
    to: swapResponse.tx.to as Address,
    data: swapResponse.tx.data as `0x${string}`,
    value: BigInt(swapResponse.tx.value),
    gas: BigInt(swapResponse.tx.gas) + BigInt(swapResponse.tx.gas) / 10n, // 10% buffer
    chain: walletClient.chain,
    account: walletClient.account!,
  });

  log('swap_tx_sent', { txHash });

  // 5. Wait for confirmation
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });

  if (receipt.status === 'reverted') {
    throw new Error(`USDC→ETH swap transaction reverted: ${txHash}`);
  }

  log('swap_tx_confirmed', {
    txHash,
    gasUsed: String(receipt.gasUsed),
    blockNumber: String(receipt.blockNumber),
  });

  // 6. Compute ETH received from balance delta
  const ethAfter = (await publicClient.getBalance({ address: account })) as bigint;
  const ethReceived = ethAfter - ethBefore;

  log('complete', {
    txHash,
    ethReceived: String(ethReceived),
    expectedAmount: swapResponse.toAmount,
  });

  return { txHash, ethReceived };
}
