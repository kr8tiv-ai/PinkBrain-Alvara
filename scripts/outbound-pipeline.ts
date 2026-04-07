#!/usr/bin/env tsx
/**
 * Outbound pipeline CLI — manual end-to-end testing.
 *
 * Modes:
 *   --dry-run   Load fund, validate, and print what the pipeline would do. No transactions.
 *   Live run    Executes claim → swap → protocol fee → bridge. Requires all env vars.
 *
 * Usage:
 *   npx tsx scripts/outbound-pipeline.ts --dry-run --fund-id <uuid>
 *   npx tsx scripts/outbound-pipeline.ts --fund-id <uuid>
 */

import 'dotenv/config';
import { runOutboundPipeline } from '../src/pipeline/outbound.js';
import { createSolanaConnection, loadSolanaKeypair } from '../src/config/solana.js';
import { createBagsClient } from '../src/bags/client.js';
import { createDb, closeDb } from '../src/db/connection.js';
import { getFundById, getFundWallets } from '../src/db/fund-repository.js';

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'outbound-script',
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
  fundId: string | null;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fundId: null,
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fund-id' && i + 1 < argv.length) {
      args.fundId = argv[++i];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
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
Usage: npx tsx scripts/outbound-pipeline.ts [options]

Options:
  --fund-id <uuid>  Fund ID to process (required)
  --dry-run         Load fund and print what would happen, without executing
  --help, -h        Show this help message

Environment variables:
  DATABASE_URL              PostgreSQL connection string (required)
  SOL_PRIVATE_KEY           Base58-encoded Solana wallet private key (live mode)
  PLATFORM_TREASURY_WALLET  Base58 Solana address for protocol fees (live mode)
  BAGS_API_KEY              Bags FM API key (live mode)
  SOL_RPC_URL               Solana RPC endpoint (optional, defaults to public mainnet)

Examples:
  # Dry run — validate fund and show planned actions
  npx tsx scripts/outbound-pipeline.ts --dry-run --fund-id 550e8400-e29b-41d4-a716-446655440000

  # Live run — execute the full outbound pipeline
  npx tsx scripts/outbound-pipeline.ts --fund-id 550e8400-e29b-41d4-a716-446655440000
`);
}

// ---------------------------------------------------------------------------
// Env var validation
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`\n❌ Missing required environment variable: ${name}\n`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

async function runDryRun(fundId: string): Promise<void> {
  log('dry-run', 'start', { fundId });

  const db = createDb();

  try {
    const fund = await getFundById(db, fundId);
    if (!fund) {
      console.error(`\n❌ Fund not found: ${fundId}\n`);
      process.exit(1);
    }

    const wallets = await getFundWallets(db, fundId);
    const solWallet = wallets.find((w) => w.chain === 'solana');
    const baseWallet = wallets.find((w) => w.chain === 'base');

    console.log(`\n📋 Fund Details:`);
    console.log(`   ID:              ${fund.id}`);
    console.log(`   Name:            ${fund.name}`);
    console.log(`   Status:          ${fund.status}`);
    console.log(`   Token Mint:      ${fund.tokenMint}`);
    console.log(`   Target Chain:    ${fund.targetChain}`);
    console.log(`   Protocol Fee:    ${fund.protocolFeeBps} bps (${(fund.protocolFeeBps / 100).toFixed(2)}%)`);

    console.log(`\n🔑 Wallets:`);
    if (solWallet) {
      console.log(`   Solana:  ${solWallet.address}`);
    } else {
      console.log(`   Solana:  ⚠️  not configured`);
    }
    if (baseWallet) {
      console.log(`   Base:    ${baseWallet.address}`);
    } else {
      console.log(`   Base:    ⚠️  not configured`);
    }

    // Validate fund is active
    if (fund.status !== 'active') {
      console.error(`\n⚠️  Fund status is '${fund.status}' — pipeline requires 'active'\n`);
      process.exit(1);
    }

    if (!baseWallet) {
      console.error(`\n⚠️  Fund has no Base wallet — cannot bridge\n`);
      process.exit(1);
    }

    console.log(`\n🔄 Pipeline plan:`);
    console.log(`   1. Claim reflections for mint ${fund.tokenMint}`);
    console.log(`   2. Swap claimed SOL → USDC via Jupiter`);
    console.log(`   3. Deduct ${fund.protocolFeeBps} bps (${(fund.protocolFeeBps / 100).toFixed(2)}%) protocol fee`);
    console.log(`   4. Bridge remaining USDC to Base wallet ${baseWallet.address}`);
    console.log(`\n✅ Dry run complete — no transactions executed.\n`);

    log('dry-run', 'complete', { fundId, status: fund.status, protocolFeeBps: fund.protocolFeeBps });
  } finally {
    await closeDb();
  }
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

async function runLive(fundId: string): Promise<void> {
  // Validate all required env vars upfront
  const solPrivateKey = requireEnv('SOL_PRIVATE_KEY');
  const platformTreasuryWallet = requireEnv('PLATFORM_TREASURY_WALLET');
  const bagsApiKey = requireEnv('BAGS_API_KEY');

  log('live', 'start', { fundId });

  const connection = createSolanaConnection();
  const wallet = loadSolanaKeypair(solPrivateKey);
  const sdk = createBagsClient({ apiKey: bagsApiKey });
  const db = createDb();

  const startTime = Date.now();

  try {
    console.log(`\n🚀 Starting outbound pipeline for fund ${fundId}`);
    console.log(`   Wallet: ${wallet.publicKey.toBase58()}`);
    console.log(`   Treasury: ${platformTreasuryWallet}\n`);

    const result = await runOutboundPipeline({
      fundId,
      sdk,
      wallet,
      connection,
      db,
      platformTreasuryWallet,
    });

    const durationSec = (result.durationMs / 1000).toFixed(1);

    console.log(`\n✅ Outbound pipeline complete!`);
    console.log(`   Pipeline Run ID: ${result.pipelineRunId}`);
    console.log(`   Duration:        ${durationSec}s`);
    console.log(`   Claimed:         ${result.amountClaimed} lamports`);
    console.log(`   Swapped:         ${result.amountSwapped} USDC (atomic)`);
    console.log(`   Fee deducted:    ${result.feeDeducted} USDC (atomic)`);
    console.log(`   Bridged:         ${result.amountBridged} USDC (atomic)`);
    console.log(`   Bridge Order:    ${result.bridgeOrderId}`);

    console.log(`\n📝 Transaction Hashes:`);
    if (result.txHashes.claim.length > 0) {
      result.txHashes.claim.forEach((sig, i) => {
        console.log(`   Claim[${i}]:       ${sig}`);
      });
    }
    if (result.txHashes.swap) {
      console.log(`   Swap:            ${result.txHashes.swap}`);
    }
    if (result.txHashes.feeTransfer) {
      console.log(`   Fee transfer:    ${result.txHashes.feeTransfer}`);
    }
    if (result.txHashes.bridgeSend) {
      console.log(`   Bridge send:     ${result.txHashes.bridgeSend}`);
    }
    if (result.txHashes.bridgeReceive) {
      console.log(`   Bridge receive:  ${result.txHashes.bridgeReceive}`);
    }

    console.log();
  } finally {
    await closeDb();
  }
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

  if (!args.fundId) {
    console.error('\n❌ --fund-id is required. Use --help for usage.\n');
    process.exit(1);
  }

  try {
    if (args.dryRun) {
      await runDryRun(args.fundId);
    } else {
      await runLive(args.fundId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('pipeline', 'error', { error: message });
    console.error(`\n❌ Outbound pipeline failed: ${message}\n`);
    process.exit(1);
  }
}

main();
