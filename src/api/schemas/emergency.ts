/**
 * JSON Schema definitions for emergency stables/revert API request/response.
 *
 * Token amounts are strings for bigint safety (K005 pattern).
 */

export const emergencyBodySchema = {
  type: 'object' as const,
  properties: {
    amountIn: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    dryRun: { type: 'boolean' as const },
  },
  additionalProperties: false,
} as const;

export const emergencyRevertBodySchema = {
  type: 'object' as const,
  properties: {
    snapshot: {
      type: 'object' as const,
      properties: {
        tokens: {
          type: 'array' as const,
          items: { type: 'string' as const },
          minItems: 1,
        },
        weights: {
          type: 'array' as const,
          items: { type: 'string' as const },
          minItems: 1,
        },
      },
      required: ['tokens', 'weights'],
    },
    amountIn: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    dryRun: { type: 'boolean' as const },
  },
  additionalProperties: false,
} as const;
