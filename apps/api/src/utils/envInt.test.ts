import { afterEach, describe, expect, it, vi } from 'vitest';
import { envInt } from './envInt';

describe('envInt', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the default when the variable is absent', () => {
    expect(envInt('__TEST_ENV_INT_ABSENT', 1440)).toBe(1440);
  });

  // The #2776 regression: `docker compose config` renders an unmapped
  // `VAR: ${VAR:-}` as `VAR: ""`, so the container sees the variable SET to
  // an empty string. `Number('') === 0` and `??` does not fire on `''`, so a
  // naive reader produced a 0-minute TTL — every enrollment token born
  // expired on any self-host that pulled the release without adding the new
  // keys to its .env.
  it('returns the default for an empty string, NOT 0', () => {
    vi.stubEnv('__TEST_ENV_INT', '');
    expect(envInt('__TEST_ENV_INT', 1440)).toBe(1440);
    expect(envInt('__TEST_ENV_INT', 1440)).not.toBe(0);
  });

  it('returns the default for a whitespace-only value', () => {
    vi.stubEnv('__TEST_ENV_INT', '   ');
    expect(envInt('__TEST_ENV_INT', 1440)).toBe(1440);
  });

  it('returns the default for a non-numeric value', () => {
    vi.stubEnv('__TEST_ENV_INT', 'forever');
    expect(envInt('__TEST_ENV_INT', 1440)).toBe(1440);
  });

  it('parses a valid integer', () => {
    vi.stubEnv('__TEST_ENV_INT', '60');
    expect(envInt('__TEST_ENV_INT', 1440)).toBe(60);
  });

  it('truncates a decimal via parseInt semantics', () => {
    vi.stubEnv('__TEST_ENV_INT', '90.7');
    expect(envInt('__TEST_ENV_INT', 1440)).toBe(90);
  });

  // "0" is a deliberate operator choice, unlike '' — pass it through.
  it('honours an explicit 0', () => {
    vi.stubEnv('__TEST_ENV_INT', '0');
    expect(envInt('__TEST_ENV_INT', 1440)).toBe(0);
  });
});
