/**
 * Emergency stables/revert route plugin.
 *
 * POST /funds/:id/emergency        — convert BSKT to stables, persist snapshot
 * POST /funds/:id/emergency/revert — restore from DB snapshot or body snapshot
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  getFundById,
  createPipelineRun,
  getActivePipelineRuns,
  getPipelineRunById,
} from '../../db/fund-repository.js';
import { emergencyStables, emergencyRevert } from '../../alvara/emergency.js';
import { emergencyBodySchema, emergencyRevertBodySchema } from '../schemas/emergency.js';
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

const emergencyRoutes: FastifyPluginAsync = async (app) => {
  const db = (app as any).db;

  // ── POST /funds/:id/emergency ─────────────────────────────────

  app.post<{
    Params: { id: string };
    Body: {
      amountIn?: string[];
      dryRun?: boolean;
    };
  }>('/funds/:id/emergency', {
    schema: {
      params: {
        type: 'object' as const,
        properties: { id: { type: 'string' as const, format: 'uuid' } },
        required: ['id'],
      },
      body: emergencyBodySchema,
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { amountIn, dryRun } = request.body ?? {};

    // 1. Check fund exists
    const fund = await getFundById(db, id);
    if (!fund) {
      return reply.status(404).send({
        error: 'FundNotFound',
        message: `Fund not found: ${id}`,
        statusCode: 404,
      });
    }

    // 2. Check fund has bsktAddress
    if (!fund.bsktAddress) {
      return reply.status(409).send({
        error: 'NoBsktAddress',
        message: `Fund ${id} has no BSKT address — cannot execute emergency stables`,
        statusCode: 409,
      });
    }

    // 3. Check EVM clients
    const publicClient = (app as any).publicClient;
    const walletClient = (app as any).walletClient;
    if (!publicClient || !walletClient) {
      return reply.status(503).send({
        error: 'ServiceUnavailable',
        message: 'EVM clients not configured — emergency stables requires publicClient and walletClient',
        statusCode: 503,
      });
    }

    // 4. Execute emergency stables
    log('emergencyStables', { fundId: id, dryRun: dryRun ?? false });

    const result = await emergencyStables({
      publicClient,
      walletClient,
      bsktAddress: fund.bsktAddress as Address,
      amountIn,
      dryRun: dryRun ?? false,
    });

    // 5. Persist snapshot as pipeline_run metadata (non-dry-run only)
    let pipelineRunId: string | null = null;
    if (!dryRun) {
      const snapshotData = {
        tokens: result.snapshot.tokens,
        weights: result.snapshot.weights.map((w) => String(w)),
      };

      const pipelineRun = await createPipelineRun(db, {
        fundId: id,
        direction: 'outbound',
        phase: 'investing',
        status: 'running',
        metadata: {
          type: 'emergency_snapshot',
          snapshot: snapshotData,
        },
      });

      pipelineRunId = pipelineRun.id;
      log('emergencySnapshotPersisted', { fundId: id, pipelineRunId });
    }

    // 6. Serialize and respond
    const serialized = serializeResult({
      ...result,
      snapshot: {
        tokens: result.snapshot.tokens,
        weights: result.snapshot.weights.map((w) => String(w)),
      },
    } as unknown as Record<string, unknown>);

    log('emergencyStablesComplete', { fundId: id, pipelineRunId });

    return reply.status(200).send({
      ...serialized,
      pipelineRunId,
    });
  });

  // ── POST /funds/:id/emergency/revert ──────────────────────────

  app.post<{
    Params: { id: string };
    Body: {
      snapshot?: { tokens: string[]; weights: string[] };
      amountIn?: string[];
      dryRun?: boolean;
    };
  }>('/funds/:id/emergency/revert', {
    schema: {
      params: {
        type: 'object' as const,
        properties: { id: { type: 'string' as const, format: 'uuid' } },
        required: ['id'],
      },
      body: emergencyRevertBodySchema,
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { snapshot: bodySnapshot, amountIn, dryRun } = request.body ?? {};

    // 1. Check fund exists
    const fund = await getFundById(db, id);
    if (!fund) {
      return reply.status(404).send({
        error: 'FundNotFound',
        message: `Fund not found: ${id}`,
        statusCode: 404,
      });
    }

    // 2. Check fund has bsktAddress
    if (!fund.bsktAddress) {
      return reply.status(409).send({
        error: 'NoBsktAddress',
        message: `Fund ${id} has no BSKT address — cannot revert emergency`,
        statusCode: 409,
      });
    }

    // 3. Check EVM clients
    const publicClient = (app as any).publicClient;
    const walletClient = (app as any).walletClient;
    if (!publicClient || !walletClient) {
      return reply.status(503).send({
        error: 'ServiceUnavailable',
        message: 'EVM clients not configured — emergency revert requires publicClient and walletClient',
        statusCode: 503,
      });
    }

    // 4. Resolve snapshot — DB first, then body fallback
    let snapshotTokens: string[];
    let snapshotWeights: string[];
    let snapshotSource: string;

    if (!bodySnapshot) {
      // Try to find the latest emergency snapshot from pipeline_runs
      const runs = await getActivePipelineRuns(db, id);
      const emergencyRun = runs
        .filter((r: any) => r.metadata && (r.metadata as any).type === 'emergency_snapshot')
        .sort((a: any, b: any) => {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bTime - aTime; // most recent first
        })[0];

      if (!emergencyRun) {
        return reply.status(404).send({
          error: 'SnapshotNotFound',
          message: `No emergency snapshot found for fund ${id} — provide snapshot in request body`,
          statusCode: 404,
        });
      }

      const meta = emergencyRun.metadata as any;
      snapshotTokens = meta.snapshot.tokens;
      snapshotWeights = meta.snapshot.weights;
      snapshotSource = 'database';

      log('emergencyRevertSnapshotFromDb', { fundId: id, pipelineRunId: emergencyRun.id });
    } else {
      snapshotTokens = bodySnapshot.tokens;
      snapshotWeights = bodySnapshot.weights;
      snapshotSource = 'request_body';

      log('emergencyRevertSnapshotFromBody', { fundId: id });
    }

    // 5. Execute emergency revert
    log('emergencyRevert', { fundId: id, dryRun: dryRun ?? false, snapshotSource });

    const result = await emergencyRevert({
      publicClient,
      walletClient,
      bsktAddress: fund.bsktAddress as Address,
      snapshot: {
        tokens: snapshotTokens as Address[],
        weights: snapshotWeights.map((w) => BigInt(w)),
      },
      amountIn,
      dryRun: dryRun ?? false,
    });

    // 6. Serialize and respond
    const serialized = serializeResult(result as unknown as Record<string, unknown>);

    log('emergencyRevertComplete', { fundId: id, txHash: result.txHash });

    return reply.status(200).send({
      ...serialized,
      snapshotSource,
    });
  });
};

export default emergencyRoutes;
