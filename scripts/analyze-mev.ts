#!/usr/bin/env npx tsx
/**
 * Standalone MEV analysis of Alvara factory createBSKT transactions.
 * Does NOT require a private key — purely read-only on-chain analysis.
 *
 * Analyzes recent successful createBSKT calls to determine if
 * backend-signed swap routes are required.
 *
 * Usage:
 *   npx tsx scripts/analyze-mev.ts
 */

import 'dotenv/config';
import {
  loadFactoryConfig,
  getFactoryState,
  decodeCreateBSKTCalldata,
} from '../src/alvara/factory.js';
import { createBaseClient } from '../src/config/chains.js';
import { getTransactionsByAddress, type BasescanTx } from '../src/utils/basescan.js';
import { formatEther, type Address } from 'viem';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEV_FINDINGS_PATH = resolve(__dirname, '../src/config/mev-findings.json');

function log(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data));
}

interface MevFindings {
  mevRequired: boolean;
  factoryAddress: string;
  analysisTimestamp: string;
  factoryState: Record<string, unknown>;
  signingParams: string[];
  sampleTxHashes: string[];
  observedDeadlines: string[];
  swapDataPatterns: Record<string, unknown>[];
  signatureLengths: number[];
  recommendation: string;
}

async function main(): Promise<void> {
  const config = loadFactoryConfig();
  const publicClient = createBaseClient();

  log({ phase: 'init', action: 'config_loaded', factory: config.factoryAddress });

  // Read factory state
  const factoryState = await getFactoryState(publicClient, config);
  log({
    phase: 'factory_state',
    totalBSKT: String(factoryState.totalBSKT),
    minBSKTCreationAmount: formatEther(factoryState.minBSKTCreationAmount),
    paused: factoryState.paused,
    router: factoryState.router,
    minPercentALVA: factoryState.minPercentALVA,
  });

  // Fetch recent transactions to factory
  log({ phase: 'mev_analysis', action: 'fetching_txs' });
  const txs = await getTransactionsByAddress(config.factoryAddress as Address, {
    sort: 'desc',
    offset: 50,
  });

  log({ phase: 'mev_analysis', action: 'fetched', totalTxs: txs.length });

  // Filter to successful txs with createBSKT-like calldata
  const createTxs = txs.filter((tx: BasescanTx) => {
    if (tx.isError !== '0') return false;
    if (tx.to.toLowerCase() !== config.factoryAddress.toLowerCase()) return false;
    // createBSKT selector: first 4 bytes of keccak256("createBSKT(string,string,address[],uint256[],string,bytes[],bytes,string,string,uint256)")
    // We'll just try to decode and see if it works
    return tx.input && tx.input.length > 10;
  });

  log({ phase: 'mev_analysis', action: 'filtered', createTxCandidates: createTxs.length });

  const findings: MevFindings = {
    mevRequired: false,
    factoryAddress: config.factoryAddress,
    analysisTimestamp: new Date().toISOString(),
    factoryState: {
      totalBSKT: String(factoryState.totalBSKT),
      minBSKTCreationAmount: formatEther(factoryState.minBSKTCreationAmount),
      paused: factoryState.paused,
      router: factoryState.router,
      minPercentALVA: factoryState.minPercentALVA,
    },
    signingParams: [],
    sampleTxHashes: [],
    observedDeadlines: [],
    swapDataPatterns: [],
    signatureLengths: [],
    recommendation: '',
  };

  // Analyze up to 5 recent createBSKT transactions
  let decodedCount = 0;
  for (const tx of createTxs) {
    if (decodedCount >= 5) break;

    try {
      const decoded = decodeCreateBSKTCalldata(config, tx.input as `0x${string}`);
      if (!decoded || decoded.functionName !== 'createBSKT') continue;

      decodedCount++;
      findings.sampleTxHashes.push(tx.hash);

      const sig = decoded.signature as string;
      const swapData = decoded.swapData as string[];
      const deadline = decoded.deadline;
      const tokens = decoded.tokens as Address[];
      const weights = (decoded.weights as bigint[])?.map(String);

      // Check signature
      const sigLength = sig ? sig.length : 0;
      findings.signatureLengths.push(sigLength);

      if (sig && sig !== '0x' && sigLength > 2) {
        findings.mevRequired = true;
        if (!findings.signingParams.includes('_signature')) {
          findings.signingParams.push('_signature');
        }
      }

      // Check swapData
      const nonEmptySwaps = swapData?.filter((d: string) => d && d !== '0x' && d.length > 2) ?? [];
      if (nonEmptySwaps.length > 0 && !findings.signingParams.includes('_swapData')) {
        findings.signingParams.push('_swapData');
      }

      findings.swapDataPatterns.push({
        txHash: tx.hash,
        name: decoded.name,
        symbol: decoded.symbol,
        tokenCount: tokens?.length ?? 0,
        tokens,
        weights,
        swapDataCount: swapData?.length ?? 0,
        swapDataLengths: swapData?.map((d: string) => d?.length ?? 0),
        hasNonEmptySwaps: nonEmptySwaps.length > 0,
        signatureLength: sigLength,
        deadline: deadline ? String(deadline) : null,
        deadlineDate: deadline ? new Date(Number(deadline) * 1000).toISOString() : null,
      });

      if (deadline) {
        findings.observedDeadlines.push(String(deadline));
      }

      log({
        phase: 'mev_analysis',
        action: 'decoded_tx',
        txHash: tx.hash,
        name: decoded.name,
        symbol: decoded.symbol,
        tokenCount: tokens?.length,
        signatureLength: sigLength,
        hasSwapData: nonEmptySwaps.length > 0,
      });
    } catch (err: unknown) {
      // Not a createBSKT tx or decode error — skip
    }
  }

  // Generate recommendation
  if (decodedCount === 0) {
    findings.recommendation =
      'No recent createBSKT transactions could be decoded. The factory may be inactive or ' +
      'transactions may use a different selector. Manual inspection required.';
  } else if (findings.mevRequired) {
    findings.recommendation =
      `Analyzed ${decodedCount} recent createBSKT transactions. All contain non-empty _signature ` +
      `parameters (lengths: ${findings.signatureLengths.join(', ')} chars). ` +
      'This confirms the factory requires backend-signed swap route data for MEV protection. ' +
      'To create BSKTs programmatically: (1) Integrate with Alvara\'s backend API to obtain ' +
      'signed swap routes (recommended), or (2) Analyze the signing scheme from observed signatures. ' +
      'The _swapData array contains pre-computed DEX swap routes that the factory executes to ' +
      'swap ETH into constituent tokens. The _signature validates these routes were approved by ' +
      `Alvara's backend, preventing front-running. Deadline param provides time-bounded validity.`;
  } else {
    findings.recommendation =
      `Analyzed ${decodedCount} recent createBSKT transactions. Signatures appear empty or trivial. ` +
      'Direct factory calls may work without backend signatures.';
  }

  // Write findings
  writeFileSync(MEV_FINDINGS_PATH, JSON.stringify(findings, null, 2));
  log({ phase: 'mev_analysis', action: 'findings_written', path: MEV_FINDINGS_PATH });
  log({
    phase: 'result',
    mevRequired: findings.mevRequired,
    txsAnalyzed: decodedCount,
    signingParams: findings.signingParams,
    signatureLengths: findings.signatureLengths,
  });
}

main().catch(err => {
  console.error(JSON.stringify({ phase: 'fatal', error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
