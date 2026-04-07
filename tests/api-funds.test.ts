/**
 * Integration tests for fund CRUD routes using fastify.inject().
 *
 * All fund-repository functions are mocked via vi.mock() — no real DB needed.
 * Tests cover: create happy path (201), create invalid body (400),
 * get by id (200), get not found (404), list (200), list with status filter (200).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ── Mock fund-repository ───────────────────────────────────────────────

const mockCreateFund = vi.fn();
const mockSetFundWallets = vi.fn();
const mockSetDivestmentConfig = vi.fn();
const mockLockDivestmentConfig = vi.fn();
const mockGetFundById = vi.fn();
const mockListFunds = vi.fn();
const mockGetFundWallets = vi.fn();
const mockGetDivestmentConfig = vi.fn();
const mockGetTransactionsByFund = vi.fn();

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
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const FUND_ID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-01-15T12:00:00Z');

const baseFund = {
  id: FUND_ID,
  name: 'Test Fund',
  tokenMint: 'So11111111111111111111111111111111111111112',
  creatorWallet: '0xabc123',
  status: 'created',
  targetChain: 'base',
  protocolFeeBps: 250,
  bsktAddress: null,
  accumulationThresholdLamports: '5000000000',
  lastPipelineRunAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const baseWallet = {
  id: '00000000-0000-4000-8000-000000000010',
  fundId: FUND_ID,
  chain: 'solana',
  address: 'TREAS111',
  walletType: 'treasury',
  createdAt: NOW,
};

const baseDivConfig = {
  id: '00000000-0000-4000-8000-000000000020',
  fundId: FUND_ID,
  holderSplitBps: 7000,
  ownerSplitBps: 3000,
  triggerType: 'time',
  triggerParams: { intervalDays: 30 },
  distributionCurrency: 'usdc',
  lockedAt: NOW,
  createdAt: NOW,
};

const createFundBody = {
  name: 'Test Fund',
  tokenMint: 'So11111111111111111111111111111111111111112',
  creatorWallet: '0xabc123',
  targetChain: 'base',
  protocolFeeBps: 250,
  wallets: [
    { chain: 'solana', address: 'TREAS111', walletType: 'treasury' },
    { chain: 'base', address: '0xdef456', walletType: 'operations' },
  ],
  divestmentConfig: {
    holderSplitBps: 7000,
    ownerSplitBps: 3000,
    triggerType: 'time',
    triggerParams: { intervalDays: 30 },
    distributionCurrency: 'usdc',
  },
};

// ── Test helpers ───────────────────────────────────────────────────────

let server: FastifyInstance;

async function buildServer() {
  // Import after vi.mock so mocks are active
  const { createServer } = await import('../src/api/server.js');
  const fakeDb = {} as any;
  server = await createServer({ db: fakeDb });
  await server.ready();
  return server;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Fund API routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── POST /funds ────────────────────────────────────────────────

  describe('POST /funds', () => {
    it('creates a fund with wallets and locked divestment config (201)', async () => {
      mockCreateFund.mockResolvedValue(baseFund);
      mockSetFundWallets.mockResolvedValue([
        baseWallet,
        { ...baseWallet, id: '00000000-0000-4000-8000-000000000011', chain: 'base', address: '0xdef456', walletType: 'operations' },
      ]);
      mockSetDivestmentConfig.mockResolvedValue({ ...baseDivConfig, lockedAt: null });
      mockLockDivestmentConfig.mockResolvedValue(baseDivConfig);

      const res = await server.inject({
        method: 'POST',
        url: '/funds',
        payload: createFundBody,
      });

      expect(res.statusCode).toBe(201);

      const body = res.json();
      expect(body.fund.id).toBe(FUND_ID);
      expect(body.fund.name).toBe('Test Fund');
      expect(body.wallets).toHaveLength(2);
      expect(body.divestmentConfig).toBeDefined();
      expect(body.divestmentConfig.lockedAt).toBeTruthy();

      // Verify call sequence: createFund → setFundWallets → setDivestmentConfig → lockDivestmentConfig
      expect(mockCreateFund).toHaveBeenCalledOnce();
      expect(mockSetFundWallets).toHaveBeenCalledOnce();
      expect(mockSetDivestmentConfig).toHaveBeenCalledOnce();
      expect(mockLockDivestmentConfig).toHaveBeenCalledOnce();

      // Verify fund was passed correct data
      expect(mockCreateFund.mock.calls[0][1]).toMatchObject({
        name: 'Test Fund',
        tokenMint: 'So11111111111111111111111111111111111111112',
        targetChain: 'base',
        protocolFeeBps: 250,
      });
    });

    it('rejects invalid body with 400', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/funds',
        payload: {
          // Missing required fields
          name: 'Incomplete Fund',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('ValidationError');
      expect(mockCreateFund).not.toHaveBeenCalled();
    });

    it('rejects empty body with 400', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/funds',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── GET /funds/:id ─────────────────────────────────────────────

  describe('GET /funds/:id', () => {
    it('returns fund detail with wallets, config, and transactions (200)', async () => {
      mockGetFundById.mockResolvedValue(baseFund);
      mockGetFundWallets.mockResolvedValue([baseWallet]);
      mockGetDivestmentConfig.mockResolvedValue(baseDivConfig);
      mockGetTransactionsByFund.mockResolvedValue([]);

      const res = await server.inject({
        method: 'GET',
        url: `/funds/${FUND_ID}`,
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.fund.id).toBe(FUND_ID);
      expect(body.wallets).toHaveLength(1);
      expect(body.divestmentConfig).toBeDefined();
      expect(body.recentTransactions).toEqual([]);
    });

    it('returns 404 for non-existent fund', async () => {
      const missingId = '00000000-0000-4000-8000-999999999999';
      mockGetFundById.mockResolvedValue(null);

      const res = await server.inject({
        method: 'GET',
        url: `/funds/${missingId}`,
      });

      expect(res.statusCode).toBe(404);

      const body = res.json();
      expect(body.error).toBe('FundNotFound');
    });
  });

  // ── GET /funds ─────────────────────────────────────────────────

  describe('GET /funds', () => {
    it('lists all funds (200)', async () => {
      mockListFunds.mockResolvedValue([baseFund, { ...baseFund, id: '00000000-0000-4000-8000-000000000002', name: 'Fund B' }]);

      const res = await server.inject({
        method: 'GET',
        url: '/funds',
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe(FUND_ID);
      expect(body[1].name).toBe('Fund B');
    });

    it('filters by status query param (200)', async () => {
      mockListFunds.mockResolvedValue([baseFund]);

      const res = await server.inject({
        method: 'GET',
        url: '/funds?status=created',
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body).toHaveLength(1);

      // Verify the filter was passed through
      expect(mockListFunds).toHaveBeenCalledWith(
        expect.anything(),
        { status: 'created' },
      );
    });
  });

  // ── GET /health ────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns ok with db: false when no pool is decorated', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.db).toBe(false);
    });
  });
});
