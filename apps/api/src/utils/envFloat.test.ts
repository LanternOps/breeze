import { afterEach, describe, expect, it, vi } from 'vitest';
import { envFloat } from './envFloat';

describe('envFloat', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the default when the variable is absent', () => {
    expect(envFloat('__TEST_ENV_FLOAT_ABSENT', 1.5)).toBe(1.5);
  });

  // The #2823 regression: compose renders an unmapped `VAR: ${VAR:-}` as
  // `VAR: ""`, so `??` never fires and `Number('') === 0`.
  it('returns the default for an empty string, NOT 0', () => {
    vi.stubEnv('__TEST_ENV_FLOAT', '');
    expect(envFloat('__TEST_ENV_FLOAT', 1.5)).toBe(1.5);
    expect(envFloat('__TEST_ENV_FLOAT', 1.5)).not.toBe(0);
  });

  it('returns the default for a whitespace-only value', () => {
    vi.stubEnv('__TEST_ENV_FLOAT', '   ');
    expect(envFloat('__TEST_ENV_FLOAT', 1.5)).toBe(1.5);
  });

  it('returns the default for a non-numeric value', () => {
    vi.stubEnv('__TEST_ENV_FLOAT', 'free');
    expect(envFloat('__TEST_ENV_FLOAT', 1.5)).toBe(1.5);
  });

  // The reason this exists alongside envInt: envInt would truncate to 2.
  it('preserves the fractional part', () => {
    vi.stubEnv('__TEST_ENV_FLOAT', '2.75');
    expect(envFloat('__TEST_ENV_FLOAT', 1.5)).toBe(2.75);
  });

  it('honours an explicit 0', () => {
    vi.stubEnv('__TEST_ENV_FLOAT', '0');
    expect(envFloat('__TEST_ENV_FLOAT', 1.5)).toBe(0);
  });

  it('returns the default for Infinity', () => {
    vi.stubEnv('__TEST_ENV_FLOAT', 'Infinity');
    expect(envFloat('__TEST_ENV_FLOAT', 1.5)).toBe(1.5);
  });
});
