/**
 * Integration tests for rebalance routes using fastify.inject().
 *
 * Mocks: fund-repository (getFundById) and alvara/rebalance (rebalanceBSKT).
 * Tests cover: happy path (200), fund not found (404), fund without bsktAddress (409),
 * invalid body (400), Alvara API error (502), dry run (200), no EVM clients (503).
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

// ── Mock alvara/rebalance ──────────────────────────────────────────────

const mockRebalanceBSKT = vi.fn();

vi.mock('../src/alvara/rebalance.js', () => ({
  rebalanceBSKT: (...args: unknown[]) => mockRebalanceBSKT(...args),
  RebalanceMode: { STANDARD: 0, EMERGENCY_STABLES: 1, REVERT_EMERGENCY: 2 },
}));

// ── Mock alvara/emergency (needed since server imports it via routes) ──

vi.mock('../src/alvara/emergency.js', () => ({
  emergencyStables: vi.fn(),
  emergencyRevert: vi.fn(),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const FUND_ID = '00000000-0000-4000-8000-000000000001';
const BSKT_ADDR = '0x9ee08080206e6e97c3dd22a53e2b1a1a3e05e895';

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

const fundWithoutBskt = {
  ...fundWithBskt,
  bsktAddress: null,
};

const validRebalanceBody = {
  newTokens: ['0xTokenA', '0xTokenB'],
  newWeights: [7000, 3000],
  amountIn: ['1000000', '500000'],
};

const mockRebalanceResult = {
  txHash: '0xabc123',
  receipt: null,
  oldTokens: ['0xOldA', '0xOldB'],
  oldWeights: [5000n, 5000n],
  newTokens: ['0xTokenA', '0xTokenB'],
  newWeights: [7000, 3000],
  gasUsed: 150000n,
  gasEstimate: 140000n,
  event: null,
  lpBalanceBefore: 100n,
  lpBalanceAfter: 100n,
  routeData: { swapDataCount: 2, deadline: 1700000000 },
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

describe('Rebalance API routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('POST /funds/:id/rebalance', () => {
    it('returns 200 with rebalance result on happy path', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);
      mockRebalanceBSKT.mockResolvedValue(mockRebalanceResult);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/rebalance`,
        payload: validRebalanceBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.txHash).toBe('0xabc123');
      // bigints should be serialized to strings
      expect(body.gasUsed).toBe('150000');
      expect(body.gasEstimate).toBe('140000');
      expect(body.oldWeights).toEqual(['5000', '5000']);

      expect(mockRebalanceBSKT).toHaveBeenCalledOnce();
      const callOpts = mockRebalanceBSKT.mock.calls[0][0];
      expect(callOpts.bsktAddress).toBe(BSKT_ADDR);
      expect(callOpts.newTokens).toEqual(['0xTokenA', '0xTokenB']);
      expect(callOpts.newWeights).toEqual([7000, 3000]);
    });

    it('returns 404 when fund does not exist', async () => {
      mockGetFundById.mockResolvedValue(null);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/rebalance`,
        payload: validRebalanceBody,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('FundNotFound');
      expect(mockRebalanceBSKT).not.toHaveBeenCalled();
    });

    it('returns 409 when fund has no bsktAddress', async () => {
      mockGetFundById.mockResolvedValue(fundWithoutBskt);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/rebalance`,
        payload: validRebalanceBody,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('NoBsktAddress');
      expect(mockRebalanceBSKT).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid body (missing required fields)', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/rebalance`,
        payload: { newTokens: ['0xA'] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('ValidationError');
    });

    it('returns 502 when rebalanceBSKT throws AlvaraApiError', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);

      const alvaraError = new Error('Backend swap route failed');
      alvaraError.name = 'AlvaraApiError';
      (alvaraError as any).code = 'SERVER_ERROR';
      (alvaraError as any).endpoint = '/rebalance-routes';
      mockRebalanceBSKT.mockRejectedValue(alvaraError);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/rebalance`,
        payload: validRebalanceBody,
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('AlvaraApiError');
    });

    it('returns 200 with dry run result (txHash null)', async () => {
      mockGetFundById.mockResolvedValue(fundWithBskt);
      mockRebalanceBSKT.mockResolvedValue({
        ...mockRebalanceResult,
        txHash: null,
        receipt: null,
        gasUsed: 0n,
      });

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/rebalance`,
        payload: { ...validRebalanceBody, dryRun: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.txHash).toBeNull();
      expect(body.gasUsed).toBe('0');

      const callOpts = mockRebalanceBSKT.mock.calls[0][0];
      expect(callOpts.dryRun).toBe(true);
    });

    it('returns 503 when EVM clients are not configured', async () => {
      await server.close();
      server = await buildServer({ withClients: false });

      mockGetFundById.mockResolvedValue(fundWithBskt);

      const res = await server.inject({
        method: 'POST',
        url: `/funds/${FUND_ID}/rebalance`,
        payload: validRebalanceBody,
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('ServiceUnavailable');
    });
  });
});
