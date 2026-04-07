/**
 * Fund CRUD routes plugin.
 *
 * POST /funds    — create fund + wallets + divestment config + lock config
 * GET  /funds    — list funds with optional ?status filter
 * GET  /funds/:id — fund detail (fund + wallets + divestment config + recent txs)
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  createFund,
  listFunds,
  getFundById,
  setFundWallets,
  setDivestmentConfig,
  lockDivestmentConfig,
  getDivestmentConfig,
  getFundWallets,
  getTransactionsByFund,
} from '../../db/fund-repository.js';
import {
  createFundBodySchema,
  listFundsQuerySchema,
  fundParamsSchema,
} from '../schemas/funds.js';
import type { FundStatus } from '../../db/types.js';

// ── Logging helper ─────────────────────────────────────────────────────

function log(action: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ module: 'api', action, ...data }));
}

// ── Serialisation helpers ──────────────────────────────────────────────

function serializeDates(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

function serializeFund(fund: Record<string, unknown>) {
  return serializeDates(fund);
}

// ── Route plugin ───────────────────────────────────────────────────────

const fundRoutes: FastifyPluginAsync = async (app) => {
  const db = (app as any).db;

  // POST /funds — create fund + wallets + divestment config + lock
  app.post<{
    Body: {
      name: string;
      tokenMint: string;
      creatorWallet: string;
      targetChain: 'base' | 'solana';
      protocolFeeBps: number;
      accumulationThresholdLamports?: string;
      wallets: Array<{ chain: string; address: string; walletType: string }>;
      divestmentConfig: {
        holderSplitBps: number;
        ownerSplitBps: number;
        triggerType: string;
        triggerParams: Record<string, unknown>;
        distributionCurrency: string;
      };
    };
  }>('/funds', {
    schema: {
      body: createFundBodySchema,
    },
  }, async (request, reply) => {
    const body = request.body;

    // 1. Create fund
    const fund = await createFund(db, {
      name: body.name,
      tokenMint: body.tokenMint,
      creatorWallet: body.creatorWallet,
      targetChain: body.targetChain,
      protocolFeeBps: body.protocolFeeBps,
      accumulationThresholdLamports: body.accumulationThresholdLamports,
    });

    // 2. Set wallets
    const wallets = await setFundWallets(
      db,
      fund.id,
      body.wallets.map((w) => ({
        chain: w.chain as 'base' | 'solana',
        address: w.address,
        walletType: w.walletType,
      })),
    );

    // 3. Set divestment config
    const divConfig = await setDivestmentConfig(db, {
      fundId: fund.id,
      holderSplitBps: body.divestmentConfig.holderSplitBps,
      ownerSplitBps: body.divestmentConfig.ownerSplitBps,
      triggerType: body.divestmentConfig.triggerType,
      triggerParams: body.divestmentConfig.triggerParams,
      distributionCurrency: body.divestmentConfig.distributionCurrency,
    });

    // 4. Lock divestment config
    const lockedConfig = await lockDivestmentConfig(db, fund.id);

    log('createFundComplete', { fundId: fund.id, name: fund.name });

    return reply.status(201).send({
      fund: serializeFund(fund as unknown as Record<string, unknown>),
      wallets: wallets.map((w) => serializeDates(w as unknown as Record<string, unknown>)),
      divestmentConfig: serializeDates(lockedConfig as unknown as Record<string, unknown>),
    });
  });

  // GET /funds — list with optional ?status filter
  app.get<{
    Querystring: { status?: FundStatus };
  }>('/funds', {
    schema: {
      querystring: listFundsQuerySchema,
    },
  }, async (request, reply) => {
    const filters = request.query.status
      ? { status: request.query.status }
      : undefined;

    const allFunds = await listFunds(db, filters);

    log('listFunds', { count: allFunds.length, status: filters?.status ?? 'all' });

    return reply.send(
      allFunds.map((f) => serializeFund(f as unknown as Record<string, unknown>)),
    );
  });

  // GET /funds/:id — fund detail with wallets, divestment config, and recent txs
  app.get<{
    Params: { id: string };
  }>('/funds/:id', {
    schema: {
      params: fundParamsSchema,
    },
  }, async (request, reply) => {
    const fund = await getFundById(db, request.params.id);
    if (!fund) {
      return reply.status(404).send({
        error: 'FundNotFound',
        message: `Fund not found: ${request.params.id}`,
        statusCode: 404,
      });
    }

    const [wallets, divConfig, txs] = await Promise.all([
      getFundWallets(db, fund.id),
      getDivestmentConfig(db, fund.id),
      getTransactionsByFund(db, fund.id),
    ]);

    log('getFundDetail', { fundId: fund.id });

    return reply.send({
      fund: serializeFund(fund as unknown as Record<string, unknown>),
      wallets: wallets.map((w) => serializeDates(w as unknown as Record<string, unknown>)),
      divestmentConfig: divConfig
        ? serializeDates(divConfig as unknown as Record<string, unknown>)
        : null,
      recentTransactions: txs.map((t) => serializeDates(t as unknown as Record<string, unknown>)),
    });
  });
};

export default fundRoutes;
