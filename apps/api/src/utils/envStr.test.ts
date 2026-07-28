import { afterEach, describe, expect, it, vi } from 'vitest';
import { envStr } from './envStr';

describe('envStr', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the default when the variable is absent', () => {
    expect(envStr('__TEST_ENV_STR_ABSENT', 's3,https')).toBe('s3,https');
  });

  // The #2823 regression: compose renders an unmapped `VAR: ${VAR:-}` as
  // `VAR: ""`. `??` does not fire on `''`, so a naive reader produced an
  // EMPTY allowlist (rejecting every evidence URL) rather than the default.
  it('returns the default for an empty string, NOT an empty value', () => {
    vi.stubEnv('__TEST_ENV_STR', '');
    expect(envStr('__TEST_ENV_STR', 's3,https')).toBe('s3,https');
  });

  it('returns the default for a whitespace-only value', () => {
    vi.stubEnv('__TEST_ENV_STR', '   ');
    expect(envStr('__TEST_ENV_STR', 's3,https')).toBe('s3,https');
  });

  it('returns the configured value', () => {
    vi.stubEnv('__TEST_ENV_STR', 'gs,azblob');
    expect(envStr('__TEST_ENV_STR', 's3,https')).toBe('gs,azblob');
  });

  it('trims surrounding whitespace', () => {
    vi.stubEnv('__TEST_ENV_STR', '  gs,azblob  ');
    expect(envStr('__TEST_ENV_STR', 's3,https')).toBe('gs,azblob');
  });
});
