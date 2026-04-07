/**
 * Fund repository — typed interface between the application and the database.
 *
 * Every function accepts a Drizzle `db` instance (from `createDb()`) so
 * callers control connection lifetime and tests can inject stubs.
 *
 * Business rules enforced here:
 * - Status transitions validated against the state machine (types.ts)
 * - Divestment config immutability after lock (R017)
 * - Basis-point sanity (holderSplitBps + ownerSplitBps ≤ 10 000)
 */

import { eq, and, or, sql } from 'drizzle-orm';
import type { AppDb } from './connection.js';
import {
  funds,
  fundWallets,
  fundDivestmentConfig,
  pipelineRuns,
  transactions,
} from './schema.js';
import type {
  Fund,
  NewFund,
  FundWallet,
  NewFundWallet,
  FundDivestmentConfig as FundDivestmentConfigRow,
  NewFundDivestmentConfig,
  PipelineRun,
  NewPipelineRun,
  Transaction,
  NewTransaction,
  FundStatus,
} from './types.js';
import { isValidTransition } from './types.js';
import {
  FundNotFound,
  InvalidStateTransition,
  ConfigLocked,
} from './errors.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function log(action: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ module: 'db', action, ...data }));
}

// ── Fund CRUD ───────────────────────────────────────────────────────────

export async function createFund(
  db: AppDb,
  input: NewFund,
): Promise<Fund> {
  const [created] = await db.insert(funds).values(input).returning();
  log('createFund', { fundId: created.id, name: created.name });
  return created;
}

export async function getFundById(
  db: AppDb,
  id: string,
): Promise<Fund | null> {
  const rows = await db.select().from(funds).where(eq(funds.id, id));
  return rows[0] ?? null;
}

export async function listFunds(
  db: AppDb,
  filters?: { status?: FundStatus },
): Promise<Fund[]> {
  if (filters?.status) {
    return db
      .select()
      .from(funds)
      .where(eq(funds.status, filters.status));
  }
  return db.select().from(funds);
}

export async function updateFundStatus(
  db: AppDb,
  id: string,
  newStatus: FundStatus,
): Promise<Fund> {
  const existing = await getFundById(db, id);
  if (!existing) throw new FundNotFound(id);

  const currentStatus = existing.status as FundStatus;
  if (!isValidTransition(currentStatus, newStatus)) {
    throw new InvalidStateTransition(id, currentStatus, newStatus);
  }

  const [updated] = await db
    .update(funds)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(funds.id, id))
    .returning();

  log('updateFundStatus', {
    fundId: id,
    from: currentStatus,
    to: newStatus,
  });
  return updated;
}

export async function updateFundBsktAddress(
  db: AppDb,
  id: string,
  bsktAddress: string,
): Promise<Fund> {
  const existing = await getFundById(db, id);
  if (!existing) throw new FundNotFound(id);

  const [updated] = await db
    .update(funds)
    .set({ bsktAddress, updatedAt: new Date() })
    .where(eq(funds.id, id))
    .returning();

  log('updateFundBsktAddress', { fundId: id, bsktAddress });
  return updated;
}

// ── Wallets ─────────────────────────────────────────────────────────────

export async function setFundWallets(
  db: AppDb,
  fundId: string,
  wallets: NewFundWallet[],
): Promise<FundWallet[]> {
  const withFundId = wallets.map((w) => ({ ...w, fundId }));
  const inserted = await db
    .insert(fundWallets)
    .values(withFundId)
    .returning();

  log('setFundWallets', { fundId, count: inserted.length });
  return inserted;
}

export async function getFundWallets(
  db: AppDb,
  fundId: string,
): Promise<FundWallet[]> {
  return db
    .select()
    .from(fundWallets)
    .where(eq(fundWallets.fundId, fundId));
}

// ── Divestment Config (R017 immutability) ───────────────────────────────

export async function setDivestmentConfig(
  db: AppDb,
  config: NewFundDivestmentConfig,
): Promise<FundDivestmentConfigRow> {
  // Validate bps
  if (config.holderSplitBps + config.ownerSplitBps > 10_000) {
    throw new Error(
      `Split bps exceed 10000: holder=${config.holderSplitBps} + owner=${config.ownerSplitBps} = ${config.holderSplitBps + config.ownerSplitBps}`,
    );
  }

  // Check existing config
  const existing = await getDivestmentConfig(db, config.fundId);

  if (existing) {
    // If locked, reject update (R017)
    if (existing.lockedAt) {
      throw new ConfigLocked(config.fundId, existing.lockedAt);
    }

    // Not locked — update in place
    const [updated] = await db
      .update(fundDivestmentConfig)
      .set({
        holderSplitBps: config.holderSplitBps,
        ownerSplitBps: config.ownerSplitBps,
        triggerType: config.triggerType,
        triggerParams: config.triggerParams,
        distributionCurrency: config.distributionCurrency,
      })
      .where(eq(fundDivestmentConfig.fundId, config.fundId))
      .returning();

    log('setDivestmentConfig', {
      fundId: config.fundId,
      mode: 'update',
    });
    return updated;
  }

  // No existing config — insert
  const [created] = await db
    .insert(fundDivestmentConfig)
    .values(config)
    .returning();

  log('setDivestmentConfig', {
    fundId: config.fundId,
    mode: 'insert',
  });
  return created;
}

export async function lockDivestmentConfig(
  db: AppDb,
  fundId: string,
): Promise<FundDivestmentConfigRow> {
  const existing = await getDivestmentConfig(db, fundId);
  if (!existing) {
    throw new Error(`No divestment config found for fund ${fundId}`);
  }
  if (existing.lockedAt) {
    throw new ConfigLocked(fundId, existing.lockedAt);
  }

  const now = new Date();
  const [locked] = await db
    .update(fundDivestmentConfig)
    .set({ lockedAt: now })
    .where(eq(fundDivestmentConfig.fundId, fundId))
    .returning();

  log('lockDivestmentConfig', { fundId, lockedAt: now.toISOString() });
  return locked;
}

export async function getDivestmentConfig(
  db: AppDb,
  fundId: string,
): Promise<FundDivestmentConfigRow | null> {
  const rows = await db
    .select()
    .from(fundDivestmentConfig)
    .where(eq(fundDivestmentConfig.fundId, fundId));
  return rows[0] ?? null;
}

// ── Pipeline Runs ───────────────────────────────────────────────────────

export async function createPipelineRun(
  db: AppDb,
  input: NewPipelineRun,
): Promise<PipelineRun> {
  const [created] = await db
    .insert(pipelineRuns)
    .values(input)
    .returning();

  log('createPipelineRun', {
    fundId: created.fundId,
    runId: created.id,
    phase: created.phase,
  });
  return created;
}

export async function updatePipelineRun(
  db: AppDb,
  id: string,
  updates: {
    status?: string;
    phase?: string;
    error?: string;
    metadata?: unknown;
    completedAt?: Date;
  },
): Promise<PipelineRun> {
  // Build a partial update object — only set provided fields
  const setClause: Record<string, unknown> = {};
  if (updates.status !== undefined) setClause.status = updates.status;
  if (updates.phase !== undefined) setClause.phase = updates.phase;
  if (updates.error !== undefined) setClause.error = updates.error;
  if (updates.metadata !== undefined) setClause.metadata = updates.metadata;
  if (updates.completedAt !== undefined)
    setClause.completedAt = updates.completedAt;

  const [updated] = await db
    .update(pipelineRuns)
    .set(setClause)
    .where(eq(pipelineRuns.id, id))
    .returning();

  log('updatePipelineRun', { runId: id, updates: Object.keys(setClause) });
  return updated;
}

export async function getActivePipelineRuns(
  db: AppDb,
  fundId: string,
): Promise<PipelineRun[]> {
  return db
    .select()
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.fundId, fundId),
        or(
          eq(pipelineRuns.status, 'pending'),
          eq(pipelineRuns.status, 'running'),
        ),
      ),
    );
}

// ── Transactions ────────────────────────────────────────────────────────

export async function recordTransaction(
  db: AppDb,
  input: NewTransaction,
): Promise<Transaction> {
  const [created] = await db
    .insert(transactions)
    .values(input)
    .returning();

  log('recordTransaction', {
    fundId: created.fundId,
    txId: created.id,
    operation: created.operation,
    chain: created.chain,
  });
  return created;
}

export async function confirmTransaction(
  db: AppDb,
  id: string,
): Promise<Transaction> {
  const [confirmed] = await db
    .update(transactions)
    .set({ status: 'confirmed', confirmedAt: new Date() })
    .where(eq(transactions.id, id))
    .returning();

  log('confirmTransaction', { txId: id });
  return confirmed;
}

export async function getTransactionsByFund(
  db: AppDb,
  fundId: string,
): Promise<Transaction[]> {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.fundId, fundId));
}
