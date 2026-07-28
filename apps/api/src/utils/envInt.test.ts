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

  it('accepts a negative value (callers clamp if they need a floor)', () => {
    vi.stubEnv('__TEST_ENV_INT', '-5');
    expect(envInt('__TEST_ENV_INT', 1440)).toBe(-5);
  });

  // A bare `parseInt` takes any valid PREFIX, which re-admits the very failure
  // this helper exists to prevent — silently acting on a wrong small number.
  // `parseInt('5e3')` is 5 (a 5ms drain, not 5000ms) and `parseInt('0x10', 10)`
  // is 0 (which some callers read as "unlimited").
  it.each([
    ['1e3', 'exponent notation'],
    ['5e3', 'exponent notation'],
    ['0x10', 'hex'],
    ['12abc', 'trailing garbage'],
    ['1,000', 'thousands separator'],
    ['Infinity', 'non-finite'],
  ])('rejects %s (%s) rather than prefix-parsing it', (value) => {
    vi.stubEnv('__TEST_ENV_INT', value);
    expect(envInt('__TEST_ENV_INT', 1440)).toBe(1440);
  });
});
