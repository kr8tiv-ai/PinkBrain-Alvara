#!/usr/bin/env npx tsx
/**
 * Verify ERC-7621 compliance of a BSKT contract on Base.
 *
 * Runs a full verification suite and outputs a structured JSON report.
 * Exit code 0 = all checks pass, exit code 1 = any check failed.
 *
 * Usage:
 *   npx tsx scripts/verify-bskt.ts <bskt-address> [expected-owner]
 *
 * Examples:
 *   npx tsx scripts/verify-bskt.ts 0x056ef071ebc59b5363282b31753bae3b62e4b057
 *   npx tsx scripts/verify-bskt.ts 0x056ef071ebc59b5363282b31753bae3b62e4b057 0xMyWallet
 */

import 'dotenv/config';
import { isAddress } from 'viem';
import { createBaseClient } from '../src/config/chains.js';
import { verifyBSKT } from '../src/alvara/erc7621.js';

// ── Input Validation ───────────────────────────────────────────────────────

function validateArgs(): { bsktAddress: string; expectedOwner?: string } {
  const bsktAddress = process.argv[2];
  const expectedOwner = process.argv[3];

  if (!bsktAddress) {
    console.error(JSON.stringify({
      phase: 'args',
      error: 'Usage: npx tsx scripts/verify-bskt.ts <bskt-address> [expected-owner]',
    }));
    process.exit(1);
  }

  // Validate address format
  if (bsktAddress === '0x0000000000000000000000000000000000000000') {
    console.error(JSON.stringify({
      phase: 'args',
      error: 'Zero address is not a valid BSKT address',
    }));
    process.exit(1);
  }

  if (!isAddress(bsktAddress)) {
    console.error(JSON.stringify({
      phase: 'args',
      error: `Invalid BSKT address format: "${bsktAddress}". Must be a valid checksummed or lowercase Ethereum address.`,
    }));
    process.exit(1);
  }

  if (bsktAddress.length !== 42) {
    console.error(JSON.stringify({
      phase: 'args',
      error: `Wrong address length: ${bsktAddress.length}. Expected 42 characters (0x + 40 hex).`,
    }));
    process.exit(1);
  }

  if (expectedOwner && !isAddress(expectedOwner)) {
    console.error(JSON.stringify({
      phase: 'args',
      error: `Invalid expected-owner address: "${expectedOwner}"`,
    }));
    process.exit(1);
  }

  return { bsktAddress, expectedOwner };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { bsktAddress, expectedOwner } = validateArgs();

  console.error(JSON.stringify({
    phase: 'verify',
    action: 'start',
    bsktAddress,
    expectedOwner: expectedOwner ?? null,
  }));

  const client = createBaseClient();

  try {
    const report = await verifyBSKT(client, bsktAddress, expectedOwner);

    // Output report to stdout
    console.log(JSON.stringify(report, null, 2));

    // Summary to stderr
    const passedCount = report.checks.filter(c => c.passed).length;
    const totalChecks = report.checks.length;
    console.error(JSON.stringify({
      phase: 'verify',
      action: 'complete',
      verified: report.verified,
      passed: passedCount,
      total: totalChecks,
      bsktAddress: report.bsktAddress,
      name: report.name,
      symbol: report.symbol,
    }));

    process.exit(report.verified ? 0 : 1);
  } catch (err: unknown) {
    console.error(JSON.stringify({
      phase: 'verify',
      action: 'error',
      error: err instanceof Error ? err.message : String(err),
      bsktAddress,
    }));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ phase: 'fatal', error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
