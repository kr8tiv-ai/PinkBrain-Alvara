#!/usr/bin/env npx tsx
/**
 * Contribute ETH to an Alvara BSKT on Base.
 *
 * Fetches backend-signed swap routes from the Alvara API, calls contribute()
 * on the BSKT NFT contract, and verifies LP token balance increased.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/contribute-bskt.ts --bskt-address 0x... --amount 0.01
 *   PRIVATE_KEY=0x... npx tsx scripts/contribute-bskt.ts --bskt-address 0x... --amount 0.01 --dry-run
 *
 * Environment:
 *   PRIVATE_KEY      — hex-encoded private key for the contributing wallet (required)
 *   ALVARA_API_URL   — override Alvara backend URL (optional)
 *
 * Output: Structured JSON result to stdout.
 */

import 'dotenv/config';
import { createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createBaseClient } from '../src/config/chains.js';
import { contributeToBSKT, type ContributeResult } from '../src/alvara/contribute.js';
import { setApiBaseUrl } from '../src/alvara/api.js';

// ── Argument Parsing ───────────────────────────────────────────────────────

function parseArgs(): { bsktAddress: string; amount: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let bsktAddress = '';
  let amount = '';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--bskt-address':
        bsktAddress = args[++i] ?? '';
        break;
      case '--amount':
        amount = args[++i] ?? '';
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

  if (!bsktAddress) {
    console.error('Error: --bskt-address is required');
    printUsage();
    process.exit(1);
  }

  if (!amount) {
    console.error('Error: --amount is required');
    printUsage();
    process.exit(1);
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(bsktAddress)) {
    console.error(`Error: invalid address "${bsktAddress}"`);
    process.exit(1);
  }

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) {
    console.error(`Error: --amount must be a positive number, got "${amount}"`);
    process.exit(1);
  }

  return { bsktAddress, amount, dryRun };
}

function printUsage(): void {
  console.error(`
Usage:
  PRIVATE_KEY=0x... npx tsx scripts/contribute-bskt.ts --bskt-address <addr> --amount <eth> [--dry-run]

Options:
  --bskt-address  BSKT NFT contract address (required)
  --amount        ETH amount to contribute (required, e.g. 0.01)
  --dry-run       Only fetch routes and estimate gas, don't send tx
`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { bsktAddress, amount, dryRun } = parseArgs();

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
    amount,
    dryRun,
    wallet: account.address,
  }));

  try {
    const result = await contributeToBSKT({
      publicClient,
      walletClient,
      bsktAddress: bsktAddress as `0x${string}`,
      ethAmount: amount,
      dryRun,
    });

    // Output structured JSON result (bigints serialized as strings)
    const output = {
      success: true,
      txHash: result.txHash,
      gasUsed: String(result.gasUsed),
      gasEstimate: String(result.gasEstimate),
      lpBalanceBefore: String(result.lpBalanceBefore),
      lpBalanceAfter: String(result.lpBalanceAfter),
      lpBalanceBeforeFormatted: formatEther(result.lpBalanceBefore),
      lpBalanceAfterFormatted: formatEther(result.lpBalanceAfter),
      lpIncrease: String(result.lpBalanceAfter - result.lpBalanceBefore),
      routeData: result.routeData,
      dryRun,
    };

    // Print result to stdout (structured logs go to stderr via console.error or console.log in contribute.ts)
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
