/**
 * Integration tests for the fund repository layer.
 *
 * These run against a real PostgreSQL instance (Docker) — no mocking.
 * The value is proving real SQL execution, constraint enforcement, and
 * the Drizzle ORM mapping all work correctly.
 *
 * Requires: PostgreSQL running at DATABASE_URL or default localhost:5432.
 * Start with: docker compose up -d postgres
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createDb, closeDb } from '../src/db/connection.js';
import type { AppDb } from '../src/db/connection.js';
import {
  createFund,
  getFundById,
  listFunds,
  updateFundStatus,
  updateFundBsktAddress,
  setFundWallets,
  getFundWallets,
  setDivestmentConfig,
  lockDivestmentConfig,
  getDivestmentConfig,
  createPipelineRun,
  updatePipelineRun,
  getActivePipelineRuns,
  recordTransaction,
  confirmTransaction,
  getTransactionsByFund,
} from '../src/db/fund-repository.js';
import {
  FundNotFound,
  InvalidStateTransition,
  ConfigLocked,
} from '../src/db/errors.js';
import type { FundStatus } from '../src/db/types.js';
import {
  funds,
  fundWallets,
  fundDivestmentConfig,
  pipelineRuns,
  transactions,
} from '../src/db/schema.js';

// Suppress structured log output during tests
import { vi } from 'vitest';
vi.spyOn(console, 'log').mockImplementation(() => {});

let db: AppDb;

/** Helper: create a minimal valid fund for test setup. */
function testFundInput(overrides?: Record<string, unknown>) {
  return {
    name: 'Test Fund',
    tokenMint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    creatorWallet: '5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG',
    targetChain: 'base' as const,
    protocolFeeBps: 200,
    ...overrides,
  };
}

beforeAll(() => {
  db = createDb();
});

beforeEach(async () => {
  // Truncate in reverse FK order for isolation
  await db.delete(transactions);
  await db.delete(pipelineRuns);
  await db.delete(fundDivestmentConfig);
  await db.delete(fundWallets);
  await db.delete(funds);
});

afterAll(async () => {
  await closeDb();
});

// ── Fund CRUD ───────────────────────────────────────────────────────────

describe('Fund CRUD', () => {
  it('creates a fund with all required fields and returns generated UUID', async () => {
    const fund = await createFund(db, testFundInput());
    expect(fund.id).toBeDefined();
    expect(fund.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(fund.name).toBe('Test Fund');
    expect(fund.status).toBe('created');
    expect(fund.protocolFeeBps).toBe(200);
    expect(fund.targetChain).toBe('base');
    expect(fund.bsktAddress).toBeNull();
    expect(fund.createdAt).toBeInstanceOf(Date);
  });

  it('getFundById returns the created fund', async () => {
    const created = await createFund(db, testFundInput());
    const fetched = await getFundById(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe('Test Fund');
  });

  it('getFundById returns null for nonexistent UUID', async () => {
    const result = await getFundById(
      db,
      '00000000-0000-0000-0000-000000000000',
    );
    expect(result).toBeNull();
  });

  it('listFunds returns all funds', async () => {
    await createFund(db, testFundInput({ name: 'Fund A' }));
    await createFund(db, testFundInput({ name: 'Fund B' }));
    const all = await listFunds(db);
    expect(all).toHaveLength(2);
  });

  it('listFunds filters by status', async () => {
    const fund = await createFund(db, testFundInput());
    await updateFundStatus(db, fund.id, 'configuring');
    await createFund(db, testFundInput({ name: 'Still Created' }));

    const configuring = await listFunds(db, { status: 'configuring' });
    expect(configuring).toHaveLength(1);
    expect(configuring[0].name).toBe('Test Fund');

    const created = await listFunds(db, { status: 'created' });
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('Still Created');
  });

  it('updateFundBsktAddress sets the bskt_address field', async () => {
    const fund = await createFund(db, testFundInput());
    const bsktAddr = '0x1234567890abcdef1234567890abcdef12345678';
    const updated = await updateFundBsktAddress(db, fund.id, bsktAddr);
    expect(updated.bsktAddress).toBe(bsktAddr);

    const fetched = await getFundById(db, fund.id);
    expect(fetched!.bsktAddress).toBe(bsktAddr);
  });
});

// ── State Machine ───────────────────────────────────────────────────────

describe('State machine', () => {
  it('valid transition: created → configuring', async () => {
    const fund = await createFund(db, testFundInput());
    const updated = await updateFundStatus(db, fund.id, 'configuring');
    expect(updated.status).toBe('configuring');
  });

  it('valid full lifecycle: created → configuring → active → divesting → distributing → completed', async () => {
    const fund = await createFund(db, testFundInput());
    const transitions: FundStatus[] = [
      'configuring',
      'active',
      'divesting',
      'distributing',
      'completed',
    ];
    let current = fund;
    for (const next of transitions) {
      current = await updateFundStatus(db, current.id, next);
      expect(current.status).toBe(next);
    }
  });

  it('invalid transition: created → active throws InvalidStateTransition', async () => {
    const fund = await createFund(db, testFundInput());
    await expect(
      updateFundStatus(db, fund.id, 'active'),
    ).rejects.toThrow(InvalidStateTransition);
    await expect(
      updateFundStatus(db, fund.id, 'active'),
    ).rejects.toMatchObject({
      name: 'InvalidStateTransition',
      fundId: fund.id,
      currentStatus: 'created',
      requestedStatus: 'active',
    });
  });

  it('invalid transition: completed → active throws InvalidStateTransition', async () => {
    const fund = await createFund(db, testFundInput());
    // Drive to completed
    await updateFundStatus(db, fund.id, 'configuring');
    await updateFundStatus(db, fund.id, 'active');
    await updateFundStatus(db, fund.id, 'divesting');
    await updateFundStatus(db, fund.id, 'distributing');
    await updateFundStatus(db, fund.id, 'completed');

    await expect(
      updateFundStatus(db, fund.id, 'active'),
    ).rejects.toThrow(InvalidStateTransition);
  });

  it('failed state: active → failed succeeds', async () => {
    const fund = await createFund(db, testFundInput());
    await updateFundStatus(db, fund.id, 'configuring');
    await updateFundStatus(db, fund.id, 'active');
    const failed = await updateFundStatus(db, fund.id, 'failed');
    expect(failed.status).toBe('failed');
  });

  it('retry: failed → created succeeds', async () => {
    const fund = await createFund(db, testFundInput());
    await updateFundStatus(db, fund.id, 'configuring');
    await updateFundStatus(db, fund.id, 'failed');
    const retried = await updateFundStatus(db, fund.id, 'created');
    expect(retried.status).toBe('created');
  });
});

// ── Divestment Config & Immutability (R017) ─────────────────────────────

describe('Divestment config & immutability (R017)', () => {
  it('setDivestmentConfig creates config for a fund', async () => {
    const fund = await createFund(db, testFundInput());
    const config = await setDivestmentConfig(db, {
      fundId: fund.id,
      holderSplitBps: 7000,
      ownerSplitBps: 3000,
      triggerType: 'time',
      triggerParams: { intervalHours: 24 },
      distributionCurrency: 'usdc',
    });
    expect(config.fundId).toBe(fund.id);
    expect(config.holderSplitBps).toBe(7000);
    expect(config.ownerSplitBps).toBe(3000);
    expect(config.lockedAt).toBeNull();
  });

  it('getDivestmentConfig returns null for fund without config', async () => {
    const fund = await createFund(db, testFundInput());
    const config = await getDivestmentConfig(db, fund.id);
    expect(config).toBeNull();
  });

  it('lockDivestmentConfig sets lockedAt timestamp', async () => {
    const fund = await createFund(db, testFundInput());
    await setDivestmentConfig(db, {
      fundId: fund.id,
      holderSplitBps: 5000,
      ownerSplitBps: 5000,
      triggerType: 'threshold',
      triggerParams: { minValue: 1000 },
      distributionCurrency: 'sol',
    });
    const locked = await lockDivestmentConfig(db, fund.id);
    expect(locked.lockedAt).toBeInstanceOf(Date);
  });

  it('setDivestmentConfig on locked config throws ConfigLocked', async () => {
    const fund = await createFund(db, testFundInput());
    await setDivestmentConfig(db, {
      fundId: fund.id,
      holderSplitBps: 7000,
      ownerSplitBps: 3000,
      triggerType: 'time',
      triggerParams: { intervalHours: 24 },
      distributionCurrency: 'usdc',
    });
    await lockDivestmentConfig(db, fund.id);

    await expect(
      setDivestmentConfig(db, {
        fundId: fund.id,
        holderSplitBps: 6000,
        ownerSplitBps: 4000,
        triggerType: 'time',
        triggerParams: { intervalHours: 48 },
        distributionCurrency: 'usdc',
      }),
    ).rejects.toThrow(ConfigLocked);
  });

  it('bps summing to exactly 10000 is valid', async () => {
    const fund = await createFund(db, testFundInput());
    const config = await setDivestmentConfig(db, {
      fundId: fund.id,
      holderSplitBps: 5000,
      ownerSplitBps: 5000,
      triggerType: 'time',
      triggerParams: { intervalHours: 12 },
      distributionCurrency: 'usdc',
    });
    expect(config.holderSplitBps + config.ownerSplitBps).toBe(10000);
  });

  it('bps summing to 10001 throws', async () => {
    const fund = await createFund(db, testFundInput());
    await expect(
      setDivestmentConfig(db, {
        fundId: fund.id,
        holderSplitBps: 5001,
        ownerSplitBps: 5000,
        triggerType: 'time',
        triggerParams: {},
        distributionCurrency: 'usdc',
      }),
    ).rejects.toThrow(/Split bps exceed 10000/);
  });
});

// ── Wallets ─────────────────────────────────────────────────────────────

describe('Wallets', () => {
  it('setFundWallets creates wallets for a fund', async () => {
    const fund = await createFund(db, testFundInput());
    const wallets = await setFundWallets(db, fund.id, [
      { fundId: fund.id, chain: 'solana', address: 'SoL1111111111', walletType: 'treasury' },
    ]);
    expect(wallets).toHaveLength(1);
    expect(wallets[0].fundId).toBe(fund.id);
    expect(wallets[0].walletType).toBe('treasury');
  });

  it('getFundWallets returns all wallets', async () => {
    const fund = await createFund(db, testFundInput());
    await setFundWallets(db, fund.id, [
      { fundId: fund.id, chain: 'solana', address: 'SoL1111111111', walletType: 'treasury' },
    ]);
    const fetched = await getFundWallets(db, fund.id);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].chain).toBe('solana');
  });

  it('multiple wallet types for same fund', async () => {
    const fund = await createFund(db, testFundInput());
    await setFundWallets(db, fund.id, [
      { fundId: fund.id, chain: 'solana', address: 'SoL1111111111', walletType: 'treasury' },
      { fundId: fund.id, chain: 'base', address: '0xabc123', walletType: 'operations' },
    ]);
    const fetched = await getFundWallets(db, fund.id);
    expect(fetched).toHaveLength(2);
    const types = fetched.map((w) => w.walletType).sort();
    expect(types).toEqual(['operations', 'treasury']);
  });
});

// ── Pipeline Runs ───────────────────────────────────────────────────────

describe('Pipeline runs', () => {
  it('createPipelineRun creates a run', async () => {
    const fund = await createFund(db, testFundInput());
    const run = await createPipelineRun(db, {
      fundId: fund.id,
      direction: 'outbound',
      phase: 'claiming',
    });
    expect(run.id).toBeDefined();
    expect(run.fundId).toBe(fund.id);
    expect(run.status).toBe('pending');
    expect(run.phase).toBe('claiming');
  });

  it('updatePipelineRun updates status and phase', async () => {
    const fund = await createFund(db, testFundInput());
    const run = await createPipelineRun(db, {
      fundId: fund.id,
      direction: 'outbound',
      phase: 'claiming',
    });
    const updated = await updatePipelineRun(db, run.id, {
      status: 'running',
      phase: 'swapping',
    });
    expect(updated.status).toBe('running');
    expect(updated.phase).toBe('swapping');
  });

  it('updatePipelineRun sets error on failure', async () => {
    const fund = await createFund(db, testFundInput());
    const run = await createPipelineRun(db, {
      fundId: fund.id,
      direction: 'outbound',
      phase: 'bridging',
    });
    const failed = await updatePipelineRun(db, run.id, {
      status: 'failed',
      error: 'Bridge timeout after 30s',
    });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Bridge timeout after 30s');
  });

  it('getActivePipelineRuns returns only pending/running runs', async () => {
    const fund = await createFund(db, testFundInput());
    const pending = await createPipelineRun(db, {
      fundId: fund.id,
      direction: 'outbound',
      phase: 'claiming',
    });
    const running = await createPipelineRun(db, {
      fundId: fund.id,
      direction: 'outbound',
      phase: 'swapping',
    });
    await updatePipelineRun(db, running.id, { status: 'running' });

    const completed = await createPipelineRun(db, {
      fundId: fund.id,
      direction: 'outbound',
      phase: 'bridging',
    });
    await updatePipelineRun(db, completed.id, { status: 'completed' });

    const active = await getActivePipelineRuns(db, fund.id);
    expect(active).toHaveLength(2);
    const statuses = active.map((r) => r.status).sort();
    expect(statuses).toEqual(['pending', 'running']);
  });
});

// ── Transactions ────────────────────────────────────────────────────────

describe('Transactions', () => {
  it('recordTransaction creates a transaction record', async () => {
    const fund = await createFund(db, testFundInput());
    const tx = await recordTransaction(db, {
      fundId: fund.id,
      chain: 'solana',
      txHash: '3xY7z8...mockTxHash',
      operation: 'fee_claim',
      amount: '1000000',
      token: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    });
    expect(tx.id).toBeDefined();
    expect(tx.status).toBe('pending');
    expect(tx.operation).toBe('fee_claim');
    expect(tx.amount).toBe('1000000');
  });

  it('confirmTransaction sets status and confirmedAt', async () => {
    const fund = await createFund(db, testFundInput());
    const tx = await recordTransaction(db, {
      fundId: fund.id,
      chain: 'solana',
      txHash: 'abc123',
      operation: 'swap',
      amount: '500000',
      token: 'SOL',
    });
    const confirmed = await confirmTransaction(db, tx.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
  });

  it('getTransactionsByFund returns all transactions for a fund', async () => {
    const fund = await createFund(db, testFundInput());
    await recordTransaction(db, {
      fundId: fund.id,
      chain: 'solana',
      txHash: 'tx1',
      operation: 'fee_claim',
      amount: '100',
      token: 'SOL',
    });
    await recordTransaction(db, {
      fundId: fund.id,
      chain: 'base',
      txHash: 'tx2',
      operation: 'bskt_create',
      amount: '200',
      token: '0xabc',
    });
    const txs = await getTransactionsByFund(db, fund.id);
    expect(txs).toHaveLength(2);
  });
});
