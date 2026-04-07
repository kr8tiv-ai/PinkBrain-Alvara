/**
 * Fund data model schema — Drizzle ORM / PostgreSQL.
 *
 * 5 tables: funds, fundWallets, fundDivestmentConfig, pipelineRuns, transactions
 * 4 enums: fundStatus, chain, pipelinePhase, operation
 *
 * Design notes:
 * - UUIDs everywhere for cross-chain friendliness.
 * - `amount` is text (atomic units as string) for bigint safety across chains.
 * - `fundDivestmentConfig` is 1:1 with funds (unique constraint on fundId).
 * - `transactions` link optionally to a pipelineRun for orchestration context.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';

// ── Enums ───────────────────────────────────────────────────────────────

export const fundStatusEnum = pgEnum('fund_status', [
  'created',
  'configuring',
  'active',
  'divesting',
  'distributing',
  'completed',
  'paused',
  'failed',
]);

export const chainEnum = pgEnum('chain', ['solana', 'base', 'ethereum']);

export const pipelinePhaseEnum = pgEnum('pipeline_phase', [
  'claiming',
  'swapping',
  'bridging',
  'investing',
  'divesting',
  'distributing',
]);

export const operationEnum = pgEnum('operation', [
  'fee_claim',
  'swap',
  'bridge_send',
  'bridge_receive',
  'bskt_create',
  'bskt_rebalance',
  'bskt_redeem',
  'distribution',
]);

// ── Tables ──────────────────────────────────────────────────────────────

export const funds = pgTable('funds', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  tokenMint: text('token_mint').notNull(),
  creatorWallet: text('creator_wallet').notNull(),
  status: fundStatusEnum('status').notNull().default('created'),
  targetChain: chainEnum('target_chain').notNull(),
  protocolFeeBps: integer('protocol_fee_bps').notNull(),
  bsktAddress: text('bskt_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const fundWallets = pgTable('fund_wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  fundId: uuid('fund_id')
    .notNull()
    .references(() => funds.id),
  chain: chainEnum('chain').notNull(),
  address: text('address').notNull(),
  walletType: text('wallet_type').notNull(), // 'treasury' | 'operations'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const fundDivestmentConfig = pgTable('fund_divestment_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  fundId: uuid('fund_id')
    .notNull()
    .unique()
    .references(() => funds.id),
  holderSplitBps: integer('holder_split_bps').notNull(),
  ownerSplitBps: integer('owner_split_bps').notNull(),
  triggerType: text('trigger_type').notNull(), // 'time' | 'threshold' | 'both'
  triggerParams: jsonb('trigger_params').notNull(),
  distributionCurrency: text('distribution_currency').notNull(), // 'usdc' | 'sol'
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const pipelineRuns = pgTable('pipeline_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  fundId: uuid('fund_id')
    .notNull()
    .references(() => funds.id),
  direction: text('direction').notNull(), // 'outbound' | 'inbound'
  phase: pipelinePhaseEnum('phase').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed'
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  error: text('error'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  fundId: uuid('fund_id')
    .notNull()
    .references(() => funds.id),
  pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id),
  chain: chainEnum('chain').notNull(),
  txHash: text('tx_hash').notNull(),
  operation: operationEnum('operation').notNull(),
  amount: text('amount').notNull(), // atomic units as string for bigint safety
  token: text('token').notNull(), // address or mint
  status: text('status').notNull().default('pending'), // 'pending' | 'confirmed' | 'failed'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});
