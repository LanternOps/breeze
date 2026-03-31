import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asNullableRecord,
  asRecord,
  buildRecoveryDownloadDescriptor,
  computeRecoveryDownloadExpiry,
  generateRecoveryToken,
  getStringValue,
  hashRecoveryToken,
  RECOVERY_DOWNLOAD_SESSION_TTL_MS,
  resolveServerUrl,
  toIsoString,
} from './recoveryBootstrap';

// ── hashRecoveryToken ────────────────────────────────────────────────────────

describe('hashRecoveryToken', () => {
  it('returns a 64-char hex SHA-256 digest', () => {
    const hash = hashRecoveryToken('brz_rec_abc123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces consistent output for the same input', () => {
    const a = hashRecoveryToken('same-input');
    const b = hashRecoveryToken('same-input');
    expect(a).toBe(b);
  });

  it('produces different output for different inputs', () => {
    const a = hashRecoveryToken('input-a');
    const b = hashRecoveryToken('input-b');
    expect(a).not.toBe(b);
  });
});

// ── generateRecoveryToken ────────────────────────────────────────────────────

describe('generateRecoveryToken', () => {
  it('starts with the brz_rec_ prefix', () => {
    const token = generateRecoveryToken();
    expect(token.startsWith('brz_rec_')).toBe(true);
  });

  it('has sufficient length (prefix + 64 hex chars)', () => {
    const token = generateRecoveryToken();
    // 'brz_rec_' = 8 chars, 32 bytes hex = 64 chars → total >= 72
    expect(token.length).toBeGreaterThanOrEqual(72);
  });

  it('generates unique tokens on successive calls', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateRecoveryToken()));
    expect(tokens.size).toBe(20);
  });
});

// ── computeRecoveryDownloadExpiry ────────────────────────────────────────────

describe('computeRecoveryDownloadExpiry', () => {
  it('returns null when authenticatedAt is null', () => {
    expect(computeRecoveryDownloadExpiry(null, new Date())).toBeNull();
  });

  it('returns null when tokenExpiresAt is null', () => {
    expect(computeRecoveryDownloadExpiry(new Date(), null)).toBeNull();
  });

  it('returns null when both are null', () => {
    expect(computeRecoveryDownloadExpiry(null, null)).toBeNull();
  });

  it('returns null when authenticatedAt is undefined', () => {
    expect(computeRecoveryDownloadExpiry(undefined, new Date())).toBeNull();
  });

  it('returns null for invalid date strings', () => {
    expect(computeRecoveryDownloadExpiry('not-a-date', new Date().toISOString())).toBeNull();
    expect(computeRecoveryDownloadExpiry(new Date().toISOString(), 'also-not-a-date')).toBeNull();
  });

  it('clamps expiry to token expiry when session TTL exceeds it', () => {
    const authenticated = new Date('2026-03-01T00:00:00Z');
    // Token expires 30 minutes after auth — less than the 1-hour session TTL
    const tokenExpiry = new Date('2026-03-01T00:30:00Z');

    const result = computeRecoveryDownloadExpiry(authenticated, tokenExpiry);
    expect(result).toEqual(tokenExpiry);
  });

  it('clamps expiry to session TTL when token expiry exceeds it', () => {
    const authenticated = new Date('2026-03-01T00:00:00Z');
    // Token expires 24 hours after auth — far exceeds the 1-hour session TTL
    const tokenExpiry = new Date('2026-03-02T00:00:00Z');

    const result = computeRecoveryDownloadExpiry(authenticated, tokenExpiry);
    expect(result).toEqual(new Date(authenticated.getTime() + RECOVERY_DOWNLOAD_SESSION_TTL_MS));
  });

  it('accepts ISO string inputs', () => {
    const authenticated = '2026-03-01T00:00:00Z';
    const tokenExpiry = '2026-03-02T00:00:00Z';

    const result = computeRecoveryDownloadExpiry(authenticated, tokenExpiry);
    expect(result).toBeInstanceOf(Date);
    expect(result).toEqual(
      new Date(new Date(authenticated).getTime() + RECOVERY_DOWNLOAD_SESSION_TTL_MS)
    );
  });
});

// ── resolveServerUrl ─────────────────────────────────────────────────────────

describe('resolveServerUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BREEZE_SERVER;
    delete process.env.PUBLIC_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses BREEZE_SERVER when set', () => {
    process.env.BREEZE_SERVER = 'https://breeze.example.com';
    expect(resolveServerUrl()).toBe('https://breeze.example.com');
  });

  it('falls back to PUBLIC_API_URL when BREEZE_SERVER is not set', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    expect(resolveServerUrl()).toBe('https://api.example.com');
  });

  it('falls back to request URL origin when env vars are not set', () => {
    expect(resolveServerUrl('https://my-server.example.com/api/v1/backup')).toBe(
      'https://my-server.example.com'
    );
  });

  it('falls back to localhost when nothing else is available', () => {
    expect(resolveServerUrl()).toBe('http://localhost:3001');
  });

  it('strips trailing slashes', () => {
    process.env.BREEZE_SERVER = 'https://breeze.example.com///';
    expect(resolveServerUrl()).toBe('https://breeze.example.com');
  });

  it('prefers BREEZE_SERVER over PUBLIC_API_URL', () => {
    process.env.BREEZE_SERVER = 'https://primary.example.com';
    process.env.PUBLIC_API_URL = 'https://fallback.example.com';
    expect(resolveServerUrl()).toBe('https://primary.example.com');
  });
});

// ── asRecord ─────────────────────────────────────────────────────────────────

describe('asRecord', () => {
  it('returns a shallow copy of a plain object', () => {
    const original = { a: 1, b: 'two' };
    const result = asRecord(original);
    expect(result).toEqual(original);
    expect(result).not.toBe(original); // must be a copy
  });

  it('returns empty object for null', () => {
    expect(asRecord(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(asRecord(undefined)).toEqual({});
  });

  it('returns empty object for arrays', () => {
    expect(asRecord([1, 2, 3])).toEqual({});
  });

  it('returns empty object for primitive values', () => {
    expect(asRecord(42)).toEqual({});
    expect(asRecord('string')).toEqual({});
    expect(asRecord(true)).toEqual({});
  });
});

// ── asNullableRecord ─────────────────────────────────────────────────────────

describe('asNullableRecord', () => {
  it('returns a shallow copy of a plain object', () => {
    const original = { x: 'hello' };
    const result = asNullableRecord(original);
    expect(result).toEqual(original);
    expect(result).not.toBe(original); // must be a copy
  });

  it('returns null for null', () => {
    expect(asNullableRecord(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(asNullableRecord(undefined)).toBeNull();
  });

  it('returns null for arrays', () => {
    expect(asNullableRecord([1])).toBeNull();
  });

  it('returns null for primitive values', () => {
    expect(asNullableRecord(0)).toBeNull();
    expect(asNullableRecord('')).toBeNull();
  });
});

// ── getStringValue ───────────────────────────────────────────────────────────

describe('getStringValue', () => {
  it('returns the value when it is a non-empty string', () => {
    expect(getStringValue({ key: 'value' }, 'key')).toBe('value');
  });

  it('returns null for empty string', () => {
    expect(getStringValue({ key: '' }, 'key')).toBeNull();
  });

  it('returns null for non-string values', () => {
    expect(getStringValue({ key: 123 }, 'key')).toBeNull();
    expect(getStringValue({ key: true }, 'key')).toBeNull();
    expect(getStringValue({ key: null }, 'key')).toBeNull();
  });

  it('returns null for missing key', () => {
    expect(getStringValue({ other: 'value' }, 'key')).toBeNull();
  });

  it('returns null when record is null', () => {
    expect(getStringValue(null, 'key')).toBeNull();
  });
});

// ── toIsoString ──────────────────────────────────────────────────────────────

describe('toIsoString', () => {
  it('converts a Date to ISO string', () => {
    const date = new Date('2026-03-01T12:00:00Z');
    expect(toIsoString(date)).toBe('2026-03-01T12:00:00.000Z');
  });

  it('converts a valid ISO string input', () => {
    expect(toIsoString('2026-03-01T12:00:00Z')).toBe('2026-03-01T12:00:00.000Z');
  });

  it('returns null for null', () => {
    expect(toIsoString(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(toIsoString(undefined)).toBeNull();
  });

  it('returns null for invalid date string', () => {
    expect(toIsoString('not-a-date')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(toIsoString('')).toBeNull();
  });
});

// ── buildRecoveryDownloadDescriptor ──────────────────────────────────────────

describe('buildRecoveryDownloadDescriptor', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BREEZE_SERVER;
    delete process.env.PUBLIC_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('builds correct URL structure', () => {
    process.env.BREEZE_SERVER = 'https://breeze.test';
    const result = buildRecoveryDownloadDescriptor({
      providerSnapshotId: 'snap-abc',
    });

    expect(result.type).toBe('breeze_proxy');
    expect(result.method).toBe('GET');
    expect(result.url).toBe('https://breeze.test/api/v1/backup/bmr/recover/download');
    expect(result.tokenQueryParam).toBe('token');
    expect(result.pathQueryParam).toBe('path');
    expect(result.requiresAuthentication).toBe(true);
    expect(result.pathPrefix).toBe('snapshots/snap-abc');
  });

  it('includes expiry when authenticatedAt and tokenExpiresAt are provided', () => {
    process.env.BREEZE_SERVER = 'https://breeze.test';
    const authenticated = new Date('2026-03-01T00:00:00Z');
    const tokenExpiry = new Date('2026-03-02T00:00:00Z');

    const result = buildRecoveryDownloadDescriptor({
      providerSnapshotId: 'snap-1',
      authenticatedAt: authenticated,
      tokenExpiresAt: tokenExpiry,
    });

    expect(result.expiresAt).not.toBeNull();
    expect(typeof result.expiresAt).toBe('string');
  });

  it('returns null expiresAt when authenticatedAt is missing', () => {
    process.env.BREEZE_SERVER = 'https://breeze.test';
    const result = buildRecoveryDownloadDescriptor({
      providerSnapshotId: 'snap-1',
    });

    expect(result.expiresAt).toBeNull();
  });

  it('uses request URL for server URL resolution', () => {
    const result = buildRecoveryDownloadDescriptor({
      requestUrl: 'https://custom.example.com/api/v1/something',
      providerSnapshotId: 'snap-2',
    });

    expect(result.url).toBe('https://custom.example.com/api/v1/backup/bmr/recover/download');
  });
});
