import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from './validate';

function withEnv(overrides: Record<string, string>, fn: () => void) {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    fn();
  } finally {
    for (const [key, val] of Object.entries(original)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/breeze',
  JWT_SECRET: 'a7f3b9c2d1e4f6a8b0c3d5e7f9a1b3c5e7d9f1a3b5c7d9e1f3a5b7c9d1e3f5',
  APP_ENCRYPTION_KEY: '440e7e4bafb77c92cc38f818c90ad2e4c155089a438e6a790572a328e532b60a',
  MFA_ENCRYPTION_KEY: 'a725b6546832661a86e27bf46ea556099f163efc5a5f1daa58697f13f6204510',
  NODE_ENV: 'development',
  TRUSTED_PROXY_CIDRS: '172.30.0.11/32',
  // Production-required (now mandatory in prod). Provide a strong random
  // value here so the suite's many "production happy-path" tests don't trip
  // the new fail-loud check; tests that assert the missing-secret throw
  // override this explicitly.
  AGENT_ENROLLMENT_SECRET: 'prod-test-agent-enrollment-secret-32-chars-min-strong-random',
  ENROLLMENT_KEY_PEPPER: 'prod-test-enrollment-pepper-32-chars-min-strong-random',
  MFA_RECOVERY_CODE_PEPPER: 'prod-test-mfa-recovery-pepper-32-chars-min-strong-random',
  RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'prod-test-release-manifest-public-key',
  // Production-required (#570 defense-in-depth): explicit boolean keeps the
  // many "production happy-path" tests below from tripping the new check.
  // Tests that assert the missing/invalid IS_HOSTED throw override this.
  IS_HOSTED: 'true',
};

describe('validateConfig', () => {
  afterEach(() => {
    // Reset singleton between tests by reimporting is not practical,
    // but validateConfig() can be called multiple times safely
  });

  it('passes with valid config in development', () => {
    withEnv(validEnv, () => {
      const config = validateConfig();
      expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
      expect(config.JWT_SECRET).toBe(validEnv.JWT_SECRET);
      expect(config.NODE_ENV).toBe('development');
      expect(config.API_PORT).toBe(3001);
      expect(config.REDIS_URL).toBe('redis://localhost:6379');
    });
  });

  it('passes with valid config in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('production');
    });
  });

  it('accepts explicit production bootstrap admin credentials', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.test',
      BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'operator-generated-credential-32-chars',
    }, () => {
      const config = validateConfig();
      expect(config.BREEZE_BOOTSTRAP_ADMIN_EMAIL).toBe('owner@example.test');
    });
  });

  it('rejects partial production bootstrap admin credentials', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'operator-generated-credential-32-chars',
    }, () => {
      expect(() => validateConfig()).toThrow('BREEZE_BOOTSTRAP_ADMIN_EMAIL');
    });
  });

  it('rejects production bootstrap admin development defaults', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      BREEZE_BOOTSTRAP_ADMIN_EMAIL: 'admin@breeze.local',
      BREEZE_BOOTSTRAP_ADMIN_PASSWORD: 'BreezeAdmin123!',
    }, () => {
      expect(() => validateConfig()).toThrow('development default');
    });
  });

  it('throws when DATABASE_URL is missing', () => {
    withEnv({ ...validEnv, DATABASE_URL: '' }, () => {
      expect(() => validateConfig()).toThrow('DATABASE_URL');
    });
  });

  it('throws when DATABASE_URL has invalid format', () => {
    withEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' }, () => {
      expect(() => validateConfig()).toThrow('postgres');
    });
  });

  it('accepts postgres:// prefix', () => {
    withEnv({ ...validEnv, DATABASE_URL: 'postgres://user:pass@localhost/db' }, () => {
      const config = validateConfig();
      expect(config.DATABASE_URL).toContain('postgres://');
    });
  });

  it('throws when JWT_SECRET is missing', () => {
    const env = { ...validEnv };
    delete (env as any).JWT_SECRET;
    withEnv({ ...env, JWT_SECRET: '' }, () => {
      expect(() => validateConfig()).toThrow('JWT_SECRET');
    });
  });

  it('throws when APP_ENCRYPTION_KEY is missing', () => {
    withEnv({ ...validEnv, APP_ENCRYPTION_KEY: '' }, () => {
      expect(() => validateConfig()).toThrow('APP_ENCRYPTION_KEY');
    });
  });

  it('throws when MFA_ENCRYPTION_KEY is missing', () => {
    withEnv({ ...validEnv, MFA_ENCRYPTION_KEY: '' }, () => {
      expect(() => validateConfig()).toThrow('MFA_ENCRYPTION_KEY');
    });
  });

  it('rejects insecure JWT_SECRET in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'changeme',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('insecure');
    });
  });

  it('rejects known placeholder values in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'your-super-secret-jwt-key-change-in-production-must-be-at-least-32-chars',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('insecure');
    });
  });

  it('rejects malformed APP_ENCRYPTION_KEY in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      APP_ENCRYPTION_KEY: 'short-non-placeholder-key-material',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('APP_ENCRYPTION_KEY');
      expect(() => validateConfig()).toThrow('32 random bytes');
    });
  });

  it('rejects low-entropy encryption keys in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      APP_ENCRYPTION_KEY: '0'.repeat(64),
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('low-entropy');
    });
  });

  it('rejects structured sequential encryption keys in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      APP_ENCRYPTION_KEY: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      MFA_ENCRYPTION_KEY: 'BggflybQysOuzKYNrLNdVFyWG3bw7ntqMUJS3Qdv2xM=',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('low-entropy');
    });
  });

  it('rejects repeated-block encryption keys in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      APP_ENCRYPTION_KEY: '440e7e4bafb77c92440e7e4bafb77c92440e7e4bafb77c92440e7e4bafb77c92',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('low-entropy');
    });
  });

  it('rejects reused encryption key domains in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      MFA_ENCRYPTION_KEY: validEnv.APP_ENCRYPTION_KEY,
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('must not reuse secret material');
    });
  });

  it('rejects reused encryption key material across different encodings in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      MFA_ENCRYPTION_KEY: 'RA5+S6+3fJLMOPgYyQrS5MFVCJpDjmp5BXKjKOUytgo=',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('key material');
    });
  });

  it('rejects encryption keys reused with configured peppers in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      ENROLLMENT_KEY_PEPPER: validEnv.APP_ENCRYPTION_KEY,
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('must not reuse secret material');
    });
  });

  it('requires a release artifact manifest public key for production GitHub binaries', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      BINARY_SOURCE: 'github',
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
      BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS');
    });
  });

  // Task 27 / audit HIGH-2: previously the validator only required
  // RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS when BINARY_SOURCE=github. A
  // self-hosted deploy that switched to BINARY_SOURCE=local without the
  // trust key would silently fall back to unsigned manifest acceptance —
  // agents would then trust update manifests with no signature verification.
  // The check now fires for BOTH github and local in production.
  it('refuses BINARY_SOURCE=local without RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      BINARY_SOURCE: 'local',
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
      BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow(/RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS/i);
    });
  });

  it('boots when BINARY_SOURCE=local AND the manifest pubkey is set in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      BINARY_SOURCE: 'local',
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'prod-test-release-manifest-public-key',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('production');
    });
  });

  it('accepts BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS as a fallback when BINARY_SOURCE=local', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      BINARY_SOURCE: 'local',
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
      BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'prod-test-release-manifest-public-key',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('production');
    });
  });

  it('does not require manifest pubkey for BINARY_SOURCE=local outside production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'development',
      BINARY_SOURCE: 'local',
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
      BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
    }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it('accepts documented 32-byte base64 encryption keys in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      APP_ENCRYPTION_KEY: 'BggflybQysOuzKYNrLNdVFyWG3bw7ntqMUJS3Qdv2xM=',
      MFA_ENCRYPTION_KEY: 'uA8dTOTNSgE+XrFrurrahEYdyGwdJu6IU5eDXDsXIJ8=',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('production');
    });
  });

  it('allows any JWT_SECRET value in development', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'development',
      JWT_SECRET: 'changeme',
    }, () => {
      const config = validateConfig();
      expect(config.JWT_SECRET).toBe('changeme');
    });
  });

  it('allows any JWT_SECRET value in test', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'test',
      JWT_SECRET: 'e2e-test-jwt-key-with-the-word-changeme',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('test');
    });
  });

  it('rejects wildcard CORS in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: '*',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('CORS_ALLOWED_ORIGINS');
    });
  });

  it('rejects missing CORS in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('CORS_ALLOWED_ORIGINS');
    });
  });

  it('requires explicit TRUST_PROXY_HEADERS in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
    }, () => {
      expect(() => validateConfig()).toThrow('TRUST_PROXY_HEADERS');
    });
  });

  // CRIT-1 / Task 25: when TRUST_PROXY_HEADERS=true in production, missing
  // TRUSTED_PROXY_CIDRS used to fall back to loopback-only with a warning.
  // That fallback means `isTrustedProxySource` rejects every upstream — the
  // API then returns the socket IP (the proxy itself), so every request
  // collapses to one fingerprint and per-IP rate limits stop functioning.
  // Boot-refuse the misconfig so a single env-var typo can't enable
  // unlimited credential stuffing against a self-hosted deploy.
  it('refuses boot when TRUST_PROXY_HEADERS=true but TRUSTED_PROXY_CIDRS is empty in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      TRUSTED_PROXY_CIDRS: '',
    }, () => {
      expect(() => validateConfig()).toThrow(/TRUSTED_PROXY_CIDRS/i);
    });
  });

  it('rejects broad private trusted proxy CIDRs in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      TRUSTED_PROXY_CIDRS: '172.30.0.0/24',
    }, () => {
      expect(() => validateConfig()).toThrow('Private-network trusted proxies');
    });
  });

  it('allows proxy trust without CIDRs when proxy headers are disabled in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'false',
      TRUSTED_PROXY_CIDRS: '',
    }, () => {
      const config = validateConfig();
      expect(config.TRUST_PROXY_HEADERS).toBe('false');
    });
  });

  // #570 defense-in-depth: IS_HOSTED gates the email-verification path in
  // register.ts. A misconfigured deploy (env not mapped through compose)
  // would silently drop new partners to status='active' and skip the
  // verify gate. Fail loud at startup instead.
  it('throws when IS_HOSTED is missing in production', () => {
    // Empty string ↔ unset for this check (`(data.IS_HOSTED ?? '').trim()`),
    // so this also covers the unset case without depending on shell state.
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      IS_HOSTED: '',
    }, () => {
      expect(() => validateConfig()).toThrow('IS_HOSTED');
    });
  });

  it('throws when IS_HOSTED is set to a non-boolean string in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      IS_HOSTED: 'maybe',
    }, () => {
      expect(() => validateConfig()).toThrow('IS_HOSTED');
    });
  });

  it.each(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])(
    'accepts IS_HOSTED=%j in production',
    (value) => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        IS_HOSTED: value,
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    },
  );

  it('does not require IS_HOSTED outside production', () => {
    withEnv({ ...validEnv, IS_HOSTED: '' }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it('allows missing CORS in development', () => {
    withEnv(validEnv, () => {
      const config = validateConfig();
      expect(config.CORS_ALLOWED_ORIGINS).toBeUndefined();
    });
  });

  it('parses API_PORT correctly', () => {
    withEnv({ ...validEnv, API_PORT: '8080' }, () => {
      const config = validateConfig();
      expect(config.API_PORT).toBe(8080);
    });
  });

  it('rejects invalid API_PORT', () => {
    withEnv({ ...validEnv, API_PORT: '99999' }, () => {
      expect(() => validateConfig()).toThrow();
    });
  });

  it('rejects non-numeric API_PORT', () => {
    withEnv({ ...validEnv, API_PORT: 'abc' }, () => {
      expect(() => validateConfig()).toThrow();
    });
  });

  it('defaults API_PORT to 3001', () => {
    withEnv(validEnv, () => {
      const config = validateConfig();
      expect(config.API_PORT).toBe(3001);
    });
  });

  it('logs warnings for insecure optional secrets', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv({
      ...validEnv,
      AGENT_ENROLLMENT_SECRET: 'changeme',
    }, () => {
      validateConfig();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('AGENT_ENROLLMENT_SECRET')
      );
    });
    warnSpy.mockRestore();
  });

  it('rejects short AGENT_ENROLLMENT_SECRET in production when configured', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      AGENT_ENROLLMENT_SECRET: 'too-short',
    }, () => {
      expect(() => validateConfig()).toThrow('AGENT_ENROLLMENT_SECRET');
    });
  });

  it('rejects placeholder AGENT_ENROLLMENT_SECRET in production when configured', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      AGENT_ENROLLMENT_SECRET: 'your-enrollment-secret-change-in-production',
    }, () => {
      expect(() => validateConfig()).toThrow('AGENT_ENROLLMENT_SECRET');
    });
  });

  it('rejects missing AGENT_ENROLLMENT_SECRET in production (fail-loud)', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      AGENT_ENROLLMENT_SECRET: '',
    }, () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => validateConfig()).toThrow('AGENT_ENROLLMENT_SECRET');
      warnSpy.mockRestore();
    });
  });

  it('allows missing AGENT_ENROLLMENT_SECRET in development', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'development',
      AGENT_ENROLLMENT_SECRET: '',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('development');
      // withEnv writes '' (not undefined) into the env. The validator
      // accepts both in dev — assert the validator did not throw.
      expect(config.AGENT_ENROLLMENT_SECRET ?? '').toBe('');
    });
  });

  it('rejects short ENROLLMENT_KEY_PEPPER in production when configured', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      ENROLLMENT_KEY_PEPPER: 'short-pepper',
    }, () => {
      expect(() => validateConfig()).toThrow('ENROLLMENT_KEY_PEPPER');
    });
  });

  it('rejects placeholder ENROLLMENT_KEY_PEPPER in production when configured', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      ENROLLMENT_KEY_PEPPER: 'generate-a-random-hex-string-for-production',
    }, () => {
      expect(() => validateConfig()).toThrow('ENROLLMENT_KEY_PEPPER');
    });
  });

  it('rejects missing ENROLLMENT_KEY_PEPPER in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      ENROLLMENT_KEY_PEPPER: '',
    }, () => {
      expect(() => validateConfig()).toThrow('ENROLLMENT_KEY_PEPPER');
    });
  });

  it('rejects missing MFA_RECOVERY_CODE_PEPPER in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      MFA_RECOVERY_CODE_PEPPER: '',
    }, () => {
      expect(() => validateConfig()).toThrow('MFA_RECOVERY_CODE_PEPPER');
    });
  });

  it('logs FORCE_HTTPS warning in production', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      validateConfig();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('FORCE_HTTPS')
      );
    });
    warnSpy.mockRestore();
  });

  it('includes formatted error banner on failure', () => {
    withEnv({ ...validEnv, DATABASE_URL: '' }, () => {
      try {
        validateConfig();
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('CONFIGURATION VALIDATION FAILED');
        expect(err.message).toContain('Hint:');
      }
    });
  });

  const openAiCompatibleEnv = {
    ...validEnv,
    MCP_LLM_PROVIDER: 'openai-compatible',
    MCP_LLM_BASE_URL: 'http://localhost:8000/v1',
    MCP_LLM_MODEL: 'test-model',
    MCP_LLM_API_KEY: 'sk-test',
  };

  it('requires MCP_LLM_MODEL when MCP_LLM_PROVIDER is openai-compatible', () => {
    const { MCP_LLM_MODEL: _, ...rest } = openAiCompatibleEnv;
    withEnv(rest as Record<string, string>, () => {
      expect(() => validateConfig()).toThrow('MCP_LLM_MODEL');
    });
  });

  it('requires non-empty MCP_LLM_MODEL when MCP_LLM_PROVIDER is openai-compatible', () => {
    withEnv({ ...openAiCompatibleEnv, MCP_LLM_MODEL: '   ' }, () => {
      expect(() => validateConfig()).toThrow('MCP_LLM_MODEL');
    });
  });

  it('requires MCP_LLM_API_KEY when MCP_LLM_PROVIDER is openai-compatible', () => {
    const { MCP_LLM_API_KEY: _, ...rest } = openAiCompatibleEnv;
    withEnv(rest as Record<string, string>, () => {
      expect(() => validateConfig()).toThrow('MCP_LLM_API_KEY');
    });
  });

  it('accepts openai-compatible when base URL, model, and API key are set', () => {
    withEnv(openAiCompatibleEnv, () => {
      const config = validateConfig();
      expect(config.MCP_LLM_PROVIDER).toBe('openai-compatible');
      expect(config.MCP_LLM_MODEL).toBe('test-model');
      expect(config.MCP_LLM_API_KEY).toBe('sk-test');
    });
  });

  // ---- OAuth DCR (Dynamic Client Registration) hardening (Task 21) -------
  // When DCR is on in production, every client registration is anonymous and
  // self-asserting. Without an initial-access-token gate, the registration
  // endpoint is open to public spam (deceptive client_name strings, etc.).
  // Boot must refuse the misconfig.
  describe('OAuth DCR config validation', () => {
    it('refuses boot in production when OAUTH_DCR_ENABLED=true without OAUTH_DCR_REQUIRE_IAT=true', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        OAUTH_DCR_ENABLED: 'true',
        OAUTH_DCR_REQUIRE_IAT: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/OAUTH_DCR_REQUIRE_IAT/i);
      });
    });

    it('boots in production when OAUTH_DCR_ENABLED=true and OAUTH_DCR_REQUIRE_IAT=true', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        OAUTH_DCR_ENABLED: 'true',
        OAUTH_DCR_REQUIRE_IAT: 'true',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('boots in production when OAUTH_DCR_ENABLED is unset (default false)', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        OAUTH_DCR_ENABLED: '',
        OAUTH_DCR_REQUIRE_IAT: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('boots in production when OAUTH_DCR_ENABLED=false (IAT not required)', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        OAUTH_DCR_ENABLED: 'false',
        OAUTH_DCR_REQUIRE_IAT: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('boots in development with OAUTH_DCR_ENABLED=true and no IAT (dev exception)', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'development',
        OAUTH_DCR_ENABLED: 'true',
        OAUTH_DCR_REQUIRE_IAT: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
  });

  // ---- TRUST_PROXY_HEADERS / TRUSTED_PROXY_CIDRS hardening (CRIT-1, Task 25) ----
  // When the API runs behind a reverse proxy in production, both
  //   TRUST_PROXY_HEADERS=true AND a non-empty TRUSTED_PROXY_CIDRS
  // are required. Without TRUSTED_PROXY_CIDRS, the proxy-trust path falls
  // back to loopback-only — which means `isTrustedProxySource` rejects the
  // real upstream proxy and `getTrustedClientIp` returns the proxy's own
  // socket address for every request. Per-IP rate limits then collapse onto
  // a single fingerprint and credential stuffing becomes unbounded.
  describe('TRUST_PROXY_HEADERS validation', () => {
    it('refuses to boot in production when TRUST_PROXY_HEADERS is missing', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/TRUST_PROXY_HEADERS/i);
      });
    });

    it('refuses to boot when TRUST_PROXY_HEADERS=true but TRUSTED_PROXY_CIDRS is empty', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        TRUSTED_PROXY_CIDRS: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/TRUSTED_PROXY_CIDRS/i);
      });
    });

    it('refuses to boot when TRUST_PROXY_HEADERS=true but TRUSTED_PROXY_CIDRS is whitespace-only', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        TRUSTED_PROXY_CIDRS: '   ',
      }, () => {
        expect(() => validateConfig()).toThrow(/TRUSTED_PROXY_CIDRS/i);
      });
    });

    it.each(['true', '1', 'yes', 'on'])(
      'refuses to boot when TRUST_PROXY_HEADERS=%j but TRUSTED_PROXY_CIDRS is empty',
      (truthy) => {
        withEnv({
          ...validEnv,
          NODE_ENV: 'production',
          CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
          TRUST_PROXY_HEADERS: truthy,
          TRUSTED_PROXY_CIDRS: '',
        }, () => {
          expect(() => validateConfig()).toThrow(/TRUSTED_PROXY_CIDRS/i);
        });
      },
    );

    it('boots when both TRUST_PROXY_HEADERS=true and TRUSTED_PROXY_CIDRS are set in production', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        TRUSTED_PROXY_CIDRS: '172.30.0.11/32',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('boots when TRUST_PROXY_HEADERS=false (proxy headers explicitly distrusted) regardless of CIDRs', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'false',
        TRUSTED_PROXY_CIDRS: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('does not require TRUSTED_PROXY_CIDRS in development when TRUST_PROXY_HEADERS is unset', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'development',
        TRUST_PROXY_HEADERS: '',
        TRUSTED_PROXY_CIDRS: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('does not require TRUSTED_PROXY_CIDRS in development even when TRUST_PROXY_HEADERS=true', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'development',
        TRUST_PROXY_HEADERS: 'true',
        TRUSTED_PROXY_CIDRS: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Task 26 (audit H-3): feature-flagged secrets must be present in production.
  //
  // Several "boot-or-die" secrets are read directly at first feature use and
  // silently 500 the request rather than failing at boot. The validator now
  // enforces them in production whenever the corresponding feature flag (or
  // soft-enable indicator — see below) is set.
  //
  // Important: this codebase does NOT use a uniform `<FEATURE>_ENABLED` flag
  // pattern. The actual indicators are:
  //   - Billing (breeze-billing service-to-service):     BREEZE_BILLING_URL set
  //   - Billing (AI cost tracking via partner service):  BILLING_SERVICE_URL set
  //   - OAuth (MCP DCR + JWT):                           MCP_OAUTH_ENABLED=true
  //   - S3 / object storage:                             S3_BUCKET set
  //   - Email (Resend):                                  EMAIL_PROVIDER=resend
  //                                                       OR (auto + RESEND_API_KEY)
  //   - Cloudflare mTLS:                                 CLOUDFLARE_API_TOKEN set
  //   - MSI signing:                                     MSI_SIGNING_URL set
  //
  // Stripe is NOT present in apps/api (it lives in the separate breeze-billing
  // service). The audit plan listed STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
  // speculatively; the API-side enforcement here covers BILLING_SERVICE_API_KEY
  // and BREEZE_BILLING_URL's companion secrets instead.
  describe('Feature-flagged production secrets (H-3)', () => {
    const prodBase = {
      ...validEnv,
      NODE_ENV: 'production' as const,
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    };

    // --- OAuth (MCP_OAUTH_ENABLED) ------------------------------------------
    it('refuses to boot when MCP_OAUTH_ENABLED=true but OAUTH_JWKS_PRIVATE_JWK is missing', () => {
      withEnv({
        ...prodBase,
        MCP_OAUTH_ENABLED: 'true',
        OAUTH_JWKS_PRIVATE_JWK: '',
        OAUTH_COOKIE_SECRET: 'a-strong-random-cookie-secret-32-chars-min',
      }, () => {
        expect(() => validateConfig()).toThrow(/OAUTH_JWKS_PRIVATE_JWK/);
      });
    });

    it('refuses to boot when MCP_OAUTH_ENABLED=true but OAUTH_COOKIE_SECRET is missing', () => {
      withEnv({
        ...prodBase,
        MCP_OAUTH_ENABLED: 'true',
        OAUTH_JWKS_PRIVATE_JWK: '{"keys":[{"kty":"OKP"}]}',
        OAUTH_COOKIE_SECRET: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/OAUTH_COOKIE_SECRET/);
      });
    });

    it('does not require OAuth secrets when MCP_OAUTH_ENABLED is false', () => {
      withEnv({
        ...prodBase,
        MCP_OAUTH_ENABLED: 'false',
        OAUTH_JWKS_PRIVATE_JWK: '',
        OAUTH_COOKIE_SECRET: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('boots when MCP_OAUTH_ENABLED=true and both OAuth secrets are set', () => {
      withEnv({
        ...prodBase,
        MCP_OAUTH_ENABLED: 'true',
        OAUTH_JWKS_PRIVATE_JWK: '{"keys":[{"kty":"OKP"}]}',
        OAUTH_COOKIE_SECRET: 'a-strong-random-cookie-secret-32-chars-min',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // --- Billing (BREEZE_BILLING_URL + BILLING_SERVICE_URL) -----------------
    it('refuses to boot when BREEZE_BILLING_URL is set but BREEZE_BILLING_API_KEY is missing', () => {
      withEnv({
        ...prodBase,
        BREEZE_BILLING_URL: 'https://billing.2breeze.app',
        BREEZE_BILLING_API_KEY: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/BREEZE_BILLING_API_KEY/);
      });
    });

    it('refuses to boot when BILLING_SERVICE_URL is set but BILLING_SERVICE_API_KEY is missing', () => {
      withEnv({
        ...prodBase,
        BILLING_SERVICE_URL: 'https://billing.internal',
        BILLING_SERVICE_API_KEY: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/BILLING_SERVICE_API_KEY/);
      });
    });

    it('does not require billing secrets when billing URLs are unset', () => {
      withEnv({
        ...prodBase,
        BREEZE_BILLING_URL: '',
        BILLING_SERVICE_URL: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // --- S3 / object storage (S3_BUCKET) ------------------------------------
    it('refuses to boot when S3_BUCKET is set but S3_SECRET_KEY is missing', () => {
      withEnv({
        ...prodBase,
        S3_BUCKET: 'breeze-binaries',
        S3_ACCESS_KEY: 'AKIAEXAMPLE',
        S3_SECRET_KEY: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/S3_SECRET_KEY/);
      });
    });

    it('refuses to boot when S3_BUCKET is set but S3_ACCESS_KEY is missing', () => {
      withEnv({
        ...prodBase,
        S3_BUCKET: 'breeze-binaries',
        S3_ACCESS_KEY: '',
        S3_SECRET_KEY: 'shhh',
      }, () => {
        expect(() => validateConfig()).toThrow(/S3_ACCESS_KEY/);
      });
    });

    it('does not require S3 credentials when S3_BUCKET is unset', () => {
      withEnv({
        ...prodBase,
        S3_BUCKET: '',
        S3_ACCESS_KEY: '',
        S3_SECRET_KEY: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // --- Email (EMAIL_PROVIDER=resend) --------------------------------------
    it('refuses to boot when EMAIL_PROVIDER=resend but RESEND_API_KEY is missing', () => {
      withEnv({
        ...prodBase,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/RESEND_API_KEY/);
      });
    });

    it('refuses to boot when EMAIL_PROVIDER=smtp but SMTP_HOST is missing', () => {
      withEnv({
        ...prodBase,
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/SMTP_HOST/);
      });
    });

    it('refuses to boot when EMAIL_PROVIDER=mailgun but MAILGUN_API_KEY is missing', () => {
      withEnv({
        ...prodBase,
        EMAIL_PROVIDER: 'mailgun',
        MAILGUN_API_KEY: '',
        MAILGUN_DOMAIN: 'mg.example.com',
      }, () => {
        expect(() => validateConfig()).toThrow(/MAILGUN_API_KEY/);
      });
    });

    it('does not require Resend key when EMAIL_PROVIDER is unset/auto', () => {
      withEnv({
        ...prodBase,
        EMAIL_PROVIDER: '',
        RESEND_API_KEY: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('boots when EMAIL_PROVIDER=resend and RESEND_API_KEY is set', () => {
      withEnv({
        ...prodBase,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_strong_key_value',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // --- Cloudflare (CLOUDFLARE_API_TOKEN set) ------------------------------
    it('refuses to boot when CLOUDFLARE_API_TOKEN is set but CLOUDFLARE_ZONE_ID is missing', () => {
      withEnv({
        ...prodBase,
        CLOUDFLARE_API_TOKEN: 'cf-token-xxx',
        CLOUDFLARE_ZONE_ID: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/CLOUDFLARE_ZONE_ID/);
      });
    });

    it('does not require Cloudflare zone id when token is unset', () => {
      withEnv({
        ...prodBase,
        CLOUDFLARE_API_TOKEN: '',
        CLOUDFLARE_ZONE_ID: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // --- MSI signing (MSI_SIGNING_URL set) ----------------------------------
    it('refuses to boot when MSI_SIGNING_URL is set but MSI_SIGNING_CF_ACCESS_SECRET is missing', () => {
      withEnv({
        ...prodBase,
        MSI_SIGNING_URL: 'https://sign.2breeze.app/sign-breeze-agent',
        MSI_SIGNING_CF_ACCESS_ID: 'cf-access-id',
        MSI_SIGNING_CF_ACCESS_SECRET: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/MSI_SIGNING_CF_ACCESS_SECRET/);
      });
    });

    it('does not require MSI signing secrets when URL is unset', () => {
      withEnv({
        ...prodBase,
        MSI_SIGNING_URL: '',
        MSI_SIGNING_CF_ACCESS_SECRET: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // --- Delegant M365 (DELEGANT_BASE_URL as soft-enable indicator) ----------
    it('refuses to boot when DELEGANT_BASE_URL is set but a companion secret is missing', () => {
      withEnv({
        ...prodBase,
        DELEGANT_BASE_URL: 'https://delegant.internal',
        DELEGANT_SERVICE_TOKEN: 'svc',
        DELEGANT_PRINCIPAL_SIGNING_KEY: '',
        DELEGANT_PRINCIPAL_KID: 'kid-1',
      }, () => {
        expect(() => validateConfig()).toThrow(/DELEGANT_PRINCIPAL_SIGNING_KEY/);
      });
    });

    it('does not require Delegant secrets when DELEGANT_BASE_URL is unset', () => {
      withEnv({
        ...prodBase,
        DELEGANT_BASE_URL: '',
        DELEGANT_SERVICE_TOKEN: '',
        DELEGANT_PRINCIPAL_SIGNING_KEY: '',
        DELEGANT_PRINCIPAL_KID: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // --- Dev mode never enforces ----------------------------------------------
    it('does not enforce feature-flagged secrets in development', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'development',
        MCP_OAUTH_ENABLED: 'true',
        OAUTH_JWKS_PRIVATE_JWK: '',
        OAUTH_COOKIE_SECRET: '',
        BREEZE_BILLING_URL: 'https://billing.internal',
        BREEZE_BILLING_API_KEY: '',
        S3_BUCKET: 'breeze',
        S3_SECRET_KEY: '',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: '',
        CLOUDFLARE_API_TOKEN: 'cf',
        CLOUDFLARE_ZONE_ID: '',
        MSI_SIGNING_URL: 'https://sign',
        MSI_SIGNING_CF_ACCESS_SECRET: '',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // ENABLE_2FA=false warning (Finding #3)
  // ---------------------------------------------------------------------------
  describe('ENABLE_2FA=false warning', () => {
    it('emits ENABLE_2FA warning in production when ENABLE_2FA=false', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        ENABLE_2FA: 'false',
      }, () => {
        // Must NOT throw — this is warn-only
        expect(() => validateConfig()).not.toThrow();
        // Must emit a warning mentioning ENABLE_2FA, requireMfa, and clarify it's not just /auth/mfa
        const calls = warnSpy.mock.calls.map(args => args[0] as string);
        const enable2faWarning = calls.find(msg => msg.includes('ENABLE_2FA'));
        expect(enable2faWarning).toBeDefined();
        expect(enable2faWarning).toContain('requireMfa');
        expect(enable2faWarning).not.toMatch(/only.*\/auth\/mfa/i);
      });
      warnSpy.mockRestore();
    });

    it('emits ENABLE_2FA warning with "0" value', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        ENABLE_2FA: '0',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
        const calls = warnSpy.mock.calls.map(args => args[0] as string);
        expect(calls.some(msg => msg.includes('ENABLE_2FA'))).toBe(true);
      });
      warnSpy.mockRestore();
    });

    it('emits ENABLE_2FA warning for a non-standard falsy value (envFlag disables on any non-truthy value)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        ENABLE_2FA: 'disabled',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
        const calls = warnSpy.mock.calls.map(args => args[0] as string);
        expect(calls.some(msg => msg.includes('ENABLE_2FA'))).toBe(true);
      });
      warnSpy.mockRestore();
    });

    it('does NOT emit ENABLE_2FA warning when ENABLE_2FA=true', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        ENABLE_2FA: 'true',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
        const calls = warnSpy.mock.calls.map(args => args[0] as string);
        expect(calls.some(msg => msg.includes('ENABLE_2FA'))).toBe(false);
      });
      warnSpy.mockRestore();
    });

    it('does NOT emit ENABLE_2FA warning when ENABLE_2FA is unset', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
      }, () => {
        // Ensure ENABLE_2FA is not set
        const orig = process.env.ENABLE_2FA;
        delete process.env.ENABLE_2FA;
        try {
          expect(() => validateConfig()).not.toThrow();
          const calls = warnSpy.mock.calls.map(args => args[0] as string);
          expect(calls.some(msg => msg.includes('ENABLE_2FA'))).toBe(false);
        } finally {
          if (orig !== undefined) process.env.ENABLE_2FA = orig;
        }
      });
      warnSpy.mockRestore();
    });
  });
});
