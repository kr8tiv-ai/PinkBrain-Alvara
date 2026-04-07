/**
 * Domain types inferred from the Drizzle schema + fund state machine.
 *
 * Re-exports $inferSelect / $inferInsert for every table so the rest of the
 * app never imports from drizzle-orm directly.
 */

import type {
  funds,
  fundWallets,
  fundDivestmentConfig,
  pipelineRuns,
  transactions,
} from './schema.js';

// ── Inferred row types ──────────────────────────────────────────────────

export type Fund = typeof funds.$inferSelect;
export type NewFund = typeof funds.$inferInsert;

export type FundWallet = typeof fundWallets.$inferSelect;
export type NewFundWallet = typeof fundWallets.$inferInsert;

export type FundDivestmentConfig = typeof fundDivestmentConfig.$inferSelect;
export type NewFundDivestmentConfig = typeof fundDivestmentConfig.$inferInsert;

export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type NewPipelineRun = typeof pipelineRuns.$inferInsert;

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;

// ── Fund status state machine ───────────────────────────────────────────

/** Union of all valid fund status values. */
export type FundStatus =
  | 'created'
  | 'configuring'
  | 'active'
  | 'divesting'
  | 'distributing'
  | 'completed'
  | 'paused'
  | 'failed';

/**
 * Exhaustive map of legal status transitions.
 *
 * - `completed` is terminal — no outbound transitions.
 * - `failed` can retry from scratch → `created`.
 * - `paused` can resume → `active` or declare failure.
 */
export const VALID_STATUS_TRANSITIONS: Record<FundStatus, FundStatus[]> = {
  created: ['configuring'],
  configuring: ['active', 'failed'],
  active: ['divesting', 'paused', 'failed'],
  divesting: ['distributing', 'failed'],
  distributing: ['completed', 'failed'],
  paused: ['active', 'failed'],
  completed: [],
  failed: ['created'],
};

/** Check whether a status transition is allowed by the state machine. */
export function isValidTransition(
  from: FundStatus,
  to: FundStatus,
): boolean {
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
