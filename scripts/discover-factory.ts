/**
 * discover-factory.ts — Find Alvara's BSKT factory contract on Base from public on-chain data.
 *
 * Discovery strategy:
 * 1. Find ALVA token deployer via Blockscout
 * 2. Enumerate deployer's deployed contracts AND interaction targets
 * 3. For each candidate, check: is it named "Factory"? Does it have createBSKT? Internal creates?
 * 4. Get verified ABI from Blockscout (implementation if proxy)
 * 5. Run EIP-1967 proxy detection
 * 6. Write results to src/config/discovered-contracts.json
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Address } from 'viem';
import { createBaseClient, KNOWN_ADDRESSES } from '../src/config/chains.js';
import {
  getContractCreationTxs,
  getTransactionsByAddress,
  getInternalTxsByAddress,
  getContractABI,
  getAddressInfo,
} from '../src/utils/basescan.js';
import { detectProxy } from '../src/utils/proxy.js';

// ── Logging ────��───────────────────────────────────────────────────────────

function log(phase: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ phase, ...data }));
}

function logError(phase: string, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ phase, error: msg }));
}

// ── Types ──────���───────────────────────────────────────────────────────────

interface DiscoveredContract {
  factoryAddress: Address;
  factoryProxyAddress: Address;
  implementationAddress: Address;
  adminAddress?: Address;
  isProxy: boolean;
  abi: unknown[];
  deployer: Address;
  factoryDeployer: Address;
  discoveredAt: string;
  chainId: number;
  discoveryMethod: string;
  knownFunctions: string[];
  allDeployerContracts: Array<{ address: string; name?: string; isProxy?: boolean }>;
  relatedContracts: Record<string, { address: string; name?: string }>;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const client = createBaseClient();

  // ── Step A: Find ALVA token deployer ───────────────────────────────────
  log('step_a', { action: 'finding_alva_deployer', alvaToken: KNOWN_ADDRESSES.ALVA });

  const alvaCreation = await getContractCreationTxs(KNOWN_ADDRESSES.ALVA);
  if (!alvaCreation.length) {
    logError('step_a', 'Could not find ALVA token creation info');
    process.exit(1);
  }

  const deployer = alvaCreation[0].contractCreator.toLowerCase() as Address;
  log('step_a_result', { deployer, alvaTxHash: alvaCreation[0].txHash });

  // ── Step B: Get deployer's deployed contracts ──────────────────────────
  log('step_b', { action: 'enumerating_deployer_contracts', deployer });

  const deployerTxs = await getTransactionsByAddress(deployer as Address, { offset: 300, sort: 'asc' });

  const deployedContracts: Array<{ address: Address; txHash: string }> = [];
  for (const tx of deployerTxs) {
    if (tx.contractAddress && tx.contractAddress !== '') {
      const addr = tx.contractAddress.toLowerCase() as Address;
      if (!deployedContracts.find(d => d.address === addr)) {
        deployedContracts.push({ address: addr, txHash: tx.hash });
      }
    }
  }

  log('step_b_deployed', { count: deployedContracts.length, addresses: deployedContracts.map(c => c.address) });

  // ── Step B2: Get deployer's interaction targets ────────────────────────
  // The factory may not be deployed by the same address — it could be deployed
  // by a separate deployer but called by the ALVA deployer.
  const interactionTargets = [...new Set(
    deployerTxs
      .filter(tx => tx.to && tx.to !== '' && tx.input && tx.input.length > 10)
      .map(tx => tx.to.toLowerCase() as Address)
  )].filter(addr => !deployedContracts.find(d => d.address === addr));

  log('step_b2_interactions', { uniqueTargets: interactionTargets.length });

  // ── Step C: Score ALL candidates (deployed + interaction targets) ──────
  log('step_c', { action: 'scoring_all_candidates' });

  interface ScoredCandidate {
    address: Address;
    name?: string;
    score: number;
    reasons: string[];
    isProxy: boolean;
    implAddress?: Address;
    adminAddress?: Address;
    implName?: string;
    verifiedFunctions?: string[];
    source: 'deployed' | 'interaction';
  }

  const candidates: ScoredCandidate[] = [];
  const allAddresses = [
    ...deployedContracts.map(c => ({ address: c.address, source: 'deployed' as const })),
    ...interactionTargets.map(addr => ({ address: addr, source: 'interaction' as const })),
  ];

  for (const { address, source } of allAddresses) {
    // Skip known non-factory things
    if (address === KNOWN_ADDRESSES.ALVA.toLowerCase()) continue;

    let score = 0;
    const reasons: string[] = [];
    let name: string | undefined;
    let implName: string | undefined;
    let verifiedFunctions: string[] | undefined;

    // Get address info
    try {
      const info = await getAddressInfo(address);
      name = info.name ?? undefined;
      if (!info.is_contract) continue;

      const lowerName = (name ?? '').toLowerCase();
      if (lowerName.includes('factory')) {
        score += 50;
        reasons.push(`name "${name}" contains "factory"`);
      }
      if (lowerName.includes('basket') || lowerName.includes('bskt')) {
        score += 30;
        reasons.push(`name "${name}" contains basket/bskt keyword`);
      }
    } catch { continue; }

    // Proxy detection
    const proxy = await detectProxy(client, address);
    if (proxy.isProxy && proxy.implementationAddress) {
      reasons.push('is upgradeable proxy');

      // Check implementation name and ABI
      try {
        const implInfo = await getAddressInfo(proxy.implementationAddress);
        implName = implInfo.name ?? undefined;

        const implLower = (implName ?? '').toLowerCase();
        if (implLower.includes('factory')) {
          score += 60;
          reasons.push(`implementation named "${implName}"`);
        }
        if (implLower.includes('basket') || implLower.includes('bskt')) {
          score += 30;
          reasons.push(`implementation named "${implName}"`);
        }
      } catch { /* non-critical */ }

      // Try to get verified ABI from implementation
      const implAbiStr = await getContractABI(proxy.implementationAddress);
      if (implAbiStr) {
        try {
          const implAbi = JSON.parse(implAbiStr);
          const fns = implAbi
            .filter((e: { type: string }) => e.type === 'function')
            .map((e: { name: string }) => e.name);
          verifiedFunctions = fns;

          // Check for factory-like functions
          const factoryFns = fns.filter((fn: string) =>
            fn.toLowerCase().includes('create') ||
            fn.toLowerCase().includes('basket') ||
            fn.toLowerCase().includes('bskt')
          );
          if (factoryFns.length > 0) {
            score += 40 * factoryFns.length;
            reasons.push(`has factory functions: ${factoryFns.join(', ')}`);
          }
        } catch { /* non-critical */ }
      }
    }

    // Also try verified ABI on the address itself
    if (!verifiedFunctions) {
      const abiStr = await getContractABI(address);
      if (abiStr) {
        try {
          const abi = JSON.parse(abiStr);
          const fns = abi
            .filter((e: { type: string }) => e.type === 'function')
            .map((e: { name: string }) => e.name);
          verifiedFunctions = fns;
          const factoryFns = fns.filter((fn: string) =>
            fn.toLowerCase().includes('create') ||
            fn.toLowerCase().includes('basket') ||
            fn.toLowerCase().includes('bskt')
          );
          if (factoryFns.length > 0) {
            score += 40 * factoryFns.length;
            reasons.push(`has factory functions: ${factoryFns.join(', ')}`);
          }
        } catch { /* non-critical */ }
      }
    }

    // Check deployer's calls to this address for method names
    const callsToThis = deployerTxs.filter(tx => tx.to?.toLowerCase() === address);
    for (const tx of callsToThis) {
      const fn = (tx.functionName || '').toLowerCase();
      if (fn.includes('create') && (fn.includes('bskt') || fn.includes('basket'))) {
        score += 100;
        reasons.push(`deployer called "${tx.functionName}" on this contract`);
      }
    }

    if (score > 0 || reasons.length > 0) {
      candidates.push({
        address,
        name,
        score,
        reasons,
        isProxy: proxy.isProxy,
        implAddress: proxy.implementationAddress,
        adminAddress: proxy.adminAddress,
        implName,
        verifiedFunctions,
        source,
      });
    }

    log('step_c_scored', {
      address,
      name: name ?? '(unnamed)',
      implName: implName ?? null,
      score,
      reasons: reasons.length > 0 ? reasons : ['no factory signals'],
      source,
      hasVerifiedAbi: !!verifiedFunctions,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  log('step_c_result', {
    candidateCount: candidates.length,
    topCandidates: candidates.slice(0, 5).map(c => ({
      address: c.address,
      name: c.name,
      implName: c.implName,
      score: c.score,
      reasons: c.reasons,
    })),
  });

  if (candidates.length === 0 || candidates[0].score === 0) {
    logError('discovery', 'No factory candidates found');
    process.exit(1);
  }

  const factory = candidates[0];
  log('factory_selected', {
    factoryAddress: factory.address,
    name: factory.name,
    implName: factory.implName,
    score: factory.score,
    reasons: factory.reasons,
    isProxy: factory.isProxy,
    implAddress: factory.implAddress,
    source: factory.source,
    functionCount: factory.verifiedFunctions?.length ?? 0,
  });

  // ── Step D: Get full verified ABI ──────────────────────────────────────
  log('step_d', { action: 'getting_verified_abi' });

  let fullAbi: unknown[] = [];
  if (factory.isProxy && factory.implAddress) {
    const implAbiStr = await getContractABI(factory.implAddress);
    if (implAbiStr) {
      fullAbi = JSON.parse(implAbiStr);
      log('step_d_result', { source: 'implementation', entryCount: fullAbi.length });
    }
  }
  if (fullAbi.length === 0) {
    const proxyAbiStr = await getContractABI(factory.address);
    if (proxyAbiStr) {
      fullAbi = JSON.parse(proxyAbiStr);
      log('step_d_result', { source: 'proxy', entryCount: fullAbi.length });
    }
  }

  // ── Step E: Identify related contracts ─────────────────────────────────
  log('step_e', { action: 'identifying_related_contracts' });

  const relatedContracts: Record<string, { address: string; name?: string }> = {};

  // ALVA token
  relatedContracts.alvaToken = {
    address: KNOWN_ADDRESSES.ALVA,
    name: 'ALVA (TransparentUpgradeableProxy → AlvaraBase)',
  };

  // From factory's verified functions, find referenced contracts
  if (factory.verifiedFunctions) {
    // Check for router reference
    if (factory.verifiedFunctions.includes('router')) {
      log('step_e_hint', { hint: 'factory has router() function — MEV router is a separate contract' });
    }
    // Check for BSKT implementation reference
    if (factory.verifiedFunctions.includes('bsktImplementation')) {
      log('step_e_hint', { hint: 'factory has bsktImplementation() — BSKTs are deployed as proxies of this impl' });
    }
  }

  // Find BSKTs: contracts the deployer contributed to (0x056ef was one)
  for (const tx of deployerTxs) {
    const fn = (tx.functionName || '').toLowerCase();
    if (fn === 'contribute' && tx.to) {
      const bsktAddr = tx.to.toLowerCase();
      if (!relatedContracts.sampleBskt) {
        relatedContracts.sampleBskt = { address: bsktAddr, name: 'Sample BSKT (deployer contributed to it)' };
        log('step_e_bskt', { address: bsktAddr, method: tx.functionName });
      }
    }
  }

  // ── Step F: Write results ────��─────────────────────────────────────────
  const result: DiscoveredContract = {
    factoryAddress: factory.address,
    factoryProxyAddress: factory.address,
    implementationAddress: factory.implAddress ?? factory.address,
    adminAddress: factory.adminAddress,
    isProxy: factory.isProxy,
    abi: fullAbi,
    deployer,
    factoryDeployer: '(see factoryProxyAddress creation info on Blockscout)',
    discoveredAt: new Date().toISOString(),
    chainId: 8453,
    discoveryMethod: factory.reasons.join('; '),
    knownFunctions: factory.verifiedFunctions ?? [],
    allDeployerContracts: deployedContracts.map(c => ({ address: c.address })),
    relatedContracts,
  };

  // Enrich allDeployerContracts with names
  for (const c of result.allDeployerContracts) {
    try {
      const info = await getAddressInfo(c.address as Address);
      c.name = info.name ?? undefined;
    } catch { /* skip */ }
  }

  const outDir = join(process.cwd(), 'src', 'config');
  const outFile = join(outDir, 'discovered-contracts.json');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');

  log('step_f_result', {
    outputFile: 'src/config/discovered-contracts.json',
    factoryAddress: result.factoryAddress,
    implementationAddress: result.implementationAddress,
    isProxy: result.isProxy,
    abiEntryCount: result.abi.length,
    knownFunctionCount: result.knownFunctions.length,
    chainId: result.chainId,
  });

  // Final summary
  console.log('\n' + JSON.stringify({
    phase: 'discovery_complete',
    factoryAddress: result.factoryAddress,
    implementationAddress: result.implementationAddress,
    isProxy: result.isProxy,
    abiEntryCount: result.abi.length,
    knownFunctions: result.knownFunctions,
    deployer: result.deployer,
    chainId: result.chainId,
    discoveryMethod: result.discoveryMethod,
    relatedContracts: result.relatedContracts,
  }, null, 2));
}

main().catch(err => {
  logError('fatal', err);
  process.exit(1);
});
