#!/usr/bin/env tsx
/**
 * Bridge USDC from Solana to Base via deBridge DLN API.
 *
 * Modes:
 *   --estimate-only   Dry-run estimation (no wallet needed). Default.
 *   Full bridge        Requires SOL_PRIVATE_KEY, SOL_RPC_URL, BASE_WALLET_ADDRESS env vars.
 *
 * Usage:
 *   npx tsx scripts/bridge-sol-to-base.ts --estimate-only --amount 0.20
 *   npx tsx scripts/bridge-sol-to-base.ts --amount 1.00
 */

import 'dotenv/config';
import { createBridgeOrder, waitForFulfillment, getOrderIdByTxHash } from '../src/debridge/api.js';
import { prepareSolanaTransaction, sendAndConfirmBridgeTransaction } from '../src/debridge/solana-tx.js';
import { createSolanaConnection, loadSolanaKeypair, SOLANA_KNOWN_ADDRESSES } from '../src/config/solana.js';
import { DeBridgeChainId } from '../src/debridge/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base USDC contract address */
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** USDC has 6 decimals on both Solana and Base */
const USDC_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Structured logging — JSON to stdout, greppable
// ---------------------------------------------------------------------------

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'bridge-script',
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
  amount: string;      // human-readable USDC amount
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    estimateOnly: false,
    amount: '0.20',
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--estimate-only') {
      args.estimateOnly = true;
    } else if (arg === '--amount' && i + 1 < argv.length) {
      args.amount = argv[++i];
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
Usage: npx tsx scripts/bridge-sol-to-base.ts [options]

Options:
  --estimate-only   Dry-run: get bridge estimation without sending a transaction.
                    No wallet or env vars needed. (default behavior if no wallet configured)
  --amount <n>      USDC amount in human units (default: 0.20)
  --help, -h        Show this help message

Environment variables (required for full bridge, not for --estimate-only):
  SOL_PRIVATE_KEY      Base58-encoded Solana wallet private key
  SOL_RPC_URL          Solana RPC endpoint (default: public mainnet-beta)
  BASE_WALLET_ADDRESS  0x-prefixed Ethereum address on Base to receive USDC

Examples:
  npx tsx scripts/bridge-sol-to-base.ts --estimate-only --amount 0.50
  npx tsx scripts/bridge-sol-to-base.ts --amount 1.00
`);
}

// ---------------------------------------------------------------------------
// Amount conversion
// ---------------------------------------------------------------------------

/** Convert human USDC amount (e.g. "0.20") to atomic units string (e.g. "200000") */
function toAtomicUnits(humanAmount: string, decimals: number): string {
  const parsed = parseFloat(humanAmount);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid amount: "${humanAmount}" — must be a positive number`);
  }
  // Use integer math to avoid floating point issues
  const factor = 10 ** decimals;
  const atomic = Math.round(parsed * factor);
  return atomic.toString();
}

// ---------------------------------------------------------------------------
// Environment validation (full bridge only)
// ---------------------------------------------------------------------------

interface BridgeEnv {
  solPrivateKey: string;
  solRpcUrl: string | undefined;
  baseWalletAddress: string;
}

function validateBridgeEnv(): BridgeEnv {
  const missing: string[] = [];

  if (!process.env.SOL_PRIVATE_KEY) missing.push('SOL_PRIVATE_KEY (base58-encoded Solana private key)');
  if (!process.env.BASE_WALLET_ADDRESS) missing.push('BASE_WALLET_ADDRESS (0x-prefixed Ethereum address)');

  if (missing.length > 0) {
    console.error('\nMissing required environment variables:');
    for (const m of missing) {
      console.error(`  • ${m}`);
    }
    console.error('\nExample .env:');
    console.error('  SOL_PRIVATE_KEY=5Kd3NBU...');
    console.error('  SOL_RPC_URL=https://api.mainnet-beta.solana.com');
    console.error('  BASE_WALLET_ADDRESS=0xYour...Address\n');
    process.exit(1);
  }

  const baseAddr = process.env.BASE_WALLET_ADDRESS!;
  if (!baseAddr.startsWith('0x') || baseAddr.length !== 42) {
    console.error(`Invalid BASE_WALLET_ADDRESS: must be 0x-prefixed, 42 chars. Got: ${baseAddr.slice(0, 6)}...`);
    process.exit(1);
  }

  // Validate SOL_PRIVATE_KEY is base58 decodable (don't log it)
  try {
    loadSolanaKeypair(process.env.SOL_PRIVATE_KEY!);
  } catch (err) {
    console.error(`Invalid SOL_PRIVATE_KEY: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  return {
    solPrivateKey: process.env.SOL_PRIVATE_KEY!,
    solRpcUrl: process.env.SOL_RPC_URL,
    baseWalletAddress: baseAddr,
  };
}

// ---------------------------------------------------------------------------
// Estimate-only mode
// ---------------------------------------------------------------------------

async function runEstimateOnly(amountHuman: string): Promise<void> {
  const atomicAmount = toAtomicUnits(amountHuman, USDC_DECIMALS);

  log('estimate', 'start', {
    amountHuman,
    atomicAmount,
    srcChain: 'Solana',
    dstChain: 'Base',
    token: 'USDC',
  });

  const response = await createBridgeOrder({
    srcChainId: DeBridgeChainId.SOLANA,
    srcChainTokenIn: SOLANA_KNOWN_ADDRESSES.USDC,
    srcChainTokenInAmount: atomicAmount,
    dstChainId: DeBridgeChainId.BASE,
    dstChainTokenOut: BASE_USDC,
    prependOperatingExpenses: true,
    // No recipient — estimation only
  });

  const est = response.estimation;
  const srcAmount = est?.srcChainTokenIn?.amount;
  const dstAmount = est?.dstChainTokenOut?.amount;
  const dstRecommended = est?.dstChainTokenOut?.recommendedAmount;

  log('estimate', 'done', {
    orderId: response.orderId,
    fixFee: response.fixFee,
    srcTokenIn: {
      symbol: est?.srcChainTokenIn?.symbol,
      amount: srcAmount,
      amountHuman: srcAmount ? (parseInt(srcAmount) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS) : null,
    },
    dstTokenOut: {
      symbol: est?.dstChainTokenOut?.symbol,
      amount: dstAmount,
      amountHuman: dstAmount ? (parseInt(dstAmount) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS) : null,
      recommendedAmount: dstRecommended,
    },
    slippage: est?.recommendedSlippage,
    userPoints: response.userPoints,
  });

  // Human-readable summary
  const inputAmt = srcAmount ? (parseInt(srcAmount) / 10 ** USDC_DECIMALS).toFixed(2) : '?';
  const outputAmt = dstAmount ? (parseInt(dstAmount) / 10 ** USDC_DECIMALS).toFixed(2) : '?';
  console.log(`\n✅ Bridge estimation successful:`);
  console.log(`   Input:  ${inputAmt} USDC (Solana)`);
  console.log(`   Output: ${outputAmt} USDC (Base)`);
  console.log(`   Fee:    ${response.fixFee}`);
  console.log(`   Order:  ${response.orderId}\n`);
}

// ---------------------------------------------------------------------------
// Full bridge mode
// ---------------------------------------------------------------------------

async function runFullBridge(amountHuman: string): Promise<void> {
  const env = validateBridgeEnv();
  const atomicAmount = toAtomicUnits(amountHuman, USDC_DECIMALS);

  log('bridge', 'start', {
    amountHuman,
    atomicAmount,
    srcChain: 'Solana',
    dstChain: 'Base',
    // Never log SOL_PRIVATE_KEY
    baseWallet: env.baseWalletAddress,
  });

  // Phase 1: Create bridge order
  log('bridge', 'phase:createOrder');
  const orderResponse = await createBridgeOrder({
    srcChainId: DeBridgeChainId.SOLANA,
    srcChainTokenIn: SOLANA_KNOWN_ADDRESSES.USDC,
    srcChainTokenInAmount: atomicAmount,
    dstChainId: DeBridgeChainId.BASE,
    dstChainTokenOut: BASE_USDC,
    dstChainTokenOutRecipient: env.baseWalletAddress,
    prependOperatingExpenses: true,
  });

  log('bridge', 'orderCreated', {
    orderId: orderResponse.orderId,
    hasTxData: !!orderResponse.tx?.data,
  });

  if (!orderResponse.tx?.data) {
    throw new Error('Bridge order response missing transaction data — cannot proceed');
  }

  // Phase 2: Prepare and sign Solana transaction
  log('bridge', 'phase:prepareTx');
  const connection = createSolanaConnection(env.solRpcUrl);
  const wallet = loadSolanaKeypair(env.solPrivateKey);

  const signedTx = await prepareSolanaTransaction(
    connection,
    orderResponse.tx.data,
    wallet
  );

  // Phase 3: Submit transaction
  log('bridge', 'phase:submitTx');
  const txSignature = await sendAndConfirmBridgeTransaction(connection, signedTx);

  log('bridge', 'txConfirmed', {
    txSignature,
    solscanUrl: `https://solscan.io/tx/${txSignature}`,
    orderId: orderResponse.orderId,
  });

  // Phase 4: Poll for fulfillment
  log('bridge', 'phase:waitFulfillment');

  // First, get the order ID from the tx hash (may take a moment to index)
  let orderId = orderResponse.orderId;
  if (!orderId) {
    log('bridge', 'lookupOrderId', { txSignature });
    const lookedUp = await getOrderIdByTxHash(txSignature, DeBridgeChainId.SOLANA);
    if (!lookedUp) {
      console.error('⚠️  Could not look up order ID from tx hash. Use check-bridge-status.ts to monitor.');
      console.log(`   Solana tx: ${txSignature}`);
      process.exit(0);
    }
    orderId = lookedUp;
  }

  const fulfillment = await waitForFulfillment(orderId, {
    maxAttempts: 60,    // 5 minutes at 5s intervals
    intervalMs: 5_000,
  });

  log('bridge', 'fulfilled', {
    orderId,
    status: fulfillment.status,
    fulfillTx: fulfillment.fulfillTransactionHash,
  });

  // Final summary
  console.log(`\n✅ Bridge complete!`);
  console.log(`   Solana TX:   https://solscan.io/tx/${txSignature}`);
  console.log(`   Order ID:    ${orderId}`);
  if (fulfillment.fulfillTransactionHash) {
    console.log(`   Base TX:     https://basescan.org/tx/${fulfillment.fulfillTransactionHash}`);
  }
  console.log(`   Status:      ${fulfillment.status}\n`);
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
      await runFullBridge(args.amount);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('bridge', 'error', { error: message });
    console.error(`\n❌ Bridge failed: ${message}\n`);
    process.exit(1);
  }
}

main();
