/**
 * Unit tests for the Alvara backend API client.
 * All fetch calls are mocked — no real network requests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getContributeRoutes,
  getCreateBSKTRoutes,
  getRebalanceRoutes,
  getWithdrawETHRoutes,
  setApiBaseUrl,
  getApiBaseUrl,
} from '../src/alvara/api.js';
import {
  AlvaraApiError,
  AlvaraApiErrorCode,
  isHexString,
  validateSignedSwapData,
} from '../src/alvara/types.js';
import type {
  ContributeRoutesRequest,
  CreateBSKTRoutesRequest,
  RebalanceRoutesRequest,
  WithdrawETHRoutesRequest,
} from '../src/alvara/types.js';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  setApiBaseUrl('https://test-api.alvara.xyz');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setApiBaseUrl(null);
});

function mocked(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as ReturnType<typeof vi.fn>;
}

/** Build a mock Response */
function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A valid signed swap data response */
function validSwapDataResponse(overrides?: Record<string, unknown>) {
  return {
    swapData: ['0x07ed2379abcdef', '0x07ed2379fedcba'],
    signature: '0x5563db78aabbccdd' + 'ee'.repeat(28),
    deadline: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

/** Valid contribute request */
function validContributeRequest(overrides?: Partial<ContributeRoutesRequest>): ContributeRoutesRequest {
  return {
    bsktAddress: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
    amount: '1000000000000000', // 0.001 ETH
    chainId: 8453,
    userAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
    ...overrides,
  };
}

/** Valid createBSKT request */
function validCreateRequest(overrides?: Partial<CreateBSKTRoutesRequest>): CreateBSKTRoutesRequest {
  return {
    tokens: [
      '0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb' as `0x${string}`, // ALVA
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`, // USDC
    ],
    weights: [500, 9500],
    amount: '10000000000000', // 0.00001 ETH
    chainId: 8453,
    userAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
    name: 'Test Basket',
    symbol: 'TBSKT',
    ...overrides,
  };
}

/** Valid rebalance request */
function validRebalanceRequest(overrides?: Partial<RebalanceRoutesRequest>): RebalanceRoutesRequest {
  return {
    bsktAddress: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
    newTokens: [
      '0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb' as `0x${string}`,
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
    ],
    newWeights: [1000, 9000],
    amountIn: ['500000000000000000', '1000000'],
    chainId: 8453,
    userAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
    mode: 0,
    ...overrides,
  };
}

/** Valid withdrawETH request */
function validWithdrawRequest(overrides?: Partial<WithdrawETHRoutesRequest>): WithdrawETHRoutesRequest {
  return {
    bsktAddress: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
    liquidity: '1000000000000000000', // 1 LP token
    chainId: 8453,
    userAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as `0x${string}`,
    ...overrides,
  };
}

// -------------------------------------------------------------------
// isHexString utility
// -------------------------------------------------------------------

describe('isHexString', () => {
  it('accepts valid hex strings', () => {
    expect(isHexString('0x')).toBe(true);
    expect(isHexString('0xabcdef')).toBe(true);
    expect(isHexString('0x07ed2379')).toBe(true);
    expect(isHexString('0xABCDEF0123456789')).toBe(true);
  });

  it('rejects non-hex values', () => {
    expect(isHexString('abc')).toBe(false);
    expect(isHexString('')).toBe(false);
    expect(isHexString('0xGHIJ')).toBe(false);
    expect(isHexString(123)).toBe(false);
    expect(isHexString(null)).toBe(false);
    expect(isHexString(undefined)).toBe(false);
  });
});

// -------------------------------------------------------------------
// validateSignedSwapData
// -------------------------------------------------------------------

describe('validateSignedSwapData', () => {
  it('passes on valid data', () => {
    expect(() => validateSignedSwapData(validSwapDataResponse(), '/test')).not.toThrow();
  });

  it('throws on null', () => {
    expect(() => validateSignedSwapData(null, '/test')).toThrow(AlvaraApiError);
  });

  it('throws on non-array swapData', () => {
    expect(() =>
      validateSignedSwapData({ ...validSwapDataResponse(), swapData: 'not-array' }, '/test'),
    ).toThrow(/swapData must be an array/);
  });

  it('throws on non-hex swapData elements', () => {
    expect(() =>
      validateSignedSwapData({ ...validSwapDataResponse(), swapData: ['not-hex'] }, '/test'),
    ).toThrow(/swapData\[0\] must be a hex string/);
  });

  it('throws on non-hex signature', () => {
    expect(() =>
      validateSignedSwapData({ ...validSwapDataResponse(), signature: 'bad-sig' }, '/test'),
    ).toThrow(/signature must be a hex string/);
  });

  it('throws on non-integer deadline', () => {
    expect(() =>
      validateSignedSwapData({ ...validSwapDataResponse(), deadline: 123.5 }, '/test'),
    ).toThrow(/deadline must be a positive integer/);
  });

  it('throws on zero deadline', () => {
    expect(() =>
      validateSignedSwapData({ ...validSwapDataResponse(), deadline: 0 }, '/test'),
    ).toThrow(/deadline must be a positive integer/);
  });

  it('throws on negative deadline', () => {
    expect(() =>
      validateSignedSwapData({ ...validSwapDataResponse(), deadline: -1 }, '/test'),
    ).toThrow(/deadline must be a positive integer/);
  });
});

// -------------------------------------------------------------------
// API base URL configuration
// -------------------------------------------------------------------

describe('API base URL', () => {
  it('uses setApiBaseUrl when set', () => {
    setApiBaseUrl('https://custom.api.test');
    expect(getApiBaseUrl()).toBe('https://custom.api.test');
  });

  it('falls back to env var when programmatic override is null', () => {
    setApiBaseUrl(null);
    const envBefore = process.env.ALVARA_API_URL;
    process.env.ALVARA_API_URL = 'https://env.api.test';
    try {
      expect(getApiBaseUrl()).toBe('https://env.api.test');
    } finally {
      if (envBefore === undefined) delete process.env.ALVARA_API_URL;
      else process.env.ALVARA_API_URL = envBefore;
    }
  });

  it('falls back to default when no override and no env var', () => {
    setApiBaseUrl(null);
    const envBefore = process.env.ALVARA_API_URL;
    delete process.env.ALVARA_API_URL;
    try {
      expect(getApiBaseUrl()).toBe('https://api.alvara.xyz');
    } finally {
      if (envBefore !== undefined) process.env.ALVARA_API_URL = envBefore;
    }
  });
});

// -------------------------------------------------------------------
// getContributeRoutes
// -------------------------------------------------------------------

describe('getContributeRoutes', () => {
  it('sends correct POST request and returns validated response', async () => {
    const responseBody = validSwapDataResponse({ estimatedLP: '500000000000000000' });
    mocked().mockResolvedValueOnce(mockResponse(responseBody));

    const result = await getContributeRoutes(validContributeRequest());

    // Verify fetch was called correctly
    expect(mocked()).toHaveBeenCalledOnce();
    const [url, init] = mocked().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-api.alvara.xyz/contribute');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    // Verify request body
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.bsktAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(sentBody.amount).toBe('1000000000000000');
    expect(sentBody.chainId).toBe(8453);

    // Verify response
    expect(result.swapData).toHaveLength(2);
    expect(result.signature).toMatch(/^0x/);
    expect(result.deadline).toBeGreaterThan(0);
    expect(result.estimatedLP).toBe('500000000000000000');
  });

  it('throws on HTTP 400 with CLIENT_ERROR code', async () => {
    mocked().mockResolvedValueOnce(
      new Response('{"error":"Invalid BSKT address"}', { status: 400 }),
    );

    try {
      await getContributeRoutes(validContributeRequest());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      const apiErr = err as AlvaraApiError;
      expect(apiErr.code).toBe(AlvaraApiErrorCode.CLIENT_ERROR);
      expect(apiErr.statusCode).toBe(400);
      expect(apiErr.message).toMatch(/HTTP 400/);
    }
  });

  it('throws on HTTP 500 with SERVER_ERROR code', async () => {
    mocked().mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    try {
      await getContributeRoutes(validContributeRequest());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.SERVER_ERROR);
      expect((err as AlvaraApiError).statusCode).toBe(500);
    }
  });

  it('throws INVALID_RESPONSE on malformed JSON', async () => {
    mocked().mockResolvedValueOnce(
      new Response('not-json-at-all', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    try {
      await getContributeRoutes(validContributeRequest());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.INVALID_RESPONSE);
    }
  });

  it('throws INVALID_RESPONSE when swapData is missing', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse({ signature: '0xaabb', deadline: 12345 }),
    );

    try {
      await getContributeRoutes(validContributeRequest());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.INVALID_RESPONSE);
      expect((err as AlvaraApiError).message).toMatch(/swapData/);
    }
  });

  it('throws on timeout', async () => {
    mocked().mockImplementationOnce(() => {
      const controller = new AbortController();
      return new Promise((_resolve, reject) => {
        // Simulate the AbortError that fetch throws when signal fires
        const err = new DOMException('The operation was aborted.', 'AbortError');
        setTimeout(() => reject(err), 10);
      });
    });

    try {
      await getContributeRoutes(validContributeRequest());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      // Could be TIMEOUT or NETWORK_ERROR depending on how the mock propagates
      expect([AlvaraApiErrorCode.TIMEOUT, AlvaraApiErrorCode.NETWORK_ERROR]).toContain(
        (err as AlvaraApiError).code,
      );
    }
  });

  // --- Input validation ---

  it('throws VALIDATION_ERROR on invalid bsktAddress', async () => {
    try {
      await getContributeRoutes(validContributeRequest({ bsktAddress: 'bad' as `0x${string}` }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.VALIDATION_ERROR);
      expect((err as AlvaraApiError).message).toMatch(/bsktAddress/);
    }
  });

  it('throws VALIDATION_ERROR on zero amount', async () => {
    try {
      await getContributeRoutes(validContributeRequest({ amount: '0' }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.VALIDATION_ERROR);
      expect((err as AlvaraApiError).message).toMatch(/amount/);
    }
  });

  it('throws VALIDATION_ERROR on non-numeric amount', async () => {
    try {
      await getContributeRoutes(validContributeRequest({ amount: '1.5 ETH' }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.VALIDATION_ERROR);
      expect((err as AlvaraApiError).message).toMatch(/numeric string/);
    }
  });

  it('throws VALIDATION_ERROR on invalid userAddress', async () => {
    try {
      await getContributeRoutes(validContributeRequest({ userAddress: '0x123' as `0x${string}` }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.VALIDATION_ERROR);
      expect((err as AlvaraApiError).message).toMatch(/userAddress/);
    }
  });
});

// -------------------------------------------------------------------
// getCreateBSKTRoutes
// -------------------------------------------------------------------

describe('getCreateBSKTRoutes', () => {
  it('sends correct request and returns validated response', async () => {
    const responseBody = validSwapDataResponse({ basketId: 'bskt-42' });
    mocked().mockResolvedValueOnce(mockResponse(responseBody));

    const result = await getCreateBSKTRoutes(validCreateRequest());

    expect(mocked()).toHaveBeenCalledOnce();
    const [url, init] = mocked().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-api.alvara.xyz/create-bskt');

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.tokens).toHaveLength(2);
    expect(sentBody.weights).toEqual([500, 9500]);
    expect(sentBody.name).toBe('Test Basket');
    expect(sentBody.symbol).toBe('TBSKT');

    expect(result.swapData).toHaveLength(2);
    expect(result.basketId).toBe('bskt-42');
  });

  it('throws on empty tokens array', async () => {
    try {
      await getCreateBSKTRoutes(validCreateRequest({ tokens: [] }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.VALIDATION_ERROR);
      expect((err as AlvaraApiError).message).toMatch(/tokens.*must not be empty/);
    }
  });

  it('throws when tokens and weights have different lengths', async () => {
    try {
      await getCreateBSKTRoutes(
        validCreateRequest({
          tokens: ['0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb' as `0x${string}`],
          weights: [500, 9500],
        }),
      );
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).message).toMatch(/same length/);
    }
  });

  it('throws on invalid token address in array', async () => {
    try {
      await getCreateBSKTRoutes(
        validCreateRequest({
          tokens: ['0xbad' as `0x${string}`, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`],
        }),
      );
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).message).toMatch(/tokens\[\]/);
    }
  });

  it('throws on server error', async () => {
    mocked().mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));

    try {
      await getCreateBSKTRoutes(validCreateRequest());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.SERVER_ERROR);
    }
  });
});

// -------------------------------------------------------------------
// getRebalanceRoutes
// -------------------------------------------------------------------

describe('getRebalanceRoutes', () => {
  it('sends correct request and returns validated response', async () => {
    mocked().mockResolvedValueOnce(mockResponse(validSwapDataResponse()));

    const result = await getRebalanceRoutes(validRebalanceRequest());

    expect(mocked()).toHaveBeenCalledOnce();
    const [url, init] = mocked().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-api.alvara.xyz/rebalance');

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.newTokens).toHaveLength(2);
    expect(sentBody.newWeights).toEqual([1000, 9000]);
    expect(sentBody.mode).toBe(0);

    expect(result.swapData).toHaveLength(2);
    expect(result.signature).toMatch(/^0x/);
  });

  it('throws on empty newTokens array', async () => {
    try {
      await getRebalanceRoutes(validRebalanceRequest({ newTokens: [] }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).message).toMatch(/newTokens.*must not be empty/);
    }
  });

  it('throws when newTokens and newWeights mismatch', async () => {
    try {
      await getRebalanceRoutes(
        validRebalanceRequest({
          newTokens: ['0xCC68F95cf050E769D46d8d133Bf4193fCBb3f1Eb' as `0x${string}`],
          newWeights: [1000, 9000],
        }),
      );
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).message).toMatch(/same length/);
    }
  });

  it('throws on invalid bsktAddress', async () => {
    try {
      await getRebalanceRoutes(validRebalanceRequest({ bsktAddress: '0xshort' as `0x${string}` }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.VALIDATION_ERROR);
    }
  });
});

// -------------------------------------------------------------------
// getWithdrawETHRoutes
// -------------------------------------------------------------------

describe('getWithdrawETHRoutes', () => {
  it('sends correct request and returns validated response', async () => {
    const responseBody = validSwapDataResponse({ estimatedETH: '990000000000000' });
    mocked().mockResolvedValueOnce(mockResponse(responseBody));

    const result = await getWithdrawETHRoutes(validWithdrawRequest());

    expect(mocked()).toHaveBeenCalledOnce();
    const [url, init] = mocked().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-api.alvara.xyz/withdraw-eth');

    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.liquidity).toBe('1000000000000000000');

    expect(result.swapData).toHaveLength(2);
    expect(result.estimatedETH).toBe('990000000000000');
  });

  it('throws on zero liquidity', async () => {
    try {
      await getWithdrawETHRoutes(validWithdrawRequest({ liquidity: '0' }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.VALIDATION_ERROR);
      expect((err as AlvaraApiError).message).toMatch(/liquidity/);
    }
  });

  it('throws on invalid userAddress', async () => {
    try {
      await getWithdrawETHRoutes(validWithdrawRequest({ userAddress: '' as `0x${string}` }));
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.VALIDATION_ERROR);
    }
  });

  it('throws on HTTP 503 with SERVER_ERROR code', async () => {
    mocked().mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));

    try {
      await getWithdrawETHRoutes(validWithdrawRequest());
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlvaraApiError);
      expect((err as AlvaraApiError).code).toBe(AlvaraApiErrorCode.SERVER_ERROR);
      expect((err as AlvaraApiError).statusCode).toBe(503);
    }
  });
});

// -------------------------------------------------------------------
// AlvaraApiError structure
// -------------------------------------------------------------------

describe('AlvaraApiError', () => {
  it('has correct name and properties', () => {
    const err = new AlvaraApiError(
      'test error',
      AlvaraApiErrorCode.CLIENT_ERROR,
      { statusCode: 422, responseBody: '{"error":"bad"}', endpoint: '/test' },
    );

    expect(err.name).toBe('AlvaraApiError');
    expect(err.message).toBe('test error');
    expect(err.code).toBe(AlvaraApiErrorCode.CLIENT_ERROR);
    expect(err.statusCode).toBe(422);
    expect(err.responseBody).toBe('{"error":"bad"}');
    expect(err.endpoint).toBe('/test');
    expect(err instanceof Error).toBe(true);
  });
});
