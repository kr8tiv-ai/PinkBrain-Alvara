#!/usr/bin/env tsx
/**
 * Check the status of a deBridge bridge order.
 *
 * Usage:
 *   npx tsx scripts/check-bridge-status.ts --order-id <id>
 *   npx tsx scripts/check-bridge-status.ts --tx-hash <hash>
 */

import { getOrderStatus, getOrderIdByTxHash } from '../src/debridge/api.js';
import type { DeBridgeOrderStatus } from '../src/debridge/types.js';

// ---------------------------------------------------------------------------
// Chain name mapping for display
// ---------------------------------------------------------------------------

const CHAIN_NAMES: Record<number, string> = {
  7565164: 'Solana',
  8453: 'Base',
  1: 'Ethereum',
};

const CHAIN_EXPLORERS: Record<number, string> = {
  7565164: 'https://solscan.io/tx/',
  8453: 'https://basescan.org/tx/',
  1: 'https://etherscan.io/tx/',
};

function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

function log(phase: string, action: string, data: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    module: 'bridge-status',
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
  orderId: string | null;
  txHash: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    orderId: null,
    txHash: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--order-id' && i + 1 < argv.length) {
      args.orderId = argv[++i];
    } else if (arg === '--tx-hash' && i + 1 < argv.length) {
      args.txHash = argv[++i];
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
Usage: npx tsx scripts/check-bridge-status.ts [options]

Options:
  --order-id <id>   Query status by deBridge order ID
  --tx-hash <hash>  Query status by source chain transaction hash
  --help, -h        Show this help message

One of --order-id or --tx-hash is required.

Examples:
  npx tsx scripts/check-bridge-status.ts --order-id 0xabc123...
  npx tsx scripts/check-bridge-status.ts --tx-hash 5UyZ...
`);
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function displayStatus(status: DeBridgeOrderStatus): void {
  console.log(`\n📋 Bridge Order Status:`);
  console.log(`   Order ID:     ${status.orderId}`);
  console.log(`   Status:       ${status.status}`);
  console.log(`   Source:       ${chainName(status.sourceChainId)} (${status.sourceChainId})`);
  console.log(`   Destination:  ${chainName(status.destinationChainId)} (${status.destinationChainId})`);

  if (status.fulfillTransactionHash) {
    const explorer = CHAIN_EXPLORERS[status.destinationChainId] ?? '';
    console.log(`   Fulfill TX:   ${status.fulfillTransactionHash}`);
    if (explorer) {
      console.log(`   Explorer:     ${explorer}${status.fulfillTransactionHash}`);
    }
  }
  console.log('');
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

  if (!args.orderId && !args.txHash) {
    console.error('Error: one of --order-id or --tx-hash is required. Use --help for usage.');
    process.exit(1);
  }

  try {
    let orderId = args.orderId;

    // If tx hash provided, look up the order ID first
    if (!orderId && args.txHash) {
      log('lookup', 'start', { txHash: args.txHash });
      orderId = await getOrderIdByTxHash(args.txHash);

      if (!orderId) {
        console.error(`\n⚠️  No order found for tx hash: ${args.txHash}`);
        console.error('   The transaction may not be indexed yet. Try again in a few minutes.\n');
        process.exit(1);
      }

      log('lookup', 'found', { txHash: args.txHash, orderId });
    }

    // Query order status
    log('status', 'start', { orderId });
    const status = await getOrderStatus(orderId!);

    log('status', 'done', {
      orderId: status.orderId,
      status: status.status,
      fulfillTx: status.fulfillTransactionHash ?? null,
    });

    displayStatus(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('status', 'error', { error: message });
    console.error(`\n❌ Status check failed: ${message}\n`);
    process.exit(1);
  }
}

main();
