#!/usr/bin/env tsx
/**
 * Jupiter Ultra V3 SOL→USDC swap proof script.
 *
 * Modes:
 *   --estimate-only   Get swap quote without executing (no wallet needed). Default.
 *   Full swap          Requires SOL_PRIVATE_KEY env var.
 *
 * Usage:
 *   npx tsx scripts/jupiter-swap.ts --estimate-only --amount 10000000
 *   npx tsx scripts/jupiter-swap.ts --amount 10000000
 */

import 'dotenv/config';
import { getSwapOrder, executeSwap, swapSolToUsdc } from '../src/jupiter/swap.js';
import { createSolanaConnection, loadSolanaKeypair, SOLANA_KNOWN_ADDRESSES } from '../src/config/solana.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const DEFAULT_AMOUNT_LAMPORTS = 10_000_000; // 0.01 SOL

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'jupiter-script',
    phase,
    action,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  estimateOnly: boolean;
  amount: number;     // lamports
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    estimateOnly: false,
    amount: DEFAULT_AMOUNT_LAMPORTS,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--estimate-only') {
      args.estimateOnly = true;
    } else if (arg === '--amount' && i + 1 < argv.length) {
      const parsed = parseInt(argv[++i], 10);
      if (isNaN(parsed) || parsed <= 0) {
        console.error(`Invalid --amount: must be a positive integer (lamports). Got: ${argv[i]}`);
        process.exit(1);
      }
      args.amount = parsed;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Usage: npx tsx scripts/jupiter-swap.ts [options]

Options:
  --estimate-only   Get swap quote without executing (no wallet needed). Default behavior.
  --amount <n>      Amount in lamports (default: ${DEFAULT_AMOUNT_LAMPORTS} = ${DEFAULT_AMOUNT_LAMPORTS / 10 ** SOL_DECIMALS} SOL)
  --help, -h        Show this help message

Environment variables (required for full swap, not for --estimate-only):
  SOL_PRIVATE_KEY   Base58-encoded Solana wallet private key
  SOL_RPC_URL       Solana RPC endpoint (default: public mainnet-beta)

Examples:
  npx tsx scripts/jupiter-swap.ts --estimate-only --amount 10000000
  npx tsx scripts/jupiter-swap.ts --amount 50000000
`);
}

// ---------------------------------------------------------------------------
// Estimate-only mode — uses a dummy taker address (no wallet needed)
// ---------------------------------------------------------------------------

async function runEstimateOnly(amountLamports: number): Promise<void> {
  const humanSol = (amountLamports / 10 ** SOL_DECIMALS).toFixed(SOL_DECIMALS);

  log('estimate', 'start', {
    amountLamports,
    humanSol,
    inputMint: SOLANA_KNOWN_ADDRESSES.WRAPPED_SOL,
    outputMint: SOLANA_KNOWN_ADDRESSES.USDC,
  });

  // Use a well-known address as dummy taker for estimation
  // (Jupiter needs a valid public key to construct the transaction)
  const dummyTaker = '11111111111111111111111111111111';

  const order = await getSwapOrder(
    SOLANA_KNOWN_ADDRESSES.WRAPPED_SOL,
    SOLANA_KNOWN_ADDRESSES.USDC,
    amountLamports,
    dummyTaker
  );

  const outHuman = (parseInt(order.outAmount) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
  const inHuman = (parseInt(order.inAmount) / 10 ** SOL_DECIMALS).toFixed(SOL_DECIMALS);

  // Jupiter may return error context alongside the quote (e.g. "Insufficient funds"
  // when using a dummy taker) — still has valid pricing data
  const orderAny = order as Record<string, unknown>;

  log('estimate', 'done', {
    requestId: order.requestId,
    type: order.type ?? orderAny.swapType,
    inAmount: order.inAmount,
    outAmount: order.outAmount,
    inHuman,
    outHuman,
    note: orderAny.error ? `Jupiter note: ${orderAny.error}` : undefined,
  });

  // Human-readable summary
  console.log(`\n✅ Jupiter swap estimation successful:`);
  console.log(`   Input:  ${inHuman} SOL (${order.inAmount} lamports)`);
  console.log(`   Output: ${outHuman} USDC (${order.outAmount} atomic)`);
  console.log(`   Type:   ${order.type ?? orderAny.swapType ?? 'N/A'}`);
  console.log(`   ReqID:  ${order.requestId}\n`);
}

// ---------------------------------------------------------------------------
// Full swap mode
// ---------------------------------------------------------------------------

async function runFullSwap(amountLamports: number): Promise<void> {
  const solPrivateKey = process.env.SOL_PRIVATE_KEY;
  if (!solPrivateKey) {
    console.error('\n❌ SOL_PRIVATE_KEY env var is required for full swap mode.');
    console.error('   Use --estimate-only for quote-only mode.\n');
    process.exit(1);
  }

  const wallet = loadSolanaKeypair(solPrivateKey);
  const connection = createSolanaConnection();

  const humanSol = (amountLamports / 10 ** SOL_DECIMALS).toFixed(SOL_DECIMALS);

  log('swap', 'start', {
    amountLamports,
    humanSol,
    taker: wallet.publicKey.toBase58(),
    // Never log private key
  });

  const result = await swapSolToUsdc(amountLamports, wallet, connection);

  const outHuman = (parseInt(result.outAmount) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
  const inHuman = (parseInt(result.inAmount) / 10 ** SOL_DECIMALS).toFixed(SOL_DECIMALS);

  log('swap', 'complete', {
    signature: result.signature,
    inAmount: result.inAmount,
    outAmount: result.outAmount,
  });

  console.log(`\n✅ Jupiter swap complete!`);
  console.log(`   Input:     ${inHuman} SOL (${result.inAmount} lamports)`);
  console.log(`   Output:    ${outHuman} USDC (${result.outAmount} atomic)`);
  console.log(`   Signature: ${result.signature}`);
  console.log(`   Solscan:   https://solscan.io/tx/${result.signature}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    if (args.estimateOnly) {
      await runEstimateOnly(args.amount);
    } else {
      await runFullSwap(args.amount);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('swap', 'error', { error: message });
    console.error(`\n❌ Jupiter swap failed: ${message}\n`);
    process.exit(1);
  }
}

main();
