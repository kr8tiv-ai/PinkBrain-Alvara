/**
 * Automated Alvara API discovery script.
 *
 * Discovers the full contract topology and investment interfaces by:
 * 1. Reading factory config to get beacon addresses
 * 2. Resolving beacons to implementations via on-chain reads
 * 3. Fetching verified ABIs from Blockscout
 * 4. Analyzing real contribute() transactions for API patterns
 * 5. Probing likely API endpoints
 *
 * Usage: npx tsx scripts/discover-alvara-api.ts
 */

import 'dotenv/config';
import { createPublicClient, http, getContract, getAddress, formatEther } from 'viem';
import { base } from 'viem/chains';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const client = createPublicClient({
  chain: base,
  transport: http('https://base.drpc.org', { timeout: 30_000, retryCount: 3 }),
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchBlockscoutABI(address: string): Promise<{ name: string; abi: unknown[] } | null> {
  try {
    const resp = await fetch(
      `https://base.blockscout.com/api/v2/smart-contracts/${address}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { abi?: unknown[]; is_verified?: boolean; name?: string };
    if (data.abi && data.is_verified) {
      return { name: data.name || 'Unknown', abi: data.abi };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveBeacon(beaconAddress: string): Promise<string> {
  const beaconAbi = [{
    inputs: [],
    name: 'implementation',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  }];
  const beacon = getContract({
    address: beaconAddress as `0x${string}`,
    abi: beaconAbi,
    client: client as any,
  });
  return (beacon as any).read.implementation() as Promise<string>;
}

async function probeEndpoint(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await resp.text().catch(() => '');
    return { status: resp.status, body: body.slice(0, 500) };
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Alvara API Discovery ===\n');

  // Step 1: Load factory config
  const configPath = resolve(__dirname, '../src/config/discovered-contracts.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  console.log('Factory:', config.factoryAddress);

  const factoryContract = getContract({
    address: config.factoryAddress,
    abi: config.abi,
    client: client as any,
  });

  // Step 2: Resolve beacon addresses
  console.log('\n--- Resolving contract topology ---');

  const bsktBeacon = await (factoryContract as any).read.bsktImplementation();
  console.log('BSKT Beacon:', bsktBeacon);
  await delay(500);

  const bsktImpl = await resolveBeacon(bsktBeacon);
  console.log('BSKT Implementation:', bsktImpl);
  await delay(500);

  const pairBeacon = await (factoryContract as any).read.bsktPairImplementation();
  console.log('BSKTPair Beacon:', pairBeacon);
  await delay(500);

  const pairImpl = await resolveBeacon(pairBeacon);
  console.log('BSKTPair Implementation:', pairImpl);
  await delay(500);

  const bsktUtils = await (factoryContract as any).read.bsktUtils();
  console.log('BSKTUtils:', bsktUtils);
  await delay(500);

  const router = await (factoryContract as any).read.router();
  console.log('1inch Router:', router);
  await delay(500);

  // Step 3: Fetch verified ABIs
  console.log('\n--- Fetching verified ABIs ---');

  const bsktAbi = await fetchBlockscoutABI(bsktImpl);
  if (bsktAbi) {
    console.log(`BSKT (${bsktAbi.name}): ${(bsktAbi.abi as any[]).filter(i => i.type === 'function').length} functions`);
    const bsktFns = (bsktAbi.abi as any[]).filter(i => i.type === 'function').map(i => i.name);
    const investFns = bsktFns.filter(n =>
      ['contribute', 'withdraw', 'withdrawETH', 'rebalance', 'claimFee'].includes(n)
    );
    console.log('  Investment functions:', investFns.join(', '));
    writeFileSync(resolve(__dirname, '../src/config/bskt-logic-abi.json'), JSON.stringify(bsktAbi.abi, null, 2));
    console.log('  Saved: src/config/bskt-logic-abi.json');
  } else {
    console.log('BSKT: not verified on Blockscout');
  }
  await delay(500);

  const pairAbiData = await fetchBlockscoutABI(pairImpl);
  if (pairAbiData) {
    console.log(`BSKTPair (${pairAbiData.name}): ${(pairAbiData.abi as any[]).filter(i => i.type === 'function').length} functions`);
    if (!existsSync(resolve(__dirname, '../src/config/bskt-pair-abi.json'))) {
      writeFileSync(resolve(__dirname, '../src/config/bskt-pair-abi.json'), JSON.stringify(pairAbiData.abi, null, 2));
      console.log('  Saved: src/config/bskt-pair-abi.json');
    } else {
      console.log('  Already exists: src/config/bskt-pair-abi.json');
    }
  } else {
    console.log('BSKTPair: not verified');
  }

  // Step 4: Analyze sample contribute transaction
  console.log('\n--- Analyzing contribute transactions ---');

  const sampleBskt = config.relatedContracts?.sampleBskt?.address;
  if (sampleBskt) {
    console.log('Sample BSKT:', sampleBskt);
    const txResp = await fetch(
      `https://base.blockscout.com/api/v2/addresses/${sampleBskt}/transactions`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const txData = await txResp.json() as any;
    const contributeTxs = (txData.items || []).filter((tx: any) =>
      tx.decoded_input?.method_call?.includes('contribute')
    );
    console.log(`Found ${contributeTxs.length} contribute transactions`);

    for (const tx of contributeTxs) {
      console.log(`\n  Hash: ${tx.hash}`);
      console.log(`  From: ${tx.from?.hash}`);
      console.log(`  Value: ${formatEther(BigInt(tx.value))} ETH`);
      console.log(`  Method: ${tx.decoded_input?.method_call?.split('(')[0]}`);

      const params = tx.decoded_input?.parameters || [];
      for (const p of params) {
        if (p.name === '_deadline') {
          const deadlineDate = new Date(Number(p.value) * 1000);
          console.log(`  Deadline: ${p.value} (${deadlineDate.toISOString()})`);
        } else if (p.name === '_signature') {
          console.log(`  Signature length: ${String(p.value).length} chars`);
        } else if (p.name === '_swapData') {
          const swapArr = JSON.parse(p.value || '[]');
          console.log(`  SwapData entries: ${swapArr.length}`);
          for (let i = 0; i < swapArr.length; i++) {
            console.log(`    [${i}] length: ${String(swapArr[i]).length} chars, selector: ${String(swapArr[i]).slice(0, 10)}`);
          }
        }
      }
    }
  }

  // Step 5: Probe likely API endpoints
  console.log('\n--- Probing API endpoints ---');

  const baseUrls = [
    'https://api.alvara.xyz',
    'https://bskt-api.alvara.xyz',
    'https://backend.alvara.xyz',
    'https://bskt.alvara.xyz/api',
  ];

  for (const baseUrl of baseUrls) {
    const result = await probeEndpoint(baseUrl);
    if (result) {
      const isCloudflare = result.body.includes('Cloudflare') || result.body.includes('cf-');
      console.log(`  ${baseUrl}: ${result.status}${isCloudflare ? ' (Cloudflare)' : ''}`);
      if (!isCloudflare && result.status < 500) {
        console.log(`    Body preview: ${result.body.slice(0, 200)}`);
      }
    } else {
      console.log(`  ${baseUrl}: unreachable`);
    }
    await delay(500);
  }

  // Step 6: Summary
  console.log('\n=== Discovery Summary ===');
  console.log('Contract topology:');
  console.log(`  Factory:        ${config.factoryAddress}`);
  console.log(`  BSKT Beacon:    ${bsktBeacon}`);
  console.log(`  BSKT Impl:      ${bsktImpl} (${bsktAbi?.name || 'unverified'})`);
  console.log(`  Pair Beacon:    ${pairBeacon}`);
  console.log(`  Pair Impl:      ${pairImpl} (${pairAbiData?.name || 'unverified'})`);
  console.log(`  BSKTUtils:      ${bsktUtils}`);
  console.log(`  1inch Router:   ${router}`);
  console.log('\nInvestment path:');
  console.log('  BSKT.contribute{value}(_swapData, _signature, _deadline)');
  console.log('  → Internal: wraps ETH → platform fee → 1inch swaps → BSKTPair.mint()');
  console.log('\nBackend signing:');
  console.log('  Required for: contribute, withdrawETH, rebalance, claimFee, createBSKT');
  console.log('  Not required for: withdraw (redeem for underlying tokens)');
  console.log('\nDiscovery complete.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
