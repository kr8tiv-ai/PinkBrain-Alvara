#!/usr/bin/env npx tsx
/**
 * Bags FM fee share & claiming — end-to-end CLI proof script.
 *
 * Proves the Bags SDK can: query admin status, update fee share config,
 * query claimable positions, and claim accumulated fees.
 *
 * Supports --dry-run mode (no API key required, outputs realistic mock shapes)
 * and live mode (requires BAGS_API_KEY, optionally SOL_PRIVATE_KEY for claiming).
 *
 * Usage:
 *   npx tsx scripts/bags-fee-share.ts --dry-run
 *   npx tsx scripts/bags-fee-share.ts --wallet <addr> --token-mint <addr>
 *   npx tsx scripts/bags-fee-share.ts --wallet <addr> --token-mint <addr> --treasury <addr>
 *   npx tsx scripts/bags-fee-share.ts --wallet <addr> --token-mint <addr> --claim
 *
 * All output is structured JSON to stdout (one JSON object per line).
 * Diagnostic/progress messages go to stderr.
 */

import 'dotenv/config';
import { createBagsClient, pingApi, log } from '../src/bags/client.js';
import { getAdminTokenList, getClaimablePositions, buildUpdateConfigTransaction } from '../src/bags/fee-share.js';
import { getClaimTransactions, signAndSendClaimTransactions } from '../src/bags/fee-claim.js';
import { createSolanaConnection, loadSolanaKeypair } from '../src/config/solana.js';

// ── Arg Parsing ────────────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean;
  wallet?: string;
  tokenMint?: string;
  treasury?: string;
  claim: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { dryRun: false, claim: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--wallet':
        result.wallet = args[++i];
        break;
      case '--token-mint':
        result.tokenMint = args[++i];
        break;
      case '--treasury':
        result.treasury = args[++i];
        break;
      case '--claim':
        result.claim = true;
        break;
      default:
        console.error(JSON.stringify({
          module: 'bags-fee-share',
          phase: 'args',
          error: `Unknown argument: ${args[i]}`,
          usage: 'npx tsx scripts/bags-fee-share.ts --dry-run | --wallet <addr> --token-mint <addr> [--treasury <addr>] [--claim]',
        }));
        process.exit(1);
    }
  }

  return result;
}

// ── Dry-Run Mode ───────────────────────────────────────────────────────────

function runDryMode(): void {
  const mockWallet = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const mockMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const mockTreasury = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

  // 1. Mock ping response
  console.log(JSON.stringify({
    step: 'ping',
    mode: 'dry-run',
    response: { message: 'pong — API key is valid' },
  }));

  // 2. Mock admin token list
  console.log(JSON.stringify({
    step: 'getAdminTokenList',
    mode: 'dry-run',
    wallet: mockWallet,
    response: [
      mockMint,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    ],
  }));

  // 3. Mock claimable positions
  console.log(JSON.stringify({
    step: 'getClaimablePositions',
    mode: 'dry-run',
    wallet: mockWallet,
    response: [
      {
        baseMint: mockMint,
        claimableAmount: '1500000',
        decimals: 6,
        symbol: 'BONK',
      },
      {
        baseMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        claimableAmount: '250000',
        decimals: 6,
        symbol: 'USDC',
      },
    ],
  }));

  // 4. Mock update config transaction
  console.log(JSON.stringify({
    step: 'buildUpdateConfigTransaction',
    mode: 'dry-run',
    config: {
      baseMint: mockMint,
      claimersArray: [mockWallet, mockTreasury],
      basisPointsArray: [5000, 5000],
      payer: mockWallet,
    },
    response: [
      {
        transaction: '<base64-encoded-VersionedTransaction>',
        blockhash: 'GHtXQBtXq3ZyEmkcNDfvnCh6bFnGLmKk5VxWfpaZ7Rpk',
      },
    ],
  }));

  // 5. Mock claim transactions
  console.log(JSON.stringify({
    step: 'getClaimTransactions',
    mode: 'dry-run',
    wallet: mockWallet,
    tokenMint: mockMint,
    response: [
      '<base64-encoded-Transaction-1>',
      '<base64-encoded-Transaction-2>',
    ],
  }));

  // 6. Mock sign and send
  console.log(JSON.stringify({
    step: 'signAndSendClaimTransactions',
    mode: 'dry-run',
    response: {
      signatures: [
        '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQW',
        '4zBiGz2Q1gBpXrS3k7vt2eQxrLjUMCgvHKmWcAg5qYVxj6L9WDi3epYsRKCh8nXZvyGceMHxRyFw8g7pmJXBkoX',
      ],
      count: 2,
    },
  }));
}

// ── Live Mode ──────────────────────────────────────────────────────────────

async function runLiveMode(args: CliArgs): Promise<void> {
  // Validate required env vars
  const apiKey = process.env.BAGS_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error(JSON.stringify({
      module: 'bags-fee-share',
      phase: 'env',
      error: 'BAGS_API_KEY is required for live mode — get one at https://dev.bags.fm',
    }));
    process.exit(1);
  }

  if (!args.wallet) {
    console.error(JSON.stringify({
      module: 'bags-fee-share',
      phase: 'args',
      error: '--wallet is required in live mode',
    }));
    process.exit(1);
  }

  if (!args.tokenMint) {
    console.error(JSON.stringify({
      module: 'bags-fee-share',
      phase: 'args',
      error: '--token-mint is required in live mode',
    }));
    process.exit(1);
  }

  // Step 1: Validate API key via ping
  log('live', 'step:ping', { wallet: args.wallet });
  const pingResult = await pingApi(apiKey);
  console.log(JSON.stringify({
    step: 'ping',
    mode: 'live',
    response: pingResult,
  }));

  // Create SDK client
  const sdk = createBagsClient({
    apiKey,
    rpcUrl: process.env.SOL_RPC_URL,
  });

  // Step 2: Query admin token list
  log('live', 'step:getAdminTokenList', { wallet: args.wallet });
  const adminMints = await getAdminTokenList(sdk, args.wallet);
  console.log(JSON.stringify({
    step: 'getAdminTokenList',
    mode: 'live',
    wallet: args.wallet,
    response: adminMints,
  }));

  // Step 3: Query claimable positions
  log('live', 'step:getClaimablePositions', { wallet: args.wallet });
  const positions = await getClaimablePositions(sdk, args.wallet);
  console.log(JSON.stringify({
    step: 'getClaimablePositions',
    mode: 'live',
    wallet: args.wallet,
    response: positions,
  }));

  // Step 4: Update config if --treasury provided
  if (args.treasury) {
    log('live', 'step:buildUpdateConfigTransaction', {
      treasury: args.treasury,
      tokenMint: args.tokenMint,
    });
    const updateResult = await buildUpdateConfigTransaction(sdk, {
      baseMint: args.tokenMint,
      claimersArray: [args.wallet, args.treasury],
      basisPointsArray: [5000, 5000],
      payer: args.wallet,
    });
    console.log(JSON.stringify({
      step: 'buildUpdateConfigTransaction',
      mode: 'live',
      config: {
        baseMint: args.tokenMint,
        claimersArray: [args.wallet, args.treasury],
        basisPointsArray: [5000, 5000],
        payer: args.wallet,
      },
      response: {
        transactionCount: updateResult.length,
        note: args.claim
          ? 'Transactions will be signed and sent'
          : 'Transactions built but NOT signed — pass --claim to execute',
      },
    }));
  }

  // Step 5: Claim if --claim provided
  if (args.claim) {
    // Validate SOL_PRIVATE_KEY before attempting to sign
    const solPrivateKey = process.env.SOL_PRIVATE_KEY;
    if (!solPrivateKey || solPrivateKey.trim().length === 0) {
      console.error(JSON.stringify({
        module: 'bags-fee-share',
        phase: 'env',
        error: 'SOL_PRIVATE_KEY is required for --claim mode — set it in .env',
      }));
      process.exit(1);
    }

    log('live', 'step:getClaimTransactions', {
      wallet: args.wallet,
      tokenMint: args.tokenMint,
    });

    const claimTxs = await getClaimTransactions(sdk, args.wallet, args.tokenMint);
    console.log(JSON.stringify({
      step: 'getClaimTransactions',
      mode: 'live',
      wallet: args.wallet,
      tokenMint: args.tokenMint,
      response: { transactionCount: claimTxs.length },
    }));

    if (claimTxs.length > 0) {
      const keypair = loadSolanaKeypair(solPrivateKey);
      const connection = createSolanaConnection(process.env.SOL_RPC_URL);

      log('live', 'step:signAndSendClaimTransactions', {
        count: claimTxs.length,
      });

      const signatures = await signAndSendClaimTransactions(
        connection,
        keypair,
        claimTxs as unknown as string[]
      );

      console.log(JSON.stringify({
        step: 'signAndSendClaimTransactions',
        mode: 'live',
        response: { signatures, count: signatures.length },
      }));
    } else {
      console.log(JSON.stringify({
        step: 'signAndSendClaimTransactions',
        mode: 'live',
        response: { signatures: [], count: 0, note: 'No claim transactions available' },
      }));
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  console.error(JSON.stringify({
    module: 'bags-fee-share',
    phase: 'start',
    mode: args.dryRun ? 'dry-run' : 'live',
    args: {
      wallet: args.wallet ?? null,
      tokenMint: args.tokenMint ?? null,
      treasury: args.treasury ?? null,
      claim: args.claim,
    },
  }));

  if (args.dryRun) {
    runDryMode();
  } else {
    await runLiveMode(args);
  }

  console.error(JSON.stringify({
    module: 'bags-fee-share',
    phase: 'complete',
    mode: args.dryRun ? 'dry-run' : 'live',
  }));
}

main().catch((err) => {
  console.error(JSON.stringify({
    module: 'bags-fee-share',
    phase: 'fatal',
    error: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
