import { afterEach, describe, expect, it } from 'vitest';
import { createCorsOriginResolver, DEFAULT_ALLOWED_ORIGINS, TAURI_ORIGINS, shouldIncludeDefaultOrigins } from './corsOrigins';

describe('cors origin resolver', () => {
  it('allows known default origin when explicitly configured', () => {
    const resolveOrigin = createCorsOriginResolver({
      defaultOrigins: [...DEFAULT_ALLOWED_ORIGINS],
      nodeEnv: 'production'
    });

    expect(resolveOrigin('http://localhost:4321')).toBe('http://localhost:4321');
  });

  it('allows configured custom origin', () => {
    const resolveOrigin = createCorsOriginResolver({
      configuredOriginsRaw: 'https://app.example.com, https://admin.example.com',
      nodeEnv: 'production'
    });

    expect(resolveOrigin('https://admin.example.com')).toBe('https://admin.example.com');
  });

  it('allows localhost variants in development', () => {
    const resolveOrigin = createCorsOriginResolver({
      nodeEnv: 'development'
    });

    expect(resolveOrigin('http://localhost:9999')).toBe('http://localhost:9999');
    expect(resolveOrigin('http://127.0.0.1:5000')).toBe('http://127.0.0.1:5000');
  });

  it('returns null for unknown production origin', () => {
    const resolveOrigin = createCorsOriginResolver({
      configuredOriginsRaw: 'https://app.example.com',
      nodeEnv: 'production'
    });

    expect(resolveOrigin('https://malicious.example')).toBeNull();
  });

  it('returns null when origin is undefined', () => {
    const resolveOrigin = createCorsOriginResolver({
      nodeEnv: 'production'
    });

    expect(resolveOrigin(undefined)).toBeNull();
  });

  it('excludes default localhost origins in production by default', () => {
    const resolveOrigin = createCorsOriginResolver({
      nodeEnv: 'production'
    });

    expect(resolveOrigin('http://localhost:4321')).toBeNull();
    expect(resolveOrigin('http://127.0.0.1:4321')).toBeNull();
  });

  it('always allows Tauri origins in production (Breeze Viewer app)', () => {
    const resolveOrigin = createCorsOriginResolver({
      configuredOriginsRaw: 'https://app.example.com',
      nodeEnv: 'production'
    });

    for (const origin of TAURI_ORIGINS) {
      expect(resolveOrigin(origin)).toBe(origin);
    }
  });

  it('includes default origins in development', () => {
    const resolveOrigin = createCorsOriginResolver({
      nodeEnv: 'development'
    });

    expect(resolveOrigin('http://localhost:4321')).toBe('http://localhost:4321');
  });

  it('rejects unknown localhost ports in production', () => {
    const resolveOrigin = createCorsOriginResolver({
      nodeEnv: 'production'
    });

    expect(resolveOrigin('http://localhost:9999')).toBeNull();
  });
});

describe('shouldIncludeDefaultOrigins', () => {
  const originalEnv = process.env.CORS_INCLUDE_DEFAULT_ORIGINS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CORS_INCLUDE_DEFAULT_ORIGINS;
    } else {
      process.env.CORS_INCLUDE_DEFAULT_ORIGINS = originalEnv;
    }
  });

  it('returns true for non-production', () => {
    expect(shouldIncludeDefaultOrigins('development')).toBe(true);
    expect(shouldIncludeDefaultOrigins('test')).toBe(true);
  });

  it('returns false for production by default', () => {
    delete process.env.CORS_INCLUDE_DEFAULT_ORIGINS;
    expect(shouldIncludeDefaultOrigins('production')).toBe(false);
  });

  it('returns true for production when flag is set', () => {
    process.env.CORS_INCLUDE_DEFAULT_ORIGINS = 'true';
    expect(shouldIncludeDefaultOrigins('production')).toBe(true);
  });
});
