/**
 * JSON Schema definitions for rebalance API request/response.
 *
 * Token amounts are strings for bigint safety (K005 pattern).
 */

export const fundIdParamsSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const, format: 'uuid' },
  },
  required: ['id'],
} as const;

export const rebalanceBodySchema = {
  type: 'object' as const,
  properties: {
    newTokens: {
      type: 'array' as const,
      items: { type: 'string' as const, minLength: 1 },
      minItems: 1,
    },
    newWeights: {
      type: 'array' as const,
      items: { type: 'integer' as const, minimum: 0 },
      minItems: 1,
    },
    amountIn: {
      type: 'array' as const,
      items: { type: 'string' as const },
      minItems: 1,
    },
    mode: {
      type: 'integer' as const,
      minimum: 0,
      maximum: 2,
    },
    dryRun: { type: 'boolean' as const },
  },
  required: ['newTokens', 'newWeights', 'amountIn'],
  additionalProperties: false,
} as const;
