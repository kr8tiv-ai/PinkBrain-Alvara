/**
 * Unit tests for the Solana transaction preparation module.
 *
 * Tests hex utilities (stripHexPrefix, validateHexString) and validation logic.
 * RPC-dependent behavior (blockhash refresh, simulation, send) requires mocked Connection
 * or integration tests — covered by the bridge script in T03.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  stripHexPrefix,
  validateHexString,
  DEFAULT_COMPUTE_UNITS,
} from '../src/debridge/solana-tx.js';

// Suppress structured log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});

// -------------------------------------------------------------------
// stripHexPrefix
// -------------------------------------------------------------------

describe('stripHexPrefix', () => {
  it('strips 0x prefix from hex string', () => {
    expect(stripHexPrefix('0xabcdef')).toBe('abcdef');
  });

  it('strips 0X (uppercase) prefix from hex string', () => {
    expect(stripHexPrefix('0Xabcdef')).toBe('abcdef');
  });

  it('passes through string without prefix unchanged', () => {
    expect(stripHexPrefix('abcdef')).toBe('abcdef');
  });

  it('handles empty string', () => {
    expect(stripHexPrefix('')).toBe('');
  });

  it('does not strip from middle of string', () => {
    expect(stripHexPrefix('abc0xdef')).toBe('abc0xdef');
  });

  it('strips prefix leaving empty string for bare 0x', () => {
    expect(stripHexPrefix('0x')).toBe('');
  });
});

// -------------------------------------------------------------------
// validateHexString
// -------------------------------------------------------------------

describe('validateHexString', () => {
  it('accepts valid even-length hex strings', () => {
    expect(() => validateHexString('abcdef')).not.toThrow();
    expect(() => validateHexString('0123456789abcdefABCDEF')).not.toThrow();
    expect(() => validateHexString('aa')).not.toThrow();
  });

  it('throws on empty string', () => {
    expect(() => validateHexString('')).toThrow(/empty/);
  });

  it('throws on odd-length hex', () => {
    expect(() => validateHexString('abc')).toThrow(/odd length/);
  });

  it('throws on non-hex characters', () => {
    expect(() => validateHexString('ghij')).toThrow(/non-hex/);
    expect(() => validateHexString('zzzz')).toThrow(/non-hex/);
  });

  it('throws on spaces', () => {
    expect(() => validateHexString('ab  cd')).toThrow(/non-hex/);
  });

  it('throws on special characters', () => {
    expect(() => validateHexString('ab!@')).toThrow(/non-hex/);
  });

  it('includes length in odd-length error message', () => {
    expect(() => validateHexString('abc')).toThrow('3');
  });
});

// -------------------------------------------------------------------
// DEFAULT_COMPUTE_UNITS
// -------------------------------------------------------------------

describe('DEFAULT_COMPUTE_UNITS', () => {
  it('is 200000', () => {
    expect(DEFAULT_COMPUTE_UNITS).toBe(200_000);
  });
});

// -------------------------------------------------------------------
// Integration edge cases (no RPC needed)
// -------------------------------------------------------------------

describe('hex pipeline (stripHexPrefix → validateHexString)', () => {
  it('correctly processes 0x-prefixed hex through both functions', () => {
    const raw = '0xaabbccdd';
    const stripped = stripHexPrefix(raw);
    expect(() => validateHexString(stripped)).not.toThrow();
    expect(stripped).toBe('aabbccdd');
  });

  it('rejects 0x-prefixed non-hex gracefully', () => {
    const raw = '0xnothex!!';
    const stripped = stripHexPrefix(raw);
    expect(() => validateHexString(stripped)).toThrow(/non-hex/);
  });

  it('rejects bare 0x prefix (empty after strip)', () => {
    const raw = '0x';
    const stripped = stripHexPrefix(raw);
    expect(() => validateHexString(stripped)).toThrow(/empty/);
  });
});
