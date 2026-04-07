/**
 * Integration tests for emergency stables/revert routes using fastify.inject().
 *
 * Mocks: fund-repository AND alvara/emergency modules.
 * Tests cover: emergency stables happy path (200), emergency revert with DB snapshot (200),
 * emergency revert with body snapshot (200), fund not found (404), Alvara API error (502),
 * dry run (200), no EVM clients (503), no snapshot found (404).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ── Mock fund-repository ───────────────────────────────────────────────

const mockGetFundById = vi.fn();
const mockCreateFund = vi.fn();
const mockSetFundWallets = vi.fn();
const mockSetDivestmentConfig = vi.fn();
const mockLockDivestmentConfig = vi.fn();
const mockListFunds = vi.fn();
const mockGetFundWallets = vi.fn();
const mockGetDivestmentConfig = vi.fn();
const mockGetTransactionsByFund = vi.fn();
const mockCreatePipelineRun = vi.fn();
const mockUpdatePipelineRun = vi.fn();
const mockGetActivePipelineRuns = vi.fn();
const mockGetPipelineRunById = vi.fn();

vi.mock('../src/db/fund-repository.js', () => ({
  createFund: (...args: unknown[]) => mockCreateFund(...args),
  setFundWallets: (...args: unknown[]) => mockSetFundWallets(...args),
  setDivestmentConfig: (...args: unknown[]) => mockSetDivestmentConfig(...args),
  lockDivestmentConfig: (...args: unknown[]) => mockLockDivestmentConfig(...args),
  getFundById: (...args: unknown[]) => mockGetFundById(...args),
  listFunds: (...args: unknown[]) => mockListFunds(...args),
  getFundWallets: (...args: unknown[]) => mockGetFundWallets(...args),
  getDivestmentConfig: (...args: unknown[]) => mockGetDivestmentConfig(...args),
  getTransactionsByFund: (...args: unknown[]) => mockGetTransactionsByFund(...args),
  createPipelineRun: (...args: unknown[]) => mockCreatePipelineRun(...args),
  updatePipelineRun: (...args: unknown[]) => mockUpdatePipelineRun(...args),
  getActivePipelineRuns: (...args: unknown[]) => mockGetActivePipelineRuns(...args),
  getPipelineRunById: (...args: unknown[]) => mockGetPipelineRunById(...args),
}));

// ── Mock alvara/rebalance (needed since server imports rebalance routes) ─

vi.mock('../src/alvara/rebalance.js', () => ({
  rebalanceBSKT: vi.fn(),
  RebalanceMode: { STANDARD: 0, EMERGENCY_STABLES: 1, REVERT_EMERGENCY: 2 },
}));

// ── Mock alvara/emergency ──────────────────────────────────────────────

const mockEmergencyStables = vi.fn();
const mockEmergencyRevert = vi.fn();

vi.mock('../src/alvara/emergency.js', () => ({
  emergencyStables: (...args: unknown[]) => mockEmergencyStables(...args),
  emergencyRevert: (...args: unknown[]) => mockEmergencyRevert(...args),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const FUND_ID = '00000000-0000-4000-8000-000000000001';
const BSKT_ADDR = '0x9ee08080206e6e97c3dd22a53e2b1a1a3e05e895';
const PIPELINE_RUN_ID = '00000000-0000-4000-8000-000000000099';

const fundWithBskt = {
  id: FUND_ID,
  name: 'Test Fund',
  tokenMint: 'So11111111111111111111111111111111111111112',
  creatorWallet: '0xabc123',
  status: 'active',
  targetChain: 'base',
  protocolFeeBps: 250,
  bsktAddress: BSKT_ADDR,
  accumulationThresholdLamports: '5000000000',
  lastPipelineRunAt: null,
  createdAt: new Date('2026-01-15T12:00:00Z'),
  updatedAt: new Date('2026-01-15T12:00:00Z'),
};

const mockEmergencyStablesResult = {
  snapshot: {
    tokens: ['0xTokenA', '0xTokenB'] as `0x${string}`[],
    weights: [5000n, 5000n],
  },
  rebalanceResult: {
    txHash: '0xemergency123',
    receipt: null,
    oldTokens: ['0xTokenA', '0xTokenB'],
    oldWeights: [5000n, 5000n],
    newTokens: ['0xUSDT', '0xALVA'],
    newWeights: [9500, 500],
    gasUsed: 200000n,
    gasEstimate: 180000n,
    event: null,
    lpBalanceBefore: 100n,
    lpBalanceAfter: 100n,
    routeData: { swapDataCount: 2, deadline: 1700000000 },
  },
};

const mockRevertResult = {
  txHash: '0xrevert456',
  receipt: null,
  oldTokens: ['0xUSDT', '0xALVA'],
  oldWeights: [9500n, 500n],
  newTokens: ['0xTokenA', '0xTokenB'],
  newWeights: [5000, 5000],
  gasUsed: 180000n,
  gasEstimate: 170000n,
  event: null,
  lpBalanceBefore: 100n,
  lpBalanceAfter: 100n,
  routeData: { swapDataCount: 2, deadline: 1700000000 },
};

const dbPipelineRun = {
  id: PIPELINE_RUN_ID,
  fundId: FUND_ID,
  direction: 'outbound',
  phase: 'investing',
  status: 'running',
  metadata: {
    type: 'emergency_snapshot',
    snapshot: {
      tokens: ['0xTokenA', '0xTokenB'],
      weights: ['5000', '5000'],
    },
  },
  createdAt: new Date('2026-01-15T12:00:00Z'),
};

// ── Test helpers ───────────────────────────────────────────────────────

let server: FastifyInstance;

async function buildServer(opts?: { withClients?: boolean }) {
  const { createServer } = await import('../src/api/server.js');
  const deps: any = { db: {} };
  if (opts?.withClients !== false) {
    deps.publicClient = { estimateGas: vi.fn() };
    deps.walletClient = { account: { address: '0xuser' } };
  }
  server = await createServer(deps);
  await server.ready();
  return server;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Emergency API routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── POST /funds/:id/emergency ─────────────────────────────────

  describe('POST /funds/:id/emergency', () => {
    it('returns 200 with emergency stables result and persists snapshot', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);
      mockEmergencyStables.mockResolvedValue(mockEmergencyStablesResult);
      mockCreatePipelineRun.mockResolvedValue({ id: PIPELINE_RUN_ID, fundId: FUND_ID });

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.pipelineRunId).toBe(PIPELINE_RUN_ID);
      expect(body.snapshot.tokens).toEqual(['0xTokenA', '0xTokenB']);
      expect(body.snapshot.weights).toEqual(['5000', '5000']);

      // Verify snapshot was persisted
      expect(mockCreatePipelineRun).toHaveBeenCalledOnce();
      const pipelineArg = mockCreatePipelineRun.mock.calls[0][1];
      expect(pipelineArg.fundId).toBe(FUND_ID);
      expect(pipelineArg.metadata.type).toBe('emergency_snapshot');
      expect(pipelineArg.metadata.snapshot.tokens).toEqual(['0xTokenA', '0xTokenB']);
    });

    it('returns 404 when fund does not exist', async () => {
      mockGetFundById.mockResolvedValue(null);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency`,
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('FundNotFound');
      expect(mockEmergencyStables).not.toHaveBeenCalled();
    });

    it('returns 502 when emergencyStables throws AlvaraApiError', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);

      const alvaraError = new Error('Backend emergency route failed');
      alvaraError.name = 'AlvaraApiError';
      (alvaraError as any).code = 'SERVER_ERROR';
      (alvaraError as any).endpoint = '/rebalance-routes';
      mockEmergencyStables.mockRejectedValue(alvaraError);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency`,
        payload: {},
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('AlvaraApiError');
    });

    it('returns 200 with dry run (no snapshot persisted)', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);
      mockEmergencyStables.mockResolvedValue({
        ...mockEmergencyStablesResult,
        rebalanceResult: {
          ...mockEmergencyStablesResult.rebalanceResult,
          txHash: null,
          gasUsed: 0n,
        },
      });

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency`,
        payload: { dryRun: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.pipelineRunId).toBeNull();
      // No pipeline run should be created for dry run
      expect(mockCreatePipelineRun).not.toHaveBeenCalled();
    });

    it('returns 503 when EVM clients are not configured', async () => {
      await server.close();
      server = await buildServer({ withClients: false });

      mockGetFundById.mockResolvedValue(fundWithBskt);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency`,
        payload: {},
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('ServiceUnavailable');
    });
  });

  // ── POST /funds/:id/emergency/revert ──────────────────────────

  describe('POST /funds/:id/emergency/revert', () => {
    it('returns 200 with revert result using DB snapshot', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);
      mockGetActivePipelineRuns.mockResolvedValue([dbPipelineRun]);
      mockEmergencyRevert.mockResolvedValue(mockRevertResult);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency/revert`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.txHash).toBe('0xrevert456');
      expect(body.snapshotSource).toBe('database');

      // Verify emergencyRevert was called with DB snapshot
      const callOpts = mockEmergencyRevert.mock.calls[0][0];
      expect(callOpts.snapshot.tokens).toEqual(['0xTokenA', '0xTokenB']);
      expect(callOpts.snapshot.weights).toEqual([5000n, 5000n]);
    });

    it('returns 200 with revert result using body snapshot', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);
      mockEmergencyRevert.mockResolvedValue(mockRevertResult);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency/revert`,
        payload: {
          snapshot: {
            tokens: ['0xTokenC', '0xTokenD'],
            weights: ['6000', '4000'],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.snapshotSource).toBe('request_body');

      // Verify emergencyRevert was called with body snapshot
      const callOpts = mockEmergencyRevert.mock.calls[0][0];
      expect(callOpts.snapshot.tokens).toEqual(['0xTokenC', '0xTokenD']);
      expect(callOpts.snapshot.weights).toEqual([6000n, 4000n]);
    });

    it('returns 404 when fund does not exist', async () => {
      mockGetFundById.mockResolvedValue(null);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency/revert`,
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('FundNotFound');
    });

    it('returns 404 when no DB snapshot found and no body snapshot', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);
      mockGetActivePipelineRuns.mockResolvedValue([]);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency/revert`,
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('SnapshotNotFound');
    });

    it('returns 502 when emergencyRevert throws AlvaraApiError', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);

      const alvaraError = new Error('Backend revert route failed');
      alvaraError.name = 'AlvaraApiError';
      (alvaraError as any).code = 'SERVER_ERROR';
      (alvaraError as any).endpoint = '/rebalance-routes';
      mockEmergencyRevert.mockRejectedValue(alvaraError);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency/revert`,
        payload: {
          snapshot: {
            tokens: ['0xTokenA'],
            weights: ['10000'],
          },
        },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('AlvaraApiError');
    });

    it('returns 200 with dry run for revert', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);
      mockEmergencyRevert.mockResolvedValue({
        ...mockRevertResult,
        txHash: null,
        gasUsed: 0n,
      });

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/emergency/revert`,
        payload: {
          snapshot: {
            tokens: ['0xTokenA', '0xTokenB'],
            weights: ['5000', '5000'],
          },
          dryRun: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.txHash).toBeNull();

      const callOpts = mockEmergencyRevert.mock.calls[0][0];
      expect(callOpts.dryRun).toBe(true);
    });
  });
});
