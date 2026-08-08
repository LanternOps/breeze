import { describe, expect, it } from 'vitest';
import { PSA_PROVIDERS, psaProviderIdSchema } from './psa';

describe('PSA_PROVIDERS', () => {
  it('lists exactly the providers with a shipped adapter', () => {
    expect([...PSA_PROVIDERS].sort()).toEqual([
      'autotask',
      'connectwise',
      'freshservice',
      'jira',
      'servicenow',
      'zendesk'
    ]);
  });
});

describe('psaProviderIdSchema', () => {
  it('accepts every implemented provider', () => {
    for (const provider of PSA_PROVIDERS) {
      expect(psaProviderIdSchema.safeParse(provider).success).toBe(true);
    }
  });

  it('rejects DB-enum values that have no adapter', () => {
    for (const dead of ['halo', 'syncro', 'kaseya', 'other']) {
      expect(psaProviderIdSchema.safeParse(dead).success).toBe(false);
    }
  });

  it('rejects non-strings and unknown providers', () => {
    expect(psaProviderIdSchema.safeParse('').success).toBe(false);
    expect(psaProviderIdSchema.safeParse('JIRA').success).toBe(false);
    expect(psaProviderIdSchema.safeParse(undefined).success).toBe(false);
    expect(psaProviderIdSchema.safeParse(42).success).toBe(false);
  });
});
