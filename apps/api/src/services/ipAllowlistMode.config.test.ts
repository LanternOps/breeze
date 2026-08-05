import { describe, expect, it, vi } from 'vitest';

// Deliberately NO `vi.mock('../config/validate')` here — that is exactly what
// this file is for.
//
// `ipAllowlist.test.ts` mocks the whole config module file-wide and feeds
// `ipAllowlistMode()` a hand-built literal, so it proves the branching logic but
// never proves the two modules actually fit together. If the schema key were
// renamed, or the `z.preprocess` wrapper changed the parsed shape, the real
// `getConfig().IP_ALLOWLIST_ENFORCEMENT_MODE` would come back `undefined` —
// neither 'enforce' nor 'off' — and every mocked test would stay green while the
// request path silently lost its enforcement mode. This exercises the real seam:
// real validateConfig() -> real getConfig() -> real ipAllowlistMode() (#2896).

const validEnv: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/breeze',
  DATABASE_URL_APP: 'postgresql://breeze_app:request-secret@localhost:5432/breeze',
  JWT_SECRET: 'a7f3b9c2d1e4f6a8b0c3d5e7f9a1b3c5e7d9f1a3b5c7d9e1f3a5b7c9d1e3f5',
  APP_ENCRYPTION_KEY: '440e7e4bafb77c92cc38f818c90ad2e4c155089a438e6a790572a328e532b60a',
  MFA_ENCRYPTION_KEY: 'a725b6546832661a86e27bf46ea556099f163efc5a5f1daa58697f13f6204510',
  NODE_ENV: 'development',
  TRUSTED_PROXY_CIDRS: '172.30.0.11/32',
  AGENT_ENROLLMENT_SECRET: 'prod-test-agent-enrollment-secret-32-chars-min-strong-random',
  ENROLLMENT_KEY_PEPPER: 'prod-test-enrollment-pepper-32-chars-min-strong-random',
  MFA_RECOVERY_CODE_PEPPER: 'prod-test-mfa-recovery-pepper-32-chars-min-strong-random',
  PARTNER_API_CURSOR_SIGNING_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'prod-test-release-manifest-public-key',
  IS_HOSTED: 'true',
  EVENT_PERMISSION_EPOCH_MODE: 'compat',
};

/**
 * Boots a FRESH copy of both modules (the config singleton is process-wide and
 * has no reset path) with `overrides` applied on top of a valid environment,
 * then returns what the real `ipAllowlistMode()` reports.
 */
async function bootAndReadMode(overrides: Record<string, string>): Promise<string> {
  const original: Record<string, string | undefined> = {};
  const applied = { ...validEnv, ...overrides };
  for (const key of Object.keys(applied)) {
    original[key] = process.env[key];
    process.env[key] = applied[key];
  }

  try {
    vi.resetModules();
    const config = await import('../config/validate');
    const allowlist = await import('./ipAllowlist');

    expect(config.isConfigInitialized()).toBe(false);
    config.validateConfig();
    expect(config.isConfigInitialized()).toBe(true);

    return allowlist.ipAllowlistMode();
  } finally {
    for (const [key, val] of Object.entries(original)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    vi.resetModules();
  }
}

describe('ipAllowlistMode over the real validated config (#2896)', () => {
  it('reports off when the operator set off', async () => {
    await expect(bootAndReadMode({ IP_ALLOWLIST_ENFORCEMENT_MODE: 'off' })).resolves.toBe('off');
  });

  it('reports enforce when the operator set enforce', async () => {
    await expect(bootAndReadMode({ IP_ALLOWLIST_ENFORCEMENT_MODE: 'enforce' })).resolves.toBe('enforce');
  });

  // Compose maps this as `${IP_ALLOWLIST_ENFORCEMENT_MODE:-}`, so an operator
  // who never set it still gets the key injected as "".
  it('reports enforce for the compose-injected empty value', async () => {
    await expect(bootAndReadMode({ IP_ALLOWLIST_ENFORCEMENT_MODE: '' })).resolves.toBe('enforce');
  });

  // The bug: the runtime honoured process.env while getConfig() reported the
  // schema default. Both must now agree, on the SAME value, in one process.
  it('agrees with getConfig() instead of diverging from it', async () => {
    const applied: Record<string, string> = { ...validEnv, IP_ALLOWLIST_ENFORCEMENT_MODE: 'off' };
    const originals: Record<string, string | undefined> = {};
    for (const key of Object.keys(applied)) {
      originals[key] = process.env[key];
      process.env[key] = applied[key];
    }

    try {
      vi.resetModules();
      const config = await import('../config/validate');
      const allowlist = await import('./ipAllowlist');
      config.validateConfig();

      expect(config.getConfig().IP_ALLOWLIST_ENFORCEMENT_MODE).toBe('off');
      expect(allowlist.ipAllowlistMode()).toBe(config.getConfig().IP_ALLOWLIST_ENFORCEMENT_MODE);
    } finally {
      for (const [key, val] of Object.entries(originals)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
      vi.resetModules();
    }
  });
});
