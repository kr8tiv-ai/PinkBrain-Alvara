/**
 * Fetch BSKTPair ABI via beacon chain: factory.bsktPairImplementation() → beacon.implementation() → Blockscout ABI
 * Same pattern as K004 for BSKT logic.
 */
import { createPublicClient, http, getContract } from 'viem';
import { base } from 'viem/chains';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== Fetching BSKTPair ABI via beacon chain ===');

  const config = JSON.parse(readFileSync(resolve(__dirname, '../src/config/discovered-contracts.json'), 'utf-8'));
  const client = createPublicClient({
    chain: base,
    transport: http('https://base.drpc.org', { timeout: 30_000, retryCount: 3 }),
  });

  // Step 1: factory.bsktPairImplementation() → beacon address
  console.log('Step 1: Calling factory.bsktPairImplementation()...');
  const factoryContract = getContract({
    address: config.factoryAddress,
    abi: config.abi,
    client: client as any,
  });
  const bsktPairBeacon = await (factoryContract as any).read.bsktPairImplementation();
  console.log('BSKTPair beacon address:', bsktPairBeacon);

  await delay(500);

  // Step 2: beacon.implementation() → logic contract
  console.log('Step 2: Calling beacon.implementation()...');
  const beaconAbi = [{
    inputs: [],
    name: 'implementation',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  }];
  const beacon = getContract({
    address: bsktPairBeacon,
    abi: beaconAbi,
    client: client as any,
  });
  const logicAddr = await (beacon as any).read.implementation();
  console.log('BSKTPair logic contract:', logicAddr);

  await delay(500);

  // Step 3: Fetch verified ABI from Blockscout
  console.log('Step 3: Fetching verified ABI from Blockscout...');
  const blockscoutUrl = `https://base.blockscout.com/api/v2/smart-contracts/${logicAddr}`;
  const resp = await fetch(blockscoutUrl, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    throw new Error(`Blockscout returned ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const data = await resp.json() as { abi?: unknown[]; is_verified?: boolean; name?: string };

  if (!data.abi || !data.is_verified) {
    console.error('Contract not verified on Blockscout. Trying Blockscout address endpoint...');
    // Fallback: try as proxy
    const proxyUrl = `https://base.blockscout.com/api/v2/smart-contracts/${bsktPairBeacon}`;
    const proxyResp = await fetch(proxyUrl, { signal: AbortSignal.timeout(15_000) });
    if (proxyResp.ok) {
      const proxyData = await proxyResp.json() as { abi?: unknown[]; is_verified?: boolean; name?: string };
      if (proxyData.abi && proxyData.is_verified) {
        console.log('Found verified ABI on beacon address instead');
        writeAbi(proxyData.abi, proxyData.name || 'BSKTPair', bsktPairBeacon, logicAddr);
        return;
      }
    }
    throw new Error('BSKTPair logic contract ABI not verified on Blockscout');
  }

  console.log(`Contract name: ${data.name}`);
  console.log(`ABI entries: ${data.abi.length}`);

  writeAbi(data.abi, data.name || 'BSKTPair', bsktPairBeacon, logicAddr);
}

function writeAbi(abi: unknown[], name: string, beaconAddr: string, logicAddr: string) {
  const outPath = resolve(__dirname, '../src/config/bskt-pair-abi.json');
  writeFileSync(outPath, JSON.stringify(abi, null, 2));
  console.log(`Wrote ABI to ${outPath}`);

  // Print function names
  const functions = (abi as any[]).filter(i => i.type === 'function').map(i => i.name);
  console.log(`\nFunctions (${functions.length}):`);
  console.log(functions.join(', '));

  // Print events
  const events = (abi as any[]).filter(i => i.type === 'event').map(i => i.name);
  console.log(`\nEvents (${events.length}):`);
  console.log(events.join(', '));

  // Check for contribute-like functions
  const contributeFns = functions.filter(n =>
    n.toLowerCase().includes('contribute') ||
    n.toLowerCase().includes('buy') ||
    n.toLowerCase().includes('deposit') ||
    n.toLowerCase().includes('add')
  );
  if (contributeFns.length > 0) {
    console.log(`\n✅ Found contribute-like functions: ${contributeFns.join(', ')}`);
  } else {
    console.log('\n⚠️ No contribute-like functions found in BSKTPair');
    console.log('Functions found:', functions.join(', '));
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Contract name: ${name}`);
  console.log(`Beacon address: ${beaconAddr}`);
  console.log(`Logic address: ${logicAddr}`);
  console.log(`Functions: ${functions.length}`);
  console.log(`Events: ${events.length}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
