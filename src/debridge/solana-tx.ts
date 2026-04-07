/**
 * Solana transaction preparation and submission for deBridge bridge orders.
 *
 * The deBridge API returns a hex-encoded VersionedTransaction. This module handles:
 *   1. Hex deserialization with validation
 *   2. Blockhash refresh (API blockhash may be stale)
 *   3. Compute unit estimation via simulation
 *   4. Priority fee calculation
 *   5. Compute budget instruction injection (decompile → add → recompile)
 *   6. Signing and submission with confirmation
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  VersionedMessage,
  TransactionMessage,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
  type MessageCompiledInstruction,
} from '@solana/web3.js';

/** Default compute unit budget when simulation fails or returns no data */
export const DEFAULT_COMPUTE_UNITS = 200_000;

/** Default priority fee in microLamports when RPC fee data is unavailable */
const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1_000;

/** Structured log entry — JSON to stdout, greppable by module/phase/action */
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

// ---------------------------------------------------------------------------
// Hex utilities (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Strip `0x` or `0X` prefix from a hex string if present.
 * Pure function — no side effects.
 */
export function stripHexPrefix(hex: string): string {
  if (hex.startsWith('0x') || hex.startsWith('0X')) {
    return hex.slice(2);
  }
  return hex;
}

/**
 * Validate that a string is valid hex: non-empty, even length, only hex chars.
 * Throws with descriptive error on any violation.
 */
export function validateHexString(hex: string): void {
  if (!hex || hex.length === 0) {
    throw new Error('Transaction hex data is empty');
  }
  if (hex.length % 2 !== 0) {
    throw new Error(
      `Transaction hex data has odd length (${hex.length}) — invalid hex encoding`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Transaction hex data contains non-hex characters');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the compiled instructions from a VersionedMessage in a version-agnostic way.
 */
function getInstructions(message: VersionedMessage): MessageCompiledInstruction[] {
  // Both Message (legacy) and MessageV0 expose compiledInstructions in recent @solana/web3.js
  if ('compiledInstructions' in message) {
    return message.compiledInstructions as MessageCompiledInstruction[];
  }
  // Fallback for older types — legacy Message has .instructions
  if ('instructions' in message) {
    return (message as unknown as { instructions: MessageCompiledInstruction[] }).instructions;
  }
  return [];
}

/**
 * Check whether the transaction already includes ComputeBudget program instructions.
 */
function hasComputeBudgetInstructions(message: VersionedMessage): boolean {
  const computeBudgetId = ComputeBudgetProgram.programId;
  return message.staticAccountKeys.some((key) => key.equals(computeBudgetId));
}

/**
 * Resolve address lookup table accounts needed to decompile a V0 message.
 */
async function resolveAddressLookupTables(
  connection: Connection,
  message: VersionedMessage
): Promise<AddressLookupTableAccount[]> {
  const lookups = message.addressTableLookups;
  if (!lookups || lookups.length === 0) return [];

  log('solana_tx', 'alt:resolving', { count: lookups.length });

  const accounts: AddressLookupTableAccount[] = [];
  for (const lookup of lookups) {
    const result = await connection.getAddressLookupTable(lookup.accountKey);
    if (result.value) {
      accounts.push(result.value);
    }
  }

  log('solana_tx', 'alt:resolved', { resolved: accounts.length });
  return accounts;
}

/**
 * Compute the median priority fee from recent prioritization fee samples.
 * Returns the default if RPC call fails or no data is available.
 */
async function getMedianPriorityFee(connection: Connection): Promise<number> {
  try {
    const recentFees = await connection.getRecentPrioritizationFees();
    const nonZero = recentFees
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0)
      .sort((a, b) => a - b);

    if (nonZero.length > 0) {
      const median = nonZero[Math.floor(nonZero.length / 2)];
      log('solana_tx', 'priorityFee:done', { microLamports: median, samples: nonZero.length });
      return median;
    }

    log('solana_tx', 'priorityFee:noData', { fallback: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS });
    return DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  } catch (err) {
    log('solana_tx', 'priorityFee:error', {
      error: err instanceof Error ? err.message : String(err),
      fallback: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
    });
    return DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  }
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

/**
 * Prepare a deBridge-returned Solana transaction for signing and submission.
 *
 * Steps:
 *   1. Strip 0x prefix, validate hex, deserialize VersionedTransaction
 *   2. Refresh recentBlockhash (API's may be stale — 30s window)
 *   3. Simulate to estimate compute units (falls back to 200k on failure)
 *   4. If no ComputeBudget instructions exist, inject them via decompile/recompile
 *   5. Sign with the provided wallet keypair
 *
 * Returns the signed VersionedTransaction ready for submission.
 */
export async function prepareSolanaTransaction(
  connection: Connection,
  txDataHex: string,
  wallet: Keypair
): Promise<VersionedTransaction> {
  // 1. Hex validation and deserialization
  const hex = stripHexPrefix(txDataHex);
  validateHexString(hex);

  log('solana_tx', 'deserialize:start', { hexLength: hex.length });

  const buffer = Buffer.from(hex, 'hex');
  const transaction = VersionedTransaction.deserialize(new Uint8Array(buffer));

  const instructions = getInstructions(transaction.message);
  if (instructions.length === 0) {
    throw new Error(
      'Deserialized transaction has no instructions — refusing to sign an empty transaction'
    );
  }

  log('solana_tx', 'deserialize:done', {
    numInstructions: instructions.length,
    version: transaction.version,
  });

  // 2. Refresh blockhash
  log('solana_tx', 'blockhash:start');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.message.recentBlockhash = blockhash;
  log('solana_tx', 'blockhash:done', {
    blockhash: blockhash.slice(0, 12) + '...',
    lastValidBlockHeight,
  });

  // 3. Simulate for compute units
  log('solana_tx', 'simulate:start');
  let computeUnits = DEFAULT_COMPUTE_UNITS;

  try {
    const simResult = await connection.simulateTransaction(transaction, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });

    if (simResult.value.err) {
      log('solana_tx', 'simulate:error', {
        error: JSON.stringify(simResult.value.err),
        logs: simResult.value.logs?.slice(-5),
      });
      // Fall back to default — simulation failure is non-fatal
      log('solana_tx', 'simulate:fallback', { computeUnits: DEFAULT_COMPUTE_UNITS });
    } else if (simResult.value.unitsConsumed != null && simResult.value.unitsConsumed > 0) {
      computeUnits = Math.ceil(simResult.value.unitsConsumed * 1.1);
      log('solana_tx', 'simulate:done', {
        unitsConsumed: simResult.value.unitsConsumed,
        budgetWithMargin: computeUnits,
      });
    } else {
      log('solana_tx', 'simulate:noUnits', { fallback: DEFAULT_COMPUTE_UNITS });
    }
  } catch (err) {
    // RPC error during simulation — non-fatal, use default
    log('solana_tx', 'simulate:rpcError', {
      error: err instanceof Error ? err.message : String(err),
      fallback: DEFAULT_COMPUTE_UNITS,
    });
  }

  // 4. Add compute budget instructions if not already present
  if (!hasComputeBudgetInstructions(transaction.message)) {
    log('solana_tx', 'computeBudget:adding', { computeUnits });

    // Resolve ALTs for decompile
    const altAccounts = await resolveAddressLookupTables(connection, transaction.message);

    // Decompile the message to modify instructions
    const txMessage = TransactionMessage.decompile(transaction.message, {
      addressLookupTableAccounts: altAccounts,
    });

    // Get priority fee
    const priorityFee = await getMedianPriorityFee(connection);

    // Prepend compute budget instructions
    const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits });
    const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee,
    });
    txMessage.instructions = [computeUnitLimitIx, computeUnitPriceIx, ...txMessage.instructions];

    // Recompile to V0 message
    const newMessage = txMessage.compileToV0Message(altAccounts);
    const newTx = new VersionedTransaction(newMessage);

    // Sign the recompiled transaction
    log('solana_tx', 'sign:start');
    newTx.sign([wallet]);
    log('solana_tx', 'sign:done', { signer: wallet.publicKey.toBase58() });

    return newTx;
  }

  log('solana_tx', 'computeBudget:exists', { skippingInjection: true });

  // 5. Sign the original transaction (compute budget already present)
  log('solana_tx', 'sign:start');
  transaction.sign([wallet]);
  log('solana_tx', 'sign:done', { signer: wallet.publicKey.toBase58() });

  return transaction;
}

/**
 * Submit a signed VersionedTransaction and wait for confirmation.
 *
 * Uses `confirmed` commitment for fast feedback. Returns the transaction signature.
 * Throws on send failure or confirmation timeout.
 */
export async function sendAndConfirmBridgeTransaction(
  connection: Connection,
  transaction: VersionedTransaction
): Promise<string> {
  log('solana_tx', 'send:start');

  // Get fresh blockhash context for confirmation strategy
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
  });

  log('solana_tx', 'send:submitted', { signature });

  // Wait for confirmation
  log('solana_tx', 'confirm:start', { signature, lastValidBlockHeight });

  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  if (confirmation.value.err) {
    const errStr = JSON.stringify(confirmation.value.err);
    log('solana_tx', 'confirm:failed', { signature, error: errStr });
    throw new Error(`Transaction confirmed but failed on-chain: ${errStr}`);
  }

  log('solana_tx', 'confirm:done', { signature });

  return signature;
}
