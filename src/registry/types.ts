/**
 * Types for the DivestmentRegistry on-chain contract client.
 *
 * Mirrors the Solidity struct `DivestmentConfig` and the parameters
 * needed for `registerConfig()`.
 */

import type { Address, Hex } from 'viem';

// ── Enums ───────────────────────────────────────────────────────────────

/** Trigger type — matches the uint8 in the contract. */
export enum TriggerType {
  Time = 0,
  Threshold = 1,
  Both = 2,
}

// ── On-chain config (read from contract) ────────────────────────────────

/** Matches DivestmentRegistry.DivestmentConfig struct. */
export interface OnChainDivestmentConfig {
  holderSplitBps: number;
  ownerSplitBps: number;
  triggerType: number;
  triggerParams: Hex;
  distributionCurrency: Address;
  creator: Address;
  registeredAt: bigint;
}

// ── Registration parameters (write to contract) ─────────────────────────

/** Input type for registerConfig(). */
export interface RegisterConfigParams {
  /** PostgreSQL fund UUID — hashed to bytes32 on-chain key */
  fundId: string;
  /** Holder share in basis points (0–10000) */
  holderSplitBps: number;
  /** Owner share in basis points (0–10000), must sum to 10000 with holderSplitBps */
  ownerSplitBps: number;
  /** Trigger type enum value */
  triggerType: TriggerType;
  /** ABI-encoded trigger parameters */
  triggerParams: Hex;
  /** ERC-20 token address for distribution payouts */
  distributionCurrency: Address;
}
