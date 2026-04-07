/**
 * Solana chain configuration — connection factory, keypair loading, and known addresses.
 * Follows the pattern established in src/config/chains.ts for Base.
 */

import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** Known token/program addresses on Solana mainnet */
export const SOLANA_KNOWN_ADDRESSES = {
  /** USDC (SPL token) on Solana — Circle native */
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  /** Native SOL placeholder (system program) */
  NATIVE_SOL: '11111111111111111111111111111111',
} as const;

/** Solana RPC endpoints — primary + fallbacks */
const SOLANA_RPCS = [
  'https://api.mainnet-beta.solana.com',
];

/**
 * Create a Solana connection. Uses SOL_RPC_URL env var if set,
 * otherwise falls back to public mainnet RPC.
 */
export function createSolanaConnection(rpcUrl?: string): Connection {
  const url = rpcUrl ?? process.env.SOL_RPC_URL ?? SOLANA_RPCS[0];
  return new Connection(url, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });
}

/**
 * Load a Solana keypair from a base58-encoded private key string.
 * Throws with a descriptive message if the key is invalid.
 * Never logs the key material.
 */
export function loadSolanaKeypair(base58PrivateKey: string): Keypair {
  if (!base58PrivateKey || base58PrivateKey.trim().length === 0) {
    throw new Error('Solana private key is empty — set SOL_PRIVATE_KEY env var');
  }
  try {
    const decoded = bs58.decode(base58PrivateKey.trim());
    return Keypair.fromSecretKey(decoded);
  } catch (err) {
    throw new Error(
      `Failed to decode Solana private key: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
