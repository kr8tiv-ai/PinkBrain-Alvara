/**
 * deBridge DLN API client — thin wrapper over the REST endpoints for cross-chain bridging.
 *
 * Endpoints:
 *   POST  https://dln.debridge.finance/v1.0/dln/order/create-tx
 *   GET   https://stats-api.dln.trade/api/Transaction/{txHash}/orderIds
 *   GET   https://stats-api.dln.trade/api/Orders/{orderId}
 */

import type {
  DeBridgeOrderInput,
  DeBridgeOrderResponse,
  DeBridgeOrderStatus,
} from './types.js';

const DLN_API_BASE = 'https://dln.debridge.finance/v1.0';
const STATS_API_BASE = 'https://stats-api.dln.trade/api';

const DLN_TIMEOUT_MS = 15_000;
const STATS_TIMEOUT_MS = 10_000;

/** Structured log entry — JSON to stdout, greppable by phase/action */
function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'debridge',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

/** Fetch with abort-controller timeout */
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

/**
 * Validate required fields on a DeBridgeOrderInput before making an API call.
 * Throws with a descriptive message on invalid input.
 */
function validateOrderInput(params: DeBridgeOrderInput): void {
  if (!params.srcChainTokenIn) {
    throw new Error('DeBridge order: srcChainTokenIn is required');
  }
  if (!params.srcChainTokenInAmount || params.srcChainTokenInAmount === '0') {
    throw new Error(
      'DeBridge order: srcChainTokenInAmount must be a non-zero atomic units string'
    );
  }
  if (!params.dstChainTokenOut) {
    throw new Error('DeBridge order: dstChainTokenOut is required');
  }
  if (!params.srcChainId) {
    throw new Error('DeBridge order: srcChainId is required');
  }
  if (!params.dstChainId) {
    throw new Error('DeBridge order: dstChainId is required');
  }
}

/**
 * Create a bridge order via the DLN create-tx endpoint.
 * Returns the full order response including tx data and estimation.
 *
 * Defaults prependOperatingExpenses to true if not explicitly set.
 */
export async function createBridgeOrder(
  params: DeBridgeOrderInput
): Promise<DeBridgeOrderResponse> {
  validateOrderInput(params);

  const input: DeBridgeOrderInput = {
    ...params,
    prependOperatingExpenses: params.prependOperatingExpenses ?? true,
  };

  const searchParams = new URLSearchParams();
  searchParams.set('srcChainId', String(input.srcChainId));
  searchParams.set('srcChainTokenIn', input.srcChainTokenIn);
  searchParams.set('srcChainTokenInAmount', input.srcChainTokenInAmount);
  searchParams.set('dstChainId', String(input.dstChainId));
  searchParams.set('dstChainTokenOut', input.dstChainTokenOut);
  searchParams.set(
    'prependOperatingExpenses',
    String(input.prependOperatingExpenses)
  );
  if (input.dstChainTokenOutRecipient) {
    searchParams.set('dstChainTokenOutRecipient', input.dstChainTokenOutRecipient);
  }

  const url = `${DLN_API_BASE}/dln/order/create-tx`;

  log('bridge', 'createOrder:start', {
    srcChainId: input.srcChainId,
    dstChainId: input.dstChainId,
    amount: input.srcChainTokenInAmount,
  });

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: searchParams.toString(),
    },
    DLN_TIMEOUT_MS
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `DeBridge create-tx failed: HTTP ${res.status} — ${body}`
    );
  }

  const data = await res.json();

  // Validate response has required structure
  if (!data.tx?.data && !data.estimation) {
    throw new Error(
      'DeBridge create-tx: response missing both tx.data and estimation — unexpected shape'
    );
  }

  log('bridge', 'createOrder:done', {
    orderId: data.orderId,
    hasTxData: !!data.tx?.data,
  });

  return data as DeBridgeOrderResponse;
}

/**
 * Look up an order ID from a submitted transaction hash.
 * Returns the first order ID, or null if the tx hasn't been indexed yet (404).
 */
export async function getOrderIdByTxHash(
  txHash: string,
  chainId?: number
): Promise<string | null> {
  if (!txHash) {
    throw new Error('getOrderIdByTxHash: txHash is required');
  }

  const url = `${STATS_API_BASE}/Transaction/${encodeURIComponent(txHash)}/orderIds`;

  log('status', 'getOrderId:start', { txHash, chainId });

  const res = await fetchWithTimeout(url, { method: 'GET' }, STATS_TIMEOUT_MS);

  if (res.status === 404) {
    log('status', 'getOrderId:notFound', { txHash });
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `DeBridge stats API error for tx ${txHash}: HTTP ${res.status} — ${body}`
    );
  }

  const data = await res.json();

  // Response is an array of order IDs
  if (Array.isArray(data) && data.length > 0) {
    const orderId = data[0] as string;
    log('status', 'getOrderId:found', { txHash, orderId });
    return orderId;
  }

  // Empty array — not indexed yet
  if (Array.isArray(data) && data.length === 0) {
    log('status', 'getOrderId:empty', { txHash });
    return null;
  }

  // Might return an object with orderIds field
  if (data?.orderIds && Array.isArray(data.orderIds) && data.orderIds.length > 0) {
    const orderId = data.orderIds[0] as string;
    log('status', 'getOrderId:found', { txHash, orderId });
    return orderId;
  }

  log('status', 'getOrderId:noMatch', { txHash, responseShape: typeof data });
  return null;
}

/**
 * Get the current status of a bridge order by its order ID.
 */
export async function getOrderStatus(
  orderId: string
): Promise<DeBridgeOrderStatus> {
  if (!orderId) {
    throw new Error('getOrderStatus: orderId is required');
  }

  const url = `${STATS_API_BASE}/Orders/${encodeURIComponent(orderId)}`;

  log('status', 'getOrderStatus:start', { orderId });

  const res = await fetchWithTimeout(url, { method: 'GET' }, STATS_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `DeBridge stats API error for order ${orderId}: HTTP ${res.status} — ${body}`
    );
  }

  const data = await res.json();

  // Map API response to our typed shape
  const status: DeBridgeOrderStatus = {
    orderId: data.orderId ?? orderId,
    status: data.status ?? data.state ?? 'None',
    sourceChainId: data.give?.chainId ?? data.sourceChainId ?? 0,
    destinationChainId: data.take?.chainId ?? data.destinationChainId ?? 0,
  };

  if (data.fulfillTransactionHash || data.fulfilledDstEventMetadata?.transactionHash?.stringValue) {
    status.fulfillTransactionHash =
      data.fulfillTransactionHash ??
      data.fulfilledDstEventMetadata?.transactionHash?.stringValue;
  }

  log('status', 'getOrderStatus:done', {
    orderId,
    status: status.status,
  });

  return status;
}

/**
 * Poll for order fulfillment. Resolves when the order reaches Fulfilled or ClaimedUnlock.
 * Throws after maxAttempts (default 60 × 5s = 5 minutes).
 */
export async function waitForFulfillment(
  orderId: string,
  opts?: { maxAttempts?: number; intervalMs?: number }
): Promise<DeBridgeOrderStatus> {
  const maxAttempts = opts?.maxAttempts ?? 60;
  const intervalMs = opts?.intervalMs ?? 5_000;
  const terminalStatuses = new Set(['Fulfilled', 'ClaimedUnlock']);
  const failedStatuses = new Set(['Cancelled', 'OrderCancelled']);

  log('fulfillment', 'waitStart', { orderId, maxAttempts, intervalMs });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await getOrderStatus(orderId);

    if (terminalStatuses.has(status.status)) {
      log('fulfillment', 'fulfilled', {
        orderId,
        status: status.status,
        attempt,
        fulfillTx: status.fulfillTransactionHash,
      });
      return status;
    }

    if (failedStatuses.has(status.status)) {
      throw new Error(
        `Bridge order ${orderId} reached terminal failure state: ${status.status}`
      );
    }

    log('fulfillment', 'polling', {
      orderId,
      status: status.status,
      attempt,
      maxAttempts,
    });

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(
    `Bridge order ${orderId} not fulfilled after ${maxAttempts} attempts (${(maxAttempts * intervalMs) / 1000}s)`
  );
}
