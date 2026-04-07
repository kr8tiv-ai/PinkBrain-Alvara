#!/usr/bin/env npx tsx
/**
 * Deploy the DivestmentRegistry contract to Base or Ethereum mainnet.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-registry.ts --chain base
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-registry.ts --chain ethereum
 *   DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-registry.ts --chain base --rpc-url https://custom.rpc
 *   npx tsx scripts/deploy-registry.ts --help
 *
 * Environment:
 *   DEPLOYER_PRIVATE_KEY — hex-encoded private key for the deployer wallet (required)
 *
 * Output: Structured JSON result to stdout on success.
 */

import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, mainnet } from 'viem/chains';
import { deployRegistry } from '../src/registry/deploy.js';

// ── Help Text ──────────────────────────────────────────────────────────

const HELP = `
DivestmentRegistry Deploy Script
=================================

Usage:
  DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-registry.ts --chain <base|ethereum> [--rpc-url <url>]

Flags:
  --chain <base|ethereum>   Target chain (required)
  --rpc-url <url>           Custom RPC URL (optional — uses public defaults)
  --help                    Show this help

Environment:
  DEPLOYER_PRIVATE_KEY      Hex-encoded deployer private key (required)

Output:
  JSON object with { chain, address, txHash, gasUsed, deployer }
`.trim();

// ── Argument Parsing ───────────────────────────────────────────────────

interface Args {
  chain: 'base' | 'ethereum';
  rpcUrl?: string;
  help: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let chain: string | undefined;
  let rpcUrl: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--chain':
        chain = argv[++i];
        break;
      case '--rpc-url':
        rpcUrl = argv[++i];
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        console.error('Run with --help for usage.');
        process.exit(1);
    }
  }

  if (help) return { chain: 'base', help: true };

  if (!chain || !['base', 'ethereum'].includes(chain)) {
    console.error('Error: --chain must be "base" or "ethereum".');
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  return { chain: chain as 'base' | 'ethereum', rpcUrl, help: false };
}

// ── Chain Configuration ────────────────────────────────────────────────

const DEFAULT_RPCS: Record<string, string> = {
  base: 'https://base.drpc.org',
  ethereum: 'https://eth.drpc.org',
};

function getChainConfig(name: string): Chain {
  return name === 'ethereum' ? mainnet : base;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error('Error: DEPLOYER_PRIVATE_KEY environment variable is required.');
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  const chain = getChainConfig(args.chain);
  const rpcUrl = args.rpcUrl ?? DEFAULT_RPCS[args.chain];
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  console.error(`Deploying DivestmentRegistry to ${args.chain} (${chain.id})...`);
  console.error(`RPC: ${rpcUrl}`);
  console.error(`Deployer: ${account.address}`);

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, { timeout: 60_000 }),
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 60_000 }),
  });

  try {
    const result = await deployRegistry(walletClient, publicClient);

    const output = {
      chain: args.chain,
      address: result.address,
      txHash: result.txHash,
      gasUsed: String(result.gasUsed),
      deployer: account.address,
    };

    // Structured JSON to stdout (parseable by scripts)
    console.log(JSON.stringify(output, null, 2));
    console.error(`\n✅ Deployed at ${result.address} (gas: ${result.gasUsed})`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ Deployment failed: ${msg}`);
    process.exit(1);
  }
}

main();
