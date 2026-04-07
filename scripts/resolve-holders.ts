#!/usr/bin/env tsx
/**
 * Resolve top holders of an SPL token mint on Solana.
 *
 * Usage:
 *   npx tsx scripts/resolve-holders.ts --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --count 20
 *   npx tsx scripts/resolve-holders.ts --mint <mint_address>
 *
 * Environment:
 *   SOL_RPC_URL  Solana RPC endpoint (default: public mainnet-beta)
 *               Use a Helius URL for faster resolution via DAS API.
 */

import 'dotenv/config';
import { createSolanaConnection } from '../src/config/solana.js';
import { getTopHolders } from '../src/holders/resolve.js';

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'resolve-holders-script',
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
  mint: string;
  count: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mint: '',
    count: 100,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mint' && i + 1 < argv.length) {
      args.mint = argv[++i];
    } else if (arg === '--count' && i + 1 < argv.length) {
      args.count = parseInt(argv[++i], 10);
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
Usage: npx tsx scripts/resolve-holders.ts [options]

Options:
  --mint <address>   SPL token mint address (required)
  --count <N>        Number of top holders to return (default: 100, max: 10000)
  --help, -h         Show this help message

Environment variables:
  SOL_RPC_URL    Solana RPC endpoint (default: public mainnet-beta)
                 Use a Helius URL for faster DAS-based resolution.

Examples:
  npx tsx scripts/resolve-holders.ts --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --count 20
  SOL_RPC_URL=https://mainnet.helius-rpc.com/?api-key=xxx npx tsx scripts/resolve-holders.ts --mint <mint>
`);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Truncate address to 8...8 format */
function truncAddr(addr: string): string {
  if (addr.length <= 20) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
}

/** Right-pad a string to a given width */
function pad(s: string, width: number): string {
  return s.padEnd(width);
}

/** Left-pad a string */
function lpad(s: string, width: number): string {
  return s.padStart(width);
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

  if (!args.mint) {
    console.error('❌ --mint is required. Use --help for usage.');
    process.exit(1);
  }

  const startMs = Date.now();

  log('script', 'start', {
    mint: args.mint,
    count: args.count,
    rpcUrl: (process.env.SOL_RPC_URL ?? 'public-mainnet').replace(/api[_-]?key[^&]*/gi, 'REDACTED'),
  });

  const connection = createSolanaConnection();

  try {
    const result = await getTopHolders(args.mint, args.count, connection);

    log('script', 'done', {
      strategy: result.strategy,
      holdersReturned: result.holders.length,
      totalSupplyHeld: result.totalSupplyHeld.toString(),
      elapsedMs: Date.now() - startMs,
    });

    // Human-readable table
    console.log(`\n✅ Top ${result.holders.length} holders for ${truncAddr(args.mint)}`);
    console.log(`   Strategy: ${result.strategy}`);
    console.log(`   Elapsed:  ${Date.now() - startMs}ms\n`);

    // Table header
    const rankW = 6;
    const ownerW = 20;
    const amountW = 24;
    const pctW = 10;

    console.log(
      `${pad('Rank', rankW)} ${pad('Owner', ownerW)} ${lpad('Amount', amountW)} ${lpad('%', pctW)}`
    );
    console.log(`${'─'.repeat(rankW)} ${'─'.repeat(ownerW)} ${'─'.repeat(amountW)} ${'─'.repeat(pctW)}`);

    for (let i = 0; i < result.holders.length; i++) {
      const h = result.holders[i];
      console.log(
        `${pad(String(i + 1), rankW)} ${pad(truncAddr(h.owner), ownerW)} ${lpad(h.amount.toString(), amountW)} ${lpad(h.percentage.toFixed(2) + '%', pctW)}`
      );
    }

    console.log('');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('script', 'error', { error: message });
    console.error(`\n❌ Holder resolution failed: ${message}\n`);
    process.exit(1);
  }
}

main();
