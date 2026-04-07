/**
 * Rebalance route plugin.
 *
 * POST /funds/:id/rebalance — validate fund exists and has bsktAddress,
 * call rebalanceBSKT() with request body parameters. Returns rebalance
 * result or 502 on Alvara API error.
 */

import type { FastifyPluginAsync } from 'fastify';
import { getFundById } from '../../db/fund-repository.js';
import { rebalanceBSKT, RebalanceMode } from '../../alvara/rebalance.js';
import { rebalanceBodySchema, fundIdParamsSchema } from '../schemas/rebalance.js';
import type { Address } from 'viem';

// ── Logging helper ─────────────────────────────────────────────────────

function log(action: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ module: 'api', action, ...data }));
}

// ── Serialise bigints to strings for JSON safety ───────────────────────

function serializeResult(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'bigint') {
      out[k] = String(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === 'bigint' ? String(item) : item,
      );
    } else if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      out[k] = serializeResult(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Route plugin ───────────────────────────────────────────────────────

const rebalanceRoutes: FastifyPluginAsync = async (app) => {
  const db = (app as any).db;

  app.post<{
    Params: { id: string };
    Body: {
      newTokens: string[];
      newWeights: number[];
      amountIn: string[];
      mode?: number;
      dryRun?: boolean;
    };
  }>('/funds/:id/rebalance', {
    schema: {
      params: fundIdParamsSchema,
      body: rebalanceBodySchema,
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { newTokens, newWeights, amountIn, mode, dryRun } = request.body;

    // 1. Check fund exists
    const fund = await getFundById(db, id);
    if (!fund) {
      return reply.status(404).send({
        error: 'FundNotFound',
        message: `Fund not found: ${id}`,
        statusCode: 404,
      });
    }

    // 2. Check fund has a bsktAddress
    if (!fund.bsktAddress) {
      return reply.status(409).send({
        error: 'NoBsktAddress',
        message: `Fund ${id} has no BSKT address — cannot rebalance before BSKT is created`,
        statusCode: 409,
      });
    }

    // 3. Check EVM clients are available
    const publicClient = (app as any).publicClient;
    const walletClient = (app as any).walletClient;
    if (!publicClient || !walletClient) {
      return reply.status(503).send({
        error: 'ServiceUnavailable',
        message: 'EVM clients not configured — rebalance requires publicClient and walletClient',
        statusCode: 503,
      });
    }

    // 4. Execute rebalance
    log('rebalance', { fundId: id, dryRun: dryRun ?? false, mode: mode ?? 0 });

    const result = await rebalanceBSKT({
      publicClient,
      walletClient,
      bsktAddress: fund.bsktAddress as Address,
      newTokens: newTokens as Address[],
      newWeights,
      amountIn,
      mode: mode ?? RebalanceMode.STANDARD,
      dryRun: dryRun ?? false,
    });

    // Serialize bigints for JSON response
    const serialized = serializeResult(result as unknown as Record<string, unknown>);

    log('rebalanceComplete', { fundId: id, txHash: result.txHash, dryRun: dryRun ?? false });

    return reply.status(200).send(serialized);
  });
};

export default rebalanceRoutes;
