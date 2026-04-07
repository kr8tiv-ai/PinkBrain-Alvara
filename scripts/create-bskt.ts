#!/usr/bin/env npx tsx
/**
 * Create a BSKT on Base via Alvara's factory contract.
 *
 * Strategy:
 * 1. Attempt direct factory call with empty swapData/signature
 * 2. If that reverts (likely: MEV protection requires backend signatures),
 *    fall through to MEV analysis of recent successful transactions
 * 3. Always write mev-findings.json regardless of outcome
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx scripts/create-bskt.ts
 *
 * Output: Structured JSON to stdout with either:
 *   - { success: true, bsktAddress, txHash, ... }
 *   - { success: false, mevRequired: true, mevFindings: "src/config/mev-findings.json" }
 */

import 'dotenv/config';
import {
  createWalletClient,
  http,
  type Address,
  type Hash,
  formatEther,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createBaseClient, KNOWN_ADDRESSES } from '../src/config/chains.js';
import {
  loadFactoryConfig,
  getFactoryState,
  createBasket,
  decodeCreateBSKTCalldata,
  type CreateBasketParams,
} from '../src/alvara/factory.js';
import { getTransactionsByAddress, type BasescanTx } from '../src/utils/basescan.js';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEV_FINDINGS_PATH = resolve(__dirname, '../src/config/mev-findings.json');

// ── Helpers ────────────────────────────────────────────────────────────────

function log(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

function logError(data: Record<string, unknown>): void {
  console.error(JSON.stringify(data));
}

function writeMevFindings(findings: MevFindings): void {
  writeFileSync(MEV_FINDINGS_PATH, JSON.stringify(findings, null, 2));
  log({ phase: 'mev_findings', action: 'written', path: MEV_FINDINGS_PATH });
}

// ── MEV Analysis ───────────────────────────────────────────────────────────

interface MevFindings {
  mevRequired: boolean;
  factoryAddress: string;
  analysisTimestamp: string;
  signingParams: string[];
  sampleTxHashes: string[];
  observedDeadlines: string[];
  swapDataPatterns: Record<string, unknown>[];
  recommendation: string;
  directCallError?: string;
  directCallRevertReason?: string;
}

async function analyzeMevProtection(
  factoryAddress: Address,
  directCallError?: string,
): Promise<MevFindings> {
  log({ phase: 'mev_analysis', action: 'start', factoryAddress });

  const findings: MevFindings = {
    mevRequired: false,
    factoryAddress,
    analysisTimestamp: new Date().toISOString(),
    signingParams: [],
    sampleTxHashes: [],
    observedDeadlines: [],
    swapDataPatterns: [],
    recommendation: '',
    directCallError,
  };

  const config = loadFactoryConfig();

  try {
    // Fetch recent transactions TO the factory
    log({ phase: 'mev_analysis', action: 'fetching_recent_txs' });
    const txs = await getTransactionsByAddress(factoryAddress, {
      sort: 'desc',
      offset: 50,
    });

    // Filter to successful createBSKT calls
    const createTxs = txs.filter(
      (tx: BasescanTx) =>
        tx.isError === '0' &&
        tx.to.toLowerCase() === factoryAddress.toLowerCase() &&
        (tx.functionName?.toLowerCase().includes('createbskt') ||
         tx.methodId === '0x' || // Sometimes method is not decoded
         tx.input?.startsWith('0x')),
    );

    log({ phase: 'mev_analysis', action: 'found_candidates', count: createTxs.length });

    // Analyze up to 5 recent successful createBSKT transactions
    const sampled = createTxs.slice(0, 5);

    for (const tx of sampled) {
      findings.sampleTxHashes.push(tx.hash);

      if (!tx.input || tx.input === '0x') continue;

      try {
        const decoded = decodeCreateBSKTCalldata(config, tx.input as `0x${string}`);
        if (!decoded) continue;

        // Analyze signature field
        const sig = decoded.signature as string;
        const swapData = decoded.swapData as string[];
        const deadline = decoded.deadline;

        if (sig && sig !== '0x' && sig.length > 2) {
          findings.mevRequired = true;
          if (!findings.signingParams.includes('_signature')) {
            findings.signingParams.push('_signature');
          }
        }

        if (swapData && Array.isArray(swapData) && swapData.length > 0) {
          const nonEmptySwaps = swapData.filter((d: string) => d && d !== '0x' && d.length > 2);
          if (nonEmptySwaps.length > 0 && !findings.signingParams.includes('_swapData')) {
            findings.signingParams.push('_swapData');
          }

          findings.swapDataPatterns.push({
            txHash: tx.hash,
            swapDataCount: swapData.length,
            swapDataLengths: swapData.map((d: string) => (d as string).length),
            hasNonEmptySwaps: nonEmptySwaps.length > 0,
            tokenCount: (decoded.tokens as Address[])?.length ?? 0,
            tokens: decoded.tokens,
            weights: (decoded.weights as bigint[])?.map(String),
          });
        }

        if (deadline) {
          findings.observedDeadlines.push(String(deadline));
        }
      } catch (err: unknown) {
        logError({ phase: 'mev_analysis', action: 'decode_error', txHash: tx.hash, error: (err as Error).message });
      }
    }

    // Generate recommendation
    if (findings.mevRequired) {
      findings.recommendation =
        'The factory requires a backend-signed _signature parameter and pre-computed _swapData ' +
        'for MEV protection. To create BSKTs programmatically, you need to either: ' +
        '(1) Integrate with Alvara\'s backend API to obtain signed swap routes before calling createBSKT, or ' +
        '(2) Reverse-engineer the signing scheme from the observed signatures and deadlines. ' +
        'Option (1) is the recommended and supported path. ' +
        `Observed ${findings.sampleTxHashes.length} successful transactions with signatures.`;
    } else if (sampled.length === 0) {
      findings.recommendation =
        'No recent createBSKT transactions found on-chain. Cannot determine MEV requirements. ' +
        'Try again later or check the factory for paused state.';
    } else {
      findings.recommendation =
        'MEV protection does NOT appear to be required — observed successful transactions ' +
        'with empty or trivial signatures. Direct factory calls should work.';
    }
  } catch (err: unknown) {
    logError({ phase: 'mev_analysis', action: 'error', error: (err as Error).message });
    findings.recommendation = `MEV analysis failed: ${(err as Error).message}. Manual inspection required.`;
  }

  return findings;
}

// ── Extract revert reason from error ───────────────────────────────────────

function extractRevertReason(err: unknown): { reason: string; isSignatureRelated: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  const reason = msg.slice(0, 1000);

  const signatureIndicators = [
    'InvalidSignature',
    'invalid signature',
    'ECDSA',
    'signature',
    'signer',
    'deadline',
    'expired',
  ];

  const isSignatureRelated = signatureIndicators.some(
    indicator => reason.toLowerCase().includes(indicator.toLowerCase()),
  );

  return { reason, isSignatureRelated };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate env
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    logError({ phase: 'init', error: 'PRIVATE_KEY environment variable is required' });
    process.exit(1);
  }

  // Load factory config
  const config = loadFactoryConfig();
  log({ phase: 'init', action: 'config_loaded', factory: config.factoryAddress, chainId: config.chainId });

  // Create clients
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createBaseClient();
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org', { timeout: 15_000, retryCount: 2 }),
  });

  log({ phase: 'init', action: 'wallet_ready', address: account.address });

  // Check factory state
  const factoryState = await getFactoryState(publicClient, config);
  log({
    phase: 'factory_state',
    totalBSKT: String(factoryState.totalBSKT),
    minBSKTCreationAmount: formatEther(factoryState.minBSKTCreationAmount),
    paused: factoryState.paused,
    router: factoryState.router,
    weth: factoryState.weth,
    alva: factoryState.alva,
    minPercentALVA: factoryState.minPercentALVA,
  });

  if (factoryState.paused) {
    logError({ phase: 'factory_state', error: 'Factory is paused — cannot create BSKTs' });
    // Still do MEV analysis for documentation
    const findings = await analyzeMevProtection(config.factoryAddress, 'Factory is paused');
    writeMevFindings(findings);
    log({ success: false, reason: 'factory_paused', mevFindings: MEV_FINDINGS_PATH });
    process.exit(1);
  }

  // Check wallet balance
  const balance = await publicClient.getBalance({ address: account.address });
  log({ phase: 'balance', address: account.address, balanceEth: formatEther(balance) });

  const seedEth = '0.1';
  const seedWei = parseEther(seedEth);

  if (balance < seedWei) {
    logError({
      phase: 'balance',
      error: `Insufficient balance: ${formatEther(balance)} ETH < ${seedEth} ETH required`,
    });
    // Still do MEV analysis
    const findings = await analyzeMevProtection(config.factoryAddress, 'Insufficient wallet balance');
    writeMevFindings(findings);
    log({ success: false, reason: 'insufficient_balance', balanceEth: formatEther(balance), mevFindings: MEV_FINDINGS_PATH });
    process.exit(1);
  }

  // Attempt BSKT creation with ALVA + WETH (ALVA is required per minPercentALVA)
  // Using ALVA + WETH as a 2-token basket
  const tokens: Address[] = [KNOWN_ADDRESSES.ALVA, KNOWN_ADDRESSES.WETH];

  // Weights: respect minPercentALVA requirement
  // minPercentALVA is in basis points (e.g., 500 = 5%)
  const alvaWeightBps = Math.max(factoryState.minPercentALVA, 5000);
  const wethWeightBps = 10000 - alvaWeightBps;
  const weights: bigint[] = [BigInt(alvaWeightBps), BigInt(wethWeightBps)];

  const params: CreateBasketParams = {
    name: 'PinkBrain Test Basket',
    symbol: 'PBTB',
    tokens,
    weights,
    tokenURI: '',
    swapData: [], // Empty — testing if MEV protection is enforced
    signature: '0x' as `0x${string}`, // Empty signature — will fail if MEV is required
    basketId: `pinkbrain-test-${Date.now()}`,
    description: 'Programmatic BSKT creation test via PinkBrain',
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour from now
    seedValueEth: seedEth,
  };

  log({
    phase: 'create_bskt',
    action: 'attempt',
    tokens: params.tokens,
    weights: params.weights.map(String),
    seedEth: params.seedValueEth,
  });

  try {
    const result = await createBasket(walletClient, publicClient, config, params);

    // Success — BSKT created without MEV signing
    const findings: MevFindings = {
      mevRequired: false,
      factoryAddress: config.factoryAddress,
      analysisTimestamp: new Date().toISOString(),
      signingParams: [],
      sampleTxHashes: [result.txHash],
      observedDeadlines: [String(params.deadline)],
      swapDataPatterns: [],
      recommendation: 'Direct factory call succeeded without backend signatures. MEV protection is not enforced for basic creation.',
    };
    writeMevFindings(findings);

    log({
      success: true,
      bsktAddress: result.bsktAddress,
      txHash: result.txHash,
      gasUsed: String(result.gasUsed),
      creator: result.creator,
      mevFindings: MEV_FINDINGS_PATH,
    });
    process.exit(0);

  } catch (err: unknown) {
    const { reason, isSignatureRelated } = extractRevertReason(err);

    logError({
      phase: 'create_bskt',
      action: 'reverted',
      revertReason: reason,
      isSignatureRelated,
    });

    // Analyze MEV protection from on-chain data
    const findings = await analyzeMevProtection(config.factoryAddress, reason);
    findings.directCallRevertReason = reason;

    // If the revert is signature-related, that confirms MEV protection
    if (isSignatureRelated && !findings.mevRequired) {
      findings.mevRequired = true;
      findings.signingParams.push('_signature (confirmed by revert)');
      findings.recommendation =
        'Direct call reverted with signature error, confirming MEV protection is enforced. ' +
        findings.recommendation;
    }

    writeMevFindings(findings);

    log({
      success: false,
      mevRequired: findings.mevRequired,
      revertReason: reason.slice(0, 200),
      mevFindings: MEV_FINDINGS_PATH,
      sampleTxsAnalyzed: findings.sampleTxHashes.length,
    });
    process.exit(1);
  }
}

main().catch((err) => {
  logError({ phase: 'fatal', error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
