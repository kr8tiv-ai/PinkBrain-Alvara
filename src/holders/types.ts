/**
 * Type definitions for SPL token holder resolution.
 */

/** A single token holder with their balance and share. */
export interface HolderInfo {
  /** Solana wallet address (base58-encoded public key) */
  owner: string;
  /** Raw token amount in atomic units */
  amount: bigint;
  /** Percentage of total supply held, 0-100 */
  percentage: number;
}

/** Result of resolving top holders for an SPL token mint. */
export interface HolderResolutionResult {
  /** Sorted list of top holders (descending by amount) */
  holders: HolderInfo[];
  /** Sum of all holder amounts discovered (before top-N cut) */
  totalSupplyHeld: bigint;
  /** Which strategy was used to resolve holders */
  strategy: 'helius-das' | 'getProgramAccounts';
  /** The mint address that was queried */
  mint: string;
}
