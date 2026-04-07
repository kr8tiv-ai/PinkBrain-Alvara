/**
 * Integration tests for the DivestmentRegistry contract.
 *
 * Deploys the contract to a local anvil instance (Foundry's local EVM),
 * then exercises the full flow: deploy → register → read → overwrite-revert → gas check.
 *
 * When anvil is unavailable, all tests skip gracefully (exit 0) so the test
 * suite doesn't block CI/verification gates.
 *
 * Requires: anvil (from Foundry) available on PATH.
 * Install with: curl -L https://foundry.paradigm.xyz | bash && foundryup
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'child_process';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { deployRegistry } from '../src/registry/deploy.js';
import {
  registerConfig,
  getConfig,
  fundIdToBytes32,
  encodeTriggerParams,
} from '../src/registry/client.js';
import { TriggerType } from '../src/registry/types.js';

// Suppress structured log output during tests
import { vi } from 'vitest';
vi.spyOn(console, 'log').mockImplementation(() => {});

// ── Anvil Discovery ─────────────────────────────────────────────────────

let anvilAvailable = false;

function checkAnvil(): boolean {
  try {
    execSync('anvil --version', { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Anvil Process Management ────────────────────────────────────────────

let anvil: ChildProcess | null = null;
let anvilPort: number;
let rpcUrl: string;

// Anvil well-known test accounts (deterministic from mnemonic)
const DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const READER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
const readerAccount = privateKeyToAccount(READER_KEY);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let publicClient: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deployerWallet: any;
let registryAddress: Address;

/**
 * Wait for anvil's RPC to accept connections.
 */
async function waitForAnvil(url: string, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
          id: 1,
        }),
      });
      if (resp.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ── Lifecycle ───────────────────────────────────────────────────────────

beforeAll(async () => {
  anvilAvailable = checkAnvil();
  if (!anvilAvailable) {
    console.warn(
      '⚠️  anvil not found — registry integration tests will be skipped. ' +
        'Install with: curl -L https://foundry.paradigm.xyz | bash && foundryup',
    );
    return;
  }

  // Pick a random port to avoid collisions
  anvilPort = 18545 + Math.floor(Math.random() * 1000);
  rpcUrl = `http://127.0.0.1:${anvilPort}`;

  // Start anvil
  anvil = spawn('anvil', ['--port', String(anvilPort), '--silent'], {
    stdio: 'pipe',
    detached: false,
  });

  anvil.on('error', (err) => {
    console.error(`anvil spawn error: ${err.message}`);
    anvilAvailable = false;
  });

  // Wait for anvil to be ready
  const ready = await waitForAnvil(rpcUrl, 10_000);
  if (!ready) {
    console.warn('⚠️  anvil failed to start within 10s — skipping integration tests.');
    anvilAvailable = false;
    if (anvil) {
      anvil.kill();
      anvil = null;
    }
    return;
  }

  // Create viem clients
  publicClient = createPublicClient({
    chain: foundry,
    transport: http(rpcUrl),
  });

  deployerWallet = createWalletClient({
    account: deployerAccount,
    chain: foundry,
    transport: http(rpcUrl),
  });
});

afterAll(async () => {
  if (anvil) {
    anvil.kill();
    anvil = null;
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('DivestmentRegistry Integration (anvil)', () => {
  it('deploys DivestmentRegistry and returns valid address', async (ctx) => {
    if (!anvilAvailable) ctx.skip();

    const result = await deployRegistry(deployerWallet, publicClient);

    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.gasUsed).toBeGreaterThan(0n);

    // Store for subsequent tests
    registryAddress = result.address;
  });

  const TEST_FUND_ID = '550e8400-e29b-41d4-a716-446655440000';
  const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;

  it('registers a config and reads it back with matching fields', async (ctx) => {
    if (!anvilAvailable) ctx.skip();

    const triggerParams = encodeTriggerParams(TriggerType.Time, {
      timeMs: 1_700_000_000_000,
    });

    const { txHash, gasUsed } = await registerConfig(
      deployerWallet,
      publicClient,
      registryAddress,
      {
        fundId: TEST_FUND_ID,
        holderSplitBps: 7000,
        ownerSplitBps: 3000,
        triggerType: TriggerType.Time,
        triggerParams,
        distributionCurrency: USDC_ADDRESS,
      },
    );

    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(gasUsed).toBeGreaterThan(0n);

    // Read it back
    const config = await getConfig(publicClient, registryAddress, TEST_FUND_ID);

    expect(config).not.toBeNull();
    expect(config!.holderSplitBps).toBe(7000);
    expect(config!.ownerSplitBps).toBe(3000);
    expect(config!.triggerType).toBe(TriggerType.Time);
    expect(config!.distributionCurrency.toLowerCase()).toBe(
      USDC_ADDRESS.toLowerCase(),
    );
    expect(config!.creator.toLowerCase()).toBe(
      deployerAccount.address.toLowerCase(),
    );
    expect(config!.registeredAt).toBeGreaterThan(0n);
  });

  it('reads config from a different account — public verifiability', async (ctx) => {
    if (!anvilAvailable) ctx.skip();

    // Use a different publicClient (reader account is irrelevant for reads,
    // but proving any account can read)
    const readerPublicClient = createPublicClient({
      chain: foundry,
      transport: http(rpcUrl),
    });

    const config = await getConfig(
      readerPublicClient,
      registryAddress,
      TEST_FUND_ID,
    );

    expect(config).not.toBeNull();
    expect(config!.holderSplitBps).toBe(7000);
    expect(config!.ownerSplitBps).toBe(3000);
  });

  it('reverts with AlreadyRegistered when overwriting', async (ctx) => {
    if (!anvilAvailable) ctx.skip();

    const triggerParams = encodeTriggerParams(TriggerType.Threshold, {
      thresholdUsd: 5000,
    });

    await expect(
      registerConfig(deployerWallet, publicClient, registryAddress, {
        fundId: TEST_FUND_ID,
        holderSplitBps: 5000,
        ownerSplitBps: 5000,
        triggerType: TriggerType.Threshold,
        triggerParams,
        distributionCurrency: USDC_ADDRESS,
      }),
    ).rejects.toThrow();
  });

  it('registration gas < 500k', async (ctx) => {
    if (!anvilAvailable) ctx.skip();

    const freshFundId = '660e8400-e29b-41d4-a716-446655440001';
    const triggerParams = encodeTriggerParams(TriggerType.Both, {
      timeMs: 1_700_000_000_000,
      thresholdUsd: 10_000,
    });

    const { gasUsed } = await registerConfig(
      deployerWallet,
      publicClient,
      registryAddress,
      {
        fundId: freshFundId,
        holderSplitBps: 6000,
        ownerSplitBps: 4000,
        triggerType: TriggerType.Both,
        triggerParams,
        distributionCurrency: USDC_ADDRESS,
      },
    );

    expect(gasUsed).toBeLessThan(500_000n);
  });

  it('getConfig returns null for unregistered fund', async (ctx) => {
    if (!anvilAvailable) ctx.skip();

    const config = await getConfig(
      publicClient,
      registryAddress,
      '00000000-0000-0000-0000-000000000000',
    );

    expect(config).toBeNull();
  });
});
