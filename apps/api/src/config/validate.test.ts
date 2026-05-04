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

  it('does not require a release artifact manifest public key for local production binaries', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      BINARY_SOURCE: 'local',
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('production');
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

  it('requires pinned trusted proxy CIDRs when proxy headers are trusted in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      TRUSTED_PROXY_CIDRS: '',
    }, () => {
      expect(() => validateConfig()).toThrow('TRUSTED_PROXY_CIDRS');
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
});
