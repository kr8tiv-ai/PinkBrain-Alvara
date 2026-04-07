#!/usr/bin/env npx tsx
/**
 * Emergency stables conversion and revert for Alvara BSKTs on Base.
 *
 * Default mode: Convert BSKT to ~95% USDT + 5% ALVA. Outputs a snapshot
 * JSON file that can be used later to revert to the original composition.
 *
 * Revert mode: Read a snapshot JSON file and restore the original composition.
 *
 * Usage:
 *   # Convert to stables — outputs snapshot to stdout
 *   PRIVATE_KEY=0x... npx tsx scripts/emergency-stables.ts \
 *     --bskt-address 0x... [--dry-run]
 *
 *   # Revert from stables — reads snapshot file
 *   PRIVATE_KEY=0x... npx tsx scripts/emergency-stables.ts \
 *     --bskt-address 0x... --revert --snapshot-file snapshot.json [--dry-run]
 *
 * Environment:
 *   PRIVATE_KEY      — hex-encoded private key for the manager wallet (required)
 *   ALVARA_API_URL   — override Alvara backend URL (optional)
 *
 * Output: Structured JSON result to stdout, diagnostic logs to stderr.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createWalletClient, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createBaseClient } from '../src/config/chains.js';
import { emergencyStables, emergencyRevert } from '../src/alvara/emergency.js';
import type { ConstituentInfo } from '../src/alvara/erc7621.js';
import { setApiBaseUrl } from '../src/alvara/api.js';

// ── Argument Parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  bsktAddress: string;
  revert: boolean;
  snapshotFile: string;
  dryRun: boolean;
}

function printUsage(): void {
  console.error(`
Usage:
  # Convert to emergency stables (~95% USDT + 5% ALVA)
  PRIVATE_KEY=0x... npx tsx scripts/emergency-stables.ts \\
    --bskt-address <addr> [--dry-run]

  # Revert to original composition from snapshot
  PRIVATE_KEY=0x... npx tsx scripts/emergency-stables.ts \\
    --bskt-address <addr> --revert --snapshot-file <path.json> [--dry-run]

Options:
  --bskt-address    BSKT NFT contract address (required)
  --revert          Revert mode — restore original composition from snapshot
  --snapshot-file   Path to snapshot JSON file (required with --revert)
  --dry-run         Only fetch routes and estimate gas, don't send tx

The snapshot file is a JSON object with:
  { "tokens": ["0x...", ...], "weights": ["9500", "500", ...] }
Weights are string-encoded basis points (bigint-safe).
`);
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let bsktAddress = '';
  let revert = false;
  let snapshotFile = '';
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
      case '--revert':
        revert = true;
        break;
      case '--snapshot-file':
        snapshotFile = args[++i] ?? '';
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

  // Validate --revert requires --snapshot-file
  if (revert && !snapshotFile) {
    console.error('Error: --revert requires --snapshot-file <path.json>');
    printUsage();
    process.exit(1);
  }

  return { bsktAddress, revert, snapshotFile, dryRun };
}

// ── Snapshot I/O ───────────────────────────────────────────────────────────

/**
 * Serializable snapshot format — weights as strings for bigint safety.
 */
interface SnapshotJSON {
  tokens: string[];
  weights: string[];
}

function loadSnapshot(filePath: string): ConstituentInfo {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Error: cannot read snapshot file "${filePath}": ${errMsg}`);
    process.exit(1);
  }

  let parsed: SnapshotJSON;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`Error: snapshot file "${filePath}" is not valid JSON`);
    process.exit(1);
  }

  if (!Array.isArray(parsed.tokens) || !Array.isArray(parsed.weights)) {
    console.error('Error: snapshot JSON must have "tokens" (string[]) and "weights" (string[]) fields');
    process.exit(1);
  }

  if (parsed.tokens.length !== parsed.weights.length) {
    console.error(
      `Error: snapshot tokens/weights length mismatch (${parsed.tokens.length} vs ${parsed.weights.length})`,
    );
    process.exit(1);
  }

  if (parsed.tokens.length === 0) {
    console.error('Error: snapshot has no tokens');
    process.exit(1);
  }

  // Validate token addresses
  for (const t of parsed.tokens) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) {
      console.error(`Error: invalid token address in snapshot: "${t}"`);
      process.exit(1);
    }
  }

  return {
    tokens: parsed.tokens as Address[],
    weights: parsed.weights.map(w => BigInt(w)),
  };
}

function snapshotToJSON(snapshot: ConstituentInfo): SnapshotJSON {
  return {
    tokens: snapshot.tokens,
    weights: snapshot.weights.map(w => String(w)),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { bsktAddress, revert, snapshotFile, dryRun } = parseArgs();

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
    mode: revert ? 'revert' : 'emergency_stables',
    bsktAddress,
    dryRun,
    wallet: account.address,
  }));

  try {
    if (revert) {
      // ── Revert Mode ────────────────────────────────────────────────
      const snapshot = loadSnapshot(snapshotFile);
      console.error(JSON.stringify({
        phase: 'cli',
        action: 'snapshot_loaded',
        tokenCount: snapshot.tokens.length,
        source: snapshotFile,
      }));

      const result = await emergencyRevert({
        publicClient,
        walletClient,
        bsktAddress: bsktAddress as Address,
        snapshot,
        dryRun,
      });

      const output = {
        success: true,
        mode: 'revert',
        txHash: result.txHash,
        gasUsed: String(result.gasUsed),
        gasEstimate: String(result.gasEstimate),
        restoredTokens: result.newTokens,
        restoredWeights: result.newWeights,
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
    } else {
      // ── Emergency Stables Mode ─────────────────────────────────────
      const result = await emergencyStables({
        publicClient,
        walletClient,
        bsktAddress: bsktAddress as Address,
        dryRun,
      });

      const snapshotJSON = snapshotToJSON(result.snapshot);
      const rb = result.rebalanceResult;

      const output = {
        success: true,
        mode: 'emergency_stables',
        txHash: rb.txHash,
        gasUsed: String(rb.gasUsed),
        gasEstimate: String(rb.gasEstimate),
        snapshot: snapshotJSON,
        lpBalanceBefore: String(rb.lpBalanceBefore),
        lpBalanceAfter: String(rb.lpBalanceAfter),
        event: rb.event
          ? {
              bskt: rb.event.bskt,
              oldTokens: rb.event.oldTokens,
              oldWeights: rb.event.oldWeights.map(w => String(w)),
              newTokens: rb.event.newTokens,
              newWeights: rb.event.newWeights.map(w => String(w)),
              mode: rb.event.mode,
            }
          : null,
        routeData: rb.routeData,
        dryRun,
      };

      console.log(JSON.stringify(output, null, 2));
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      phase: 'cli',
      action: 'error',
      error: errMsg.slice(0, 1000),
    }));

    console.log(JSON.stringify({
      success: false,
      mode: revert ? 'revert' : 'emergency_stables',
      error: errMsg.slice(0, 1000),
      dryRun,
    }, null, 2));

    process.exit(1);
  }
}

main();
