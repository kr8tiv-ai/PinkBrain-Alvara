/**
 * JSON Schema definitions for fund API request/response bodies.
 *
 * Fastify v5 requires full JSON Schema objects (type + properties), not shorthand.
 * Token amounts remain strings for bigint safety (K005/D028 pattern).
 */

// ── Shared schema fragments ────────────────────────────────────────────

const walletSchema = {
  type: 'object' as const,
  properties: {
    chain: { type: 'string' as const },
    address: { type: 'string' as const },
    walletType: { type: 'string' as const },
  },
  required: ['chain', 'address', 'walletType'],
};

const divestmentConfigSchema = {
  type: 'object' as const,
  properties: {
    holderSplitBps: { type: 'integer' as const },
    ownerSplitBps: { type: 'integer' as const },
    triggerType: { type: 'string' as const, enum: ['time', 'threshold', 'both'] },
    triggerParams: { type: 'object' as const },
    distributionCurrency: { type: 'string' as const, enum: ['usdc', 'sol'] },
  },
  required: [
    'holderSplitBps',
    'ownerSplitBps',
    'triggerType',
    'triggerParams',
    'distributionCurrency',
  ],
};

// ── Request schemas ────────────────────────────────────────────────────

export const createFundBodySchema = {
  type: 'object' as const,
  properties: {
    name: { type: 'string' as const, minLength: 1 },
    tokenMint: { type: 'string' as const, minLength: 1 },
    creatorWallet: { type: 'string' as const, minLength: 1 },
    targetChain: { type: 'string' as const, enum: ['base', 'solana'] },
    protocolFeeBps: { type: 'integer' as const, minimum: 0, maximum: 10000 },
    accumulationThresholdLamports: { type: 'string' as const },
    wallets: {
      type: 'array' as const,
      items: walletSchema,
      minItems: 1,
    },
    divestmentConfig: divestmentConfigSchema,
  },
  required: [
    'name',
    'tokenMint',
    'creatorWallet',
    'targetChain',
    'protocolFeeBps',
    'wallets',
    'divestmentConfig',
  ],
  additionalProperties: false,
} as const;

export const listFundsQuerySchema = {
  type: 'object' as const,
  properties: {
    status: {
      type: 'string' as const,
      enum: [
        'created',
        'configuring',
        'active',
        'divesting',
        'distributing',
        'completed',
        'paused',
        'failed',
      ],
    },
  },
  additionalProperties: false,
} as const;

export const fundParamsSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const, format: 'uuid' },
  },
  required: ['id'],
} as const;

// ── Response schemas ───────────────────────────────────────────────────

export const fundResponseSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    name: { type: 'string' as const },
    tokenMint: { type: 'string' as const },
    creatorWallet: { type: 'string' as const },
    status: { type: 'string' as const },
    targetChain: { type: 'string' as const },
    protocolFeeBps: { type: 'integer' as const },
    bsktAddress: { type: 'string' as const, nullable: true },
    accumulationThresholdLamports: { type: 'string' as const },
    lastPipelineRunAt: { type: 'string' as const, nullable: true },
    createdAt: { type: 'string' as const, nullable: true },
    updatedAt: { type: 'string' as const, nullable: true },
  },
};

export const fundDetailResponseSchema = {
  type: 'object' as const,
  properties: {
    fund: fundResponseSchema,
    wallets: { type: 'array' as const, items: walletSchema },
    divestmentConfig: {
      type: 'object' as const,
      nullable: true,
    },
    recentTransactions: { type: 'array' as const },
  },
};

export const errorResponseSchema = {
  type: 'object' as const,
  properties: {
    error: { type: 'string' as const },
    message: { type: 'string' as const },
    statusCode: { type: 'integer' as const },
  },
};
