import { afterEach, describe, it, expect, vi } from 'vitest';

import { canonicalNodeEnv, normalizeNodeEnv } from './normalizeNodeEnv';

// #917 L-6: a non-canonical NODE_ENV (Production / prod / PROD) used to silently
// downgrade prod security gates to dev mode because every gate did an exact
// `=== 'production'` match. We canonicalize NODE_ENV once at boot instead.
describe('canonicalNodeEnv', () => {
  it('maps every production spelling to "production"', () => {
    for (const raw of ['production', 'Production', 'PRODUCTION', 'prod', 'PROD', '  Prod ']) {
      expect(canonicalNodeEnv(raw)).toBe('production');
    }
  });

  it('maps development spellings to "development"', () => {
    for (const raw of ['development', 'Development', 'DEV', 'dev']) {
      expect(canonicalNodeEnv(raw)).toBe('development');
    }
  });

  it('maps test spellings to "test"', () => {
    expect(canonicalNodeEnv('test')).toBe('test');
    expect(canonicalNodeEnv('TEST')).toBe('test');
  });

  it('returns null for unrecognized values so they are left untouched (zod still rejects them)', () => {
    expect(canonicalNodeEnv('staging')).toBeNull();
    expect(canonicalNodeEnv('')).toBeNull();
  });
});

describe('normalizeNodeEnv', () => {
  it('rewrites a non-canonical production value in place', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'Production' };
    const result = normalizeNodeEnv(env);
    expect(env.NODE_ENV).toBe('production');
    expect(result).toEqual({ from: 'Production', to: 'production', changed: true });
  });

  it('leaves an already-canonical value unchanged (no spurious rewrite)', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    const result = normalizeNodeEnv(env);
    expect(env.NODE_ENV).toBe('production');
    expect(result.changed).toBe(false);
  });

  it('leaves an undefined NODE_ENV untouched (preserves the downstream default)', () => {
    const env: NodeJS.ProcessEnv = {};
    const result = normalizeNodeEnv(env);
    expect('NODE_ENV' in env).toBe(false);
    expect(result.changed).toBe(false);
  });

  it('leaves an unrecognized value untouched so zod can fail-fast on it', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'staging' };
    const result = normalizeNodeEnv(env);
    expect(env.NODE_ENV).toBe('staging');
    expect(result.changed).toBe(false);
  });
});

describe('import side effect', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
    vi.resetModules();
  });

  it('normalizes the live process.env.NODE_ENV when the module is imported (boot path)', async () => {
    // This is the mechanism that protects the import-time gates: importing the
    // module (as index.ts does, right after dotenv) must canonicalize NODE_ENV.
    vi.resetModules();
    process.env.NODE_ENV = 'Production';
    await import('./normalizeNodeEnv');
    expect(process.env.NODE_ENV).toBe('production');
  });
});
