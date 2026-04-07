/**
 * Unit tests for the Bags FM client module.
 * All fetch calls are mocked — no real network requests.
 * SDK constructor is mocked — no real Solana connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  pingApi,
  createBagsClient,
  log,
  fetchWithTimeout,
  BAGS_API_BASE,
} from '../src/bags/client.js';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// -------------------------------------------------------------------
// Mock BagsSDK constructor — avoid real Solana connections
// -------------------------------------------------------------------

vi.mock('@bagsfm/bags-sdk', () => {
  return {
    BagsSDK: vi.fn().mockImplementation((apiKey: string) => ({
      _mockApiKey: apiKey,
      feeShareAdmin: {},
      fee: {},
    })),
  };
});

// -------------------------------------------------------------------
// Fetch mocking — same pattern as debridge-api.test.ts
// -------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

// -------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------

describe('BAGS_API_BASE constant', () => {
  it('points to bags public API v2', () => {
    expect(BAGS_API_BASE).toBe('https://public-api-v2.bags.fm/api/v1');
  });
});

// -------------------------------------------------------------------
// pingApi
// -------------------------------------------------------------------

describe('pingApi', () => {
  it('sends correct headers and returns parsed response', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse({ message: 'pong' })
    );

    const result = await pingApi('test-api-key-123');

    // Verify fetch was called with correct URL and headers
    expect(mocked()).toHaveBeenCalledOnce();
    const [url, init] = mocked().mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://public-api-v2.bags.fm/api/v1/ping');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      'test-api-key-123'
    );

    // Verify parsed response
    expect(result).toEqual({ message: 'pong' });
  });

  it('throws on timeout with context', async () => {
    // Simulate an abort error
    mocked().mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Listen for abort and reject with DOMException
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        })
    );

    // Use a tiny timeout to trigger abort quickly
    const promise = fetchWithTimeout(
      `${BAGS_API_BASE}/ping`,
      { method: 'GET', headers: { 'x-api-key': 'key' } },
      1 // 1ms timeout
    );

    await expect(promise).rejects.toThrow(/timed out/);
  });

  it('throws on non-200 response with status code in error', async () => {
    mocked().mockResolvedValueOnce(
      new Response('{"error":"Invalid API key"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(pingApi('bad-key')).rejects.toThrow(/HTTP 401/);
  });

  it('throws on response missing message field', async () => {
    mocked().mockResolvedValueOnce(
      mockResponse({ status: 'ok' }) // no 'message' field
    );

    await expect(pingApi('test-key')).rejects.toThrow(/missing 'message' field/);
  });

  it('throws on empty API key', async () => {
    await expect(pingApi('')).rejects.toThrow(/API key is required/);
  });

  it('throws on whitespace-only API key', async () => {
    await expect(pingApi('   ')).rejects.toThrow(/API key is required/);
  });
});

// -------------------------------------------------------------------
// createBagsClient
// -------------------------------------------------------------------

describe('createBagsClient', () => {
  it('returns an SDK instance with expected services', () => {
    const client = createBagsClient({ apiKey: 'test-key-abc' });

    // The mock returns an object with _mockApiKey, feeShareAdmin, fee
    expect(client).toBeDefined();
    expect((client as any)._mockApiKey).toBe('test-key-abc');
    expect(client.feeShareAdmin).toBeDefined();
    expect(client.fee).toBeDefined();
  });

  it('throws on missing API key', () => {
    expect(() => createBagsClient({ apiKey: '' })).toThrow(
      /API key is required/
    );
  });

  it('throws on whitespace-only API key', () => {
    expect(() => createBagsClient({ apiKey: '  ' })).toThrow(
      /API key is required/
    );
  });

  it('passes rpcUrl and commitment to connection factory', () => {
    // This won't throw — validates the config is accepted
    const client = createBagsClient({
      apiKey: 'test-key',
      rpcUrl: 'https://custom-rpc.example.com',
      commitment: 'finalized',
    });
    expect(client).toBeDefined();
  });
});

// -------------------------------------------------------------------
// log helper
// -------------------------------------------------------------------

describe('log', () => {
  it('outputs structured JSON with module=bags', () => {
    const spy = vi.spyOn(console, 'log');

    log('test-phase', 'test-action', { foo: 'bar' });

    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.module).toBe('bags');
    expect(parsed.phase).toBe('test-phase');
    expect(parsed.action).toBe('test-action');
    expect(parsed.foo).toBe('bar');
    expect(parsed.ts).toBeDefined();

    spy.mockRestore();
  });
});

// -------------------------------------------------------------------
// fetchWithTimeout
// -------------------------------------------------------------------

describe('fetchWithTimeout', () => {
  it('returns response on success', async () => {
    mocked().mockResolvedValueOnce(mockResponse({ ok: true }));

    const res = await fetchWithTimeout(
      'https://example.com/test',
      { method: 'GET' },
      5000
    );

    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toEqual({ ok: true });
  });

  it('throws with context on abort/timeout', async () => {
    mocked().mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        })
    );

    await expect(
      fetchWithTimeout('https://example.com/slow', { method: 'GET' }, 1)
    ).rejects.toThrow(/timed out after 1ms/);
  });
});
