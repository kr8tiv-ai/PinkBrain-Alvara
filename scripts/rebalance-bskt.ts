#!/usr/bin/env npx tsx
/**
 * Rebalance an Alvara BSKT on Base — change token allocations.
 *
 * Validates ownership, fetches backend-signed swap routes from the Alvara API,
 * calls rebalance() on the BSKT NFT, and outputs structured JSON result.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/rebalance-bskt.ts \
 *     --bskt-address 0x... \
 *     --new-tokens 0xAAA,0xBBB,0xCCC \
 *     --new-weights 5000,3000,2000 \
 *     [--mode 0] [--dry-run]
 *
 * Environment:
 *   PRIVATE_KEY      — hex-encoded private key for the manager wallet (required)
 *   ALVARA_API_URL   — override Alvara backend URL (optional)
 *
 * Output: Structured JSON result to stdout, diagnostic logs to stderr.
 */

import 'dotenv/config';
import { createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createBaseClient } from '../src/config/chains.js';
import { rebalanceBSKT, RebalanceMode } from '../src/alvara/rebalance.js';
import { setApiBaseUrl } from '../src/alvara/api.js';

// ── Argument Parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  bsktAddress: string;
  newTokens: string[];
  newWeights: number[];
  mode: number;
  dryRun: boolean;
}

function printUsage(): void {
  console.error(`
Usage:
  PRIVATE_KEY=0x... npx tsx scripts/rebalance-bskt.ts \\
    --bskt-address <addr> \\
    --new-tokens <addr1,addr2,...> \\
    --new-weights <bps1,bps2,...> \\
    [--mode <0|1|2>] [--dry-run]

Options:
  --bskt-address  BSKT NFT contract address (required)
  --new-tokens    Comma-separated token addresses for new composition (required)
  --new-weights   Comma-separated weights in basis points, must sum to 10000 (required)
  --mode          Rebalance mode: 0=standard, 1=emergency_stables, 2=revert_emergency (default: 0)
  --dry-run       Only fetch routes and estimate gas, don't send tx

Weights must sum to exactly 10000 (100%). Each weight is in basis points
(e.g. 5000 = 50%, 500 = 5%). Every BSKT must include at least 5% ALVA.
`);
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let bsktAddress = '';
  let newTokensRaw = '';
  let newWeightsRaw = '';
  let mode = 0;
  let dryRun = false;

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--bskt-address':
        bsktAddress = args[++i] ?? '';
        break;
      case '--new-tokens':
        newTokensRaw = args[++i] ?? '';
        break;
      case '--new-weights':
        newWeightsRaw = args[++i] ?? '';
        break;
      case '--mode':
        mode = parseInt(args[++i] ?? '0', 10);
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  // Validate --bskt-address
  if (!bsktAddress) {
    console.error('Error: --bskt-address is required');
    printUsage();
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(bsktAddress)) {
    console.error(`Error: invalid address "${bsktAddress}"`);
    process.exit(1);
  }

  // Validate --new-tokens
  if (!newTokensRaw) {
    console.error('Error: --new-tokens is required');
    printUsage();
    process.exit(1);
  }
  const newTokens = newTokensRaw.split(',').map(t => t.trim()).filter(Boolean);
  for (const t of newTokens) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) {
      console.error(`Error: invalid token address "${t}"`);
      process.exit(1);
    }
  }

  // Validate --new-weights
  if (!newWeightsRaw) {
    console.error('Error: --new-weights is required');
    printUsage();
    process.exit(1);
  }
  const newWeights = newWeightsRaw.split(',').map(w => {
    const n = parseInt(w.trim(), 10);
    if (isNaN(n) || n < 0) {
      console.error(`Error: invalid weight "${w.trim()}" — must be a non-negative integer`);
      process.exit(1);
    }
    return n;
  });

  // Validate tokens/weights same length
  if (newTokens.length !== newWeights.length) {
    console.error(
      `Error: --new-tokens has ${newTokens.length} entries but --new-weights has ${newWeights.length} — must match`,
    );
    process.exit(1);
  }

  // Validate weights sum to 10000
  const weightSum = newWeights.reduce((sum, w) => sum + w, 0);
  if (weightSum !== 10000) {
    console.error(`Error: weights sum to ${weightSum}, must sum to exactly 10000 (100%)`);
    process.exit(1);
  }

  // Validate mode
  if (![0, 1, 2].includes(mode)) {
    console.error(`Error: --mode must be 0, 1, or 2 — got ${mode}`);
    process.exit(1);
  }

  return { bsktAddress, newTokens, newWeights, mode, dryRun };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { bsktAddress, newTokens, newWeights, mode, dryRun } = parseArgs();

  // Validate PRIVATE_KEY
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('Error: PRIVATE_KEY environment variable is required');
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    console.error('Error: PRIVATE_KEY must be a 0x-prefixed 64-char hex string');
    process.exit(1);
  }

  // Apply optional API URL override
  if (process.env.ALVARA_API_URL) {
    setApiBaseUrl(process.env.ALVARA_API_URL);
  }

  // Create clients
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createBaseClient();
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://base.drpc.org', { timeout: 15_000, retryCount: 2 }),
  });

  console.error(JSON.stringify({
    phase: 'cli',
    action: 'start',
    bsktAddress,
    newTokensCount: newTokens.length,
    mode,
    dryRun,
    wallet: account.address,
  }));

  try {
    const result = await rebalanceBSKT({
      publicClient,
      walletClient,
      bsktAddress: bsktAddress as Address,
      newTokens: newTokens as Address[],
      newWeights,
      amountIn: newTokens.map(() => '0'),
      mode: mode as RebalanceMode,
      dryRun,
    });

    // Output structured JSON (bigints serialized as strings)
    const output = {
      success: true,
      txHash: result.txHash,
      gasUsed: String(result.gasUsed),
      gasEstimate: String(result.gasEstimate),
      oldTokens: result.oldTokens,
      oldWeights: result.oldWeights.map(w => String(w)),
      newTokens: result.newTokens,
      newWeights: result.newWeights,
      lpBalanceBefore: String(result.lpBalanceBefore),
      lpBalanceAfter: String(result.lpBalanceAfter),
      event: result.event
        ? {
            bskt: result.event.bskt,
            oldTokens: result.event.oldTokens,
            oldWeights: result.event.oldWeights.map(w => String(w)),
            newTokens: result.event.newTokens,
            newWeights: result.event.newWeights.map(w => String(w)),
            mode: result.event.mode,
          }
        : null,
      routeData: result.routeData,
      dryRun,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      phase: 'cli',
      action: 'error',
      error: errMsg.slice(0, 1000),
    }));

    console.log(JSON.stringify({
      success: false,
      error: errMsg.slice(0, 1000),
      dryRun,
    }, null, 2));

    process.exit(1);
  }
}

main();
