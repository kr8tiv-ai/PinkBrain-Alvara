/**
 * Fee claiming operations — get claim transactions and sign+send them.
 * Wraps BagsSDK.fee service for fetching claim transactions, plus a standalone
 * sign-and-send flow for executing them on-chain.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { BagsSDK } from '@bagsfm/bags-sdk';
import { log } from './client.js';

/** Base58 alphabet — 32-44 chars, no 0/O/I/l */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function validateWallet(wallet: string, fn: string): void {
  if (!wallet || wallet.trim().length === 0) {
    throw new Error(`${fn}: wallet address is required`);
  }
  if (!BASE58_RE.test(wallet.trim())) {
    throw new Error(`${fn}: invalid wallet address format — expected base58`);
  }
}

function validateMint(mint: string, fn: string): void {
  if (!mint || mint.trim().length === 0) {
    throw new Error(`${fn}: token mint address is required`);
  }
  if (!BASE58_RE.test(mint.trim())) {
    throw new Error(`${fn}: invalid token mint format — expected base58`);
  }
}

/**
 * Get claim transactions for a specific wallet + token mint.
 * Wraps `sdk.fee.getClaimTransactions()`.
 *
 * Returns the legacy Transaction objects from the SDK. Callers can serialize
 * or sign them as needed.
 */
export async function getClaimTransactions(
  sdk: BagsSDK,
  wallet: string,
  tokenMint: string
) {
  validateWallet(wallet, 'getClaimTransactions');
  validateMint(tokenMint, 'getClaimTransactions');

  log('claim', 'getClaimTransactions:start', { wallet, tokenMint });

  try {
    const transactions = await sdk.fee.getClaimTransactions(
      new PublicKey(wallet),
      new PublicKey(tokenMint)
    );

    log('claim', 'getClaimTransactions:ok', {
      wallet,
      tokenMint,
      count: transactions.length,
    });

    return transactions;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('claim', 'getClaimTransactions:error', {
      wallet,
      tokenMint,
      error: message,
    });
    throw new Error(
      `getClaimTransactions failed for wallet ${wallet}, mint ${tokenMint}: ${message}`
    );
  }
}

/**
 * Sign and send an array of base64-encoded VersionedTransactions.
 * Deserializes each transaction, signs with the provided keypair,
 * sends via the connection, and waits for confirmation.
 *
 * @param connection - Solana connection to send through
 * @param keypair - Keypair to sign each transaction
 * @param serializedTransactions - Array of base64-encoded VersionedTransaction buffers
 * @returns Array of transaction signature strings (base58)
 */
export async function signAndSendClaimTransactions(
  connection: Connection,
  keypair: Keypair,
  serializedTransactions: string[]
): Promise<string[]> {
  if (!serializedTransactions || serializedTransactions.length === 0) {
    log('claim', 'signAndSend:skip', { reason: 'no transactions to send' });
    return [];
  }

  log('claim', 'signAndSend:start', { count: serializedTransactions.length });

  const signatures: string[] = [];

  for (let i = 0; i < serializedTransactions.length; i++) {
    const serialized = serializedTransactions[i];

    // Decode base64 → buffer → VersionedTransaction
    const buffer = Buffer.from(serialized, 'base64');
    const message = VersionedMessage.deserialize(buffer);
    const tx = new VersionedTransaction(message);

    // Sign
    tx.sign([keypair]);

    log('claim', 'signAndSend:sending', {
      index: i,
      total: serializedTransactions.length,
    });

    // Send
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // Confirm — check lastValidBlockHeight for expiry
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed'
    );

    if (confirmation.value.err) {
      log('claim', 'signAndSend:txFailed', {
        index: i,
        signature,
        error: JSON.stringify(confirmation.value.err),
      });
      throw new Error(
        `Transaction ${i} failed on-chain: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    log('claim', 'signAndSend:confirmed', { index: i, signature });
    signatures.push(signature);
  }

  log('claim', 'signAndSend:ok', {
    count: signatures.length,
    signatures,
  });

  return signatures;
}
