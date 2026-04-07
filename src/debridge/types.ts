/**
 * deBridge DLN API types — request/response shapes for cross-chain bridge orders.
 *
 * Covers the three DLN endpoints:
 *   - create-tx (order creation)
 *   - Transaction/{hash}/orderIds (tx → order mapping)
 *   - Orders/{id} (order status)
 */

/** Chain IDs as used by the deBridge protocol */
export const DeBridgeChainId = {
  SOLANA: 7565164,
  BASE: 8453,
  ETHEREUM: 1,
} as const;

export type DeBridgeChainIdValue = (typeof DeBridgeChainId)[keyof typeof DeBridgeChainId];

/** Input for creating a bridge order via DLN */
export interface DeBridgeOrderInput {
  /** Source chain ID (deBridge format) */
  srcChainId: number;
  /** Token address on source chain */
  srcChainTokenIn: string;
  /** Amount in atomic units (e.g. lamports, wei) as string */
  srcChainTokenInAmount: string;
  /** Destination chain ID (deBridge format) */
  dstChainId: number;
  /** Token address on destination chain */
  dstChainTokenOut: string;
  /** Recipient address on destination chain — optional for estimation */
  dstChainTokenOutRecipient?: string;
  /** Whether to prepend operating expenses to the order amount */
  prependOperatingExpenses: boolean;
}

/** Estimation details returned with an order response */
export interface DeBridgeEstimation {
  srcChainTokenIn: {
    address: string;
    amount: string;
    decimals: number;
    name: string;
    symbol: string;
  };
  srcChainTokenOut: {
    address: string;
    amount: string;
    decimals: number;
    name: string;
    symbol: string;
  };
  dstChainTokenOut: {
    address: string;
    amount: string;
    decimals: number;
    name: string;
    symbol: string;
    recommendedAmount: string;
  };
  recommendedSlippage: number;
  costsDetails: unknown[];
}

/** Transaction data returned for a bridge order */
export interface DeBridgeTxData {
  /** Serialized transaction data (hex for EVM, base64 for Solana) */
  data: string;
  /** Target contract/program address */
  to: string;
  /** Value to send (EVM only, "0" for Solana) */
  value: string;
}

/** Full response from the create-tx endpoint */
export interface DeBridgeOrderResponse {
  tx: DeBridgeTxData;
  estimation: DeBridgeEstimation;
  orderId: string;
  fixFee: string;
  userPoints: number;
  integratorPoints: number;
}

/** Order status values tracked by deBridge */
export type DeBridgeOrderStatusEnum =
  | 'None'
  | 'Created'
  | 'Fulfilled'
  | 'SentUnlock'
  | 'ClaimedUnlock'
  | 'Cancelled'
  | 'SentOrderCancel'
  | 'OrderCancelled';

/** Full order status from the stats API */
export interface DeBridgeOrderStatus {
  orderId: string;
  status: DeBridgeOrderStatusEnum;
  fulfillTransactionHash?: string;
  sourceChainId: number;
  destinationChainId: number;
}
