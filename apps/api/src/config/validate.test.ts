import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_SCHEMA_KEYS, buildEnvParseInput, validateConfig } from './validate';

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
  DATABASE_URL_APP: 'postgresql://breeze_app:request-secret@localhost:5432/breeze',
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
  PARTNER_API_CURSOR_SIGNING_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'prod-test-release-manifest-public-key',
  // Production-required (#570 defense-in-depth): explicit boolean keeps the
  // many "production happy-path" tests below from tripping the new check.
  // Tests that assert the missing/invalid IS_HOSTED throw override this.
  IS_HOSTED: 'true',
  // Production-required (Wave 3 live authorization): the event-socket
  // permission epoch mode must be declared explicitly so a rolling deploy
  // never guesses its compatibility posture. Tests that assert the
  // missing/invalid throw override this.
  EVENT_PERMISSION_EPOCH_MODE: 'compat',
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

  it('does not require IP classification provider configuration', () => {
    const previousProvider = process.env.IP_CLASSIFY_PROVIDER;
    const previousKey = process.env.IP_CLASSIFY_API_KEY;
    delete process.env.IP_CLASSIFY_PROVIDER;
    delete process.env.IP_CLASSIFY_API_KEY;
    try {
      withEnv(validEnv, () => expect(() => validateConfig()).not.toThrow());
    } finally {
      if (previousProvider === undefined) delete process.env.IP_CLASSIFY_PROVIDER;
      else process.env.IP_CLASSIFY_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.IP_CLASSIFY_API_KEY;
      else process.env.IP_CLASSIFY_API_KEY = previousKey;
    }
  });

  it('accepts terminal preparation only when browser transitions are enforced', () => {
    withEnv({
      ...validEnv,
      AUTH_BROWSER_TRANSITIONS_ENFORCED: 'true',
      AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED: 'true',
    }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it('rejects terminal preparation when browser transitions are not enforced', () => {
    withEnv({
      ...validEnv,
      AUTH_BROWSER_TRANSITIONS_ENFORCED: 'false',
      AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow(
        /AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED.*AUTH_BROWSER_TRANSITIONS_ENFORCED/,
      );
    });
  });

  it.each([
    'trusted.cloudflareaccess.com@evil.example',
    'trusted.cloudflareaccess.com:443',
    'trusted.cloudflareaccess.com/path',
    'trusted.cloudflareaccess.com?next=evil',
    'trusted.cloudflareaccess.com#fragment',
    'trusted.cloudflareaccess.com.evil.example',
    'evil.example',
    'TRUSTED.cloudflareaccess.com',
    'trusted.cloudflareaccess.com.',
  ])('rejects non-canonical or untrusted CF Access team domain %s', (teamDomain) => {
    withEnv({
      ...validEnv,
      CF_ACCESS_TRUST_ENABLED: 'true',
      CF_ACCESS_TEAM_DOMAIN: teamDomain,
      CF_ACCESS_AUD: 'aud-app-1234567890abcdef',
    }, () => {
      expect(() => validateConfig()).toThrow(/CF_ACCESS_TEAM_DOMAIN/);
    });
  });

  it('accepts a canonical lowercase Cloudflare Access team hostname', () => {
    withEnv({
      ...validEnv,
      CF_ACCESS_TRUST_ENABLED: 'true',
      CF_ACCESS_TEAM_DOMAIN: 'trusted-team.cloudflareaccess.com',
      CF_ACCESS_AUD: 'aud-app-1234567890abcdef',
    }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it.each([
    ['AUTH_BROWSER_TRANSITIONS_ENFORCED', 'enabled'],
    ['AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED', 'enabled'],
  ])('rejects an invalid boolean rollout value for %s', (key, value) => {
    withEnv({ ...validEnv, [key]: value }, () => {
      expect(() => validateConfig()).toThrow(new RegExp(key));
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

  it('accepts a dedicated base64-encoded 32-byte partner export cursor key in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      const config = validateConfig();
      expect(config.PARTNER_API_CURSOR_SIGNING_KEY).toBe(validEnv.PARTNER_API_CURSOR_SIGNING_KEY);
    });
  });

  it('rejects a missing partner export cursor signing key in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      PARTNER_API_CURSOR_SIGNING_KEY: '',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('PARTNER_API_CURSOR_SIGNING_KEY');
    });
  });

  it('rejects invalid or shorter-than-32-byte partner export cursor keys in production', () => {
    for (const key of ['not valid base64***', Buffer.alloc(31, 7).toString('base64')]) {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        PARTNER_API_CURSOR_SIGNING_KEY: key,
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
      }, () => {
        expect(() => validateConfig()).toThrow('PARTNER_API_CURSOR_SIGNING_KEY');
        expect(() => validateConfig()).toThrow('32 bytes');
      });
    }
  });

  it('rejects reusing JWT_SECRET as the partner export cursor signing key', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      JWT_SECRET: validEnv.PARTNER_API_CURSOR_SIGNING_KEY,
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('must not reuse secret material');
      expect(() => validateConfig()).toThrow('PARTNER_API_CURSOR_SIGNING_KEY');
    });
  });

  it('rejects cursor bytes that equal UTF-8 JWT_SECRET despite different encodings', () => {
    const jwtSecret = '0123456789abcdef0123456789ABCDEF';
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      JWT_SECRET: jwtSecret,
      PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from(jwtSecret, 'utf8').toString('base64'),
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow('PARTNER_API_CURSOR_SIGNING_KEY');
      expect(() => validateConfig()).toThrow('JWT_SECRET key material');
    });
  });

  describe('M365 customer Graph-read onboarding', () => {
    const descriptorEnv = (signingJwkFile: string) => ({
      M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'true',
      M365_CUSTOMER_GRAPH_READ_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
      M365_CUSTOMER_GRAPH_READ_VAULT_REF:
        'akv://customer-vault.vault.azure.net/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
      M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION: '0123456789abcdef0123456789abcdef',
      M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS: '11111111-1111-4111-8111-111111111111',
      M365_GRAPH_READ_EXECUTOR_URL: 'https://m365-graph-read.internal.example.test',
      M365_GRAPH_READ_EXECUTOR_AUDIENCE: 'm365-graph-read-executor',
      M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: signingJwkFile,
      M365_GRAPH_READ_EXECUTOR_SIGNING_KID: 'graph-read-api-1',
      PUBLIC_URL: 'https://console.example.test',
    });

    it('refuses boot when onboarding is enabled without a complete descriptor', () => {
      withEnv({
        ...validEnv,
        M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'true',
        M365_CUSTOMER_GRAPH_READ_CLIENT_ID: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/M365_CUSTOMER_GRAPH_READ_CLIENT_ID/);
      });
    });

    it('validates the complete descriptor at boot when onboarding is enabled', () => {
      const dir = mkdtempSync(join(tmpdir(), 'breeze-m365-boot-'));
      const signingJwkFile = join(dir, 'signing.jwk');
      writeFileSync(signingJwkFile, JSON.stringify({
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
        use: 'sig',
        kid: 'graph-read-api-1',
        x: Buffer.alloc(32, 1).toString('base64url'),
        d: Buffer.alloc(32, 2).toString('base64url'),
      }), { mode: 0o600 });
      chmodSync(signingJwkFile, 0o600);

      try {
        withEnv({ ...validEnv, ...descriptorEnv(signingJwkFile) }, () => {
          expect(() => validateConfig()).not.toThrow();
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not require or parse descriptor fields when onboarding is disabled', () => {
      withEnv({
        ...validEnv,
        M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED: 'false',
        M365_CUSTOMER_GRAPH_READ_CLIENT_ID: 'not-a-uuid',
        M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: '/missing/signing.jwk',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
  });

  describe('M365 customer Graph-actions onboarding + reveal key', () => {
    it('refuses boot when actions onboarding is enabled without a complete descriptor', () => {
      withEnv({
        ...validEnv,
        M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED: 'true',
        M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID/);
      });
    });

    it('requires APP_ENCRYPTION_KEY_ID when write-action tools are enabled', () => {
      // Tools-enabled boot also validates the full actions executor descriptor
      // (Task 4's validateM365CustomerGraphActionsRuntimeConfigAtBoot) — supply
      // a complete, valid descriptor here so this test isolates the
      // APP_ENCRYPTION_KEY_ID rule rather than tripping the descriptor check.
      //
      // Since #3374 the key-id rule lives in the schema superRefine, so it now
      // fires during safeParse — BEFORE the descriptor validator rather than
      // after it. The descriptor below is therefore no longer load-bearing for
      // this assertion; it is kept so the test still fails for the RIGHT reason
      // if the rule ever moves back to a post-parse position.
      const dir = mkdtempSync(join(tmpdir(), 'breeze-m365-actions-boot-'));
      const signingJwkFile = join(dir, 'signing.jwk');
      writeFileSync(signingJwkFile, JSON.stringify({
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
        use: 'sig',
        kid: 'graph-actions-api-1',
        x: Buffer.alloc(32, 1).toString('base64url'),
        d: Buffer.alloc(32, 2).toString('base64url'),
      }), { mode: 0o600 });
      chmodSync(signingJwkFile, 0o600);

      try {
        withEnv({
          ...validEnv,
          M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true',
          M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: '*',
          M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
          M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION: '0123456789abcdef0123456789abcdef',
          M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF:
            'akv://customer-vault.vault.azure.net/m365-customer-graph-actions/0123456789abcdef0123456789abcdef',
          M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://m365-graph-actions.internal.example.test',
          M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE: 'm365-graph-actions-executor',
          M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: signingJwkFile,
          M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID: 'graph-actions-api-1',
          PUBLIC_URL: 'https://console.example.test',
          APP_ENCRYPTION_KEY_ID: '',
        }, () => {
          expect(() => validateConfig()).toThrow(/APP_ENCRYPTION_KEY_ID/);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('M365 communications-delegated (comms) boot validation', () => {
    it('fails boot when comms onboarding is enabled without a client id', () => {
      withEnv({
        ...validEnv,
        M365_COMMS_ONBOARDING_ENABLED: 'true',
        M365_COMMS_CLIENT_ID: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/M365_COMMS_CLIENT_ID is required/);
      });
    });

    it('fails boot when comms tools are enabled without a user allowlist', () => {
      // The loader never reads the tools allowlist (it's on the hot
      // tool-registration path), so the boot validator must check it
      // explicitly — this proves the call site in validate.ts is wired.
      const dir = mkdtempSync(join(tmpdir(), 'breeze-m365-comms-boot-'));
      const signingJwkFile = join(dir, 'signing.jwk');
      writeFileSync(signingJwkFile, JSON.stringify({
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'EdDSA',
        use: 'sig',
        kid: 'comms-kid-1',
        x: Buffer.alloc(32, 1).toString('base64url'),
        d: Buffer.alloc(32, 2).toString('base64url'),
      }), { mode: 0o600 });
      chmodSync(signingJwkFile, 0o600);

      try {
        withEnv({
          ...validEnv,
          M365_COMMS_TOOLS_ENABLED: 'true',
          M365_COMMS_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
          M365_COMMS_EXECUTOR_URL: 'https://comms-executor.internal.example.test',
          M365_COMMS_EXECUTOR_AUDIENCE: 'm365-communications-executor',
          M365_COMMS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: signingJwkFile,
          M365_COMMS_EXECUTOR_SIGNING_KID: 'comms-kid-1',
          PUBLIC_URL: 'https://console.example.test',
        }, () => {
          expect(() => validateConfig()).toThrow(/M365_COMMS_TOOLS_USER_IDS/);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('rejects production with only the administrator DATABASE_URL', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      DATABASE_URL_APP: '',
      BREEZE_APP_DB_PASSWORD: '',
      POSTGRES_PASSWORD: '',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(() => validateConfig()).toThrow(
        /DATABASE_URL_APP.*BREEZE_APP_DB_PASSWORD.*POSTGRES_PASSWORD/i,
      );
    });
  });

  it.each([
    ['DATABASE_URL_APP', 'postgresql://breeze_app:request-secret@localhost:5432/breeze'],
    ['BREEZE_APP_DB_PASSWORD', 'request-secret'],
    ['POSTGRES_PASSWORD', 'request-secret'],
  ] as const)('accepts the %s request-role credential path in production', (key, value) => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      DATABASE_URL_APP: '',
      BREEZE_APP_DB_PASSWORD: '',
      POSTGRES_PASSWORD: '',
      [key]: value,
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      expect(validateConfig()[key]).toBe(value);
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

  describe('BINARY_GITHUB_REPOSITORY (BYO signing, spec 3a)', () => {
    const prodBase = {
      ...validEnv,
      NODE_ENV: 'production' as const,
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    };

    it('refuses to boot on a malformed repository in any environment', () => {
      withEnv({ ...validEnv, BINARY_GITHUB_REPOSITORY: 'not-a-repo' }, () => {
        expect(() => validateConfig()).toThrow(/BINARY_GITHUB_REPOSITORY/);
      });
    });

    it('refuses to boot on a malformed legacy GITHUB_REPO alias in any environment', () => {
      withEnv({ ...validEnv, GITHUB_REPO: 'not-a-repo' }, () => {
        expect(() => validateConfig()).toThrow(/GITHUB_REPO/);
      });
    });

    it('treats an empty string (compose ${VAR:-} interpolation) as unset', () => {
      withEnv({ ...validEnv, BINARY_GITHUB_REPOSITORY: '' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('production: overriding the release source requires the manifest trust root', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_GITHUB_REPOSITORY: 'acme/breeze-selfhost-signing',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
          BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
        },
        () => {
          expect(() => validateConfig()).toThrow(/BINARY_GITHUB_REPOSITORY/);
        },
      );
    });

    it('production: overriding via legacy GITHUB_REPO requires the manifest trust root', () => {
      withEnv(
        {
          ...prodBase,
          GITHUB_REPO: 'acme/breeze-selfhost-signing',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
          BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
        },
        () => {
          expect(() => validateConfig()).toThrow(/overrides the release source/);
        },
      );
    });

    it('production: override boots when the trust root is set to the self-hoster key', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_GITHUB_REPOSITORY: 'acme/breeze-selfhost-signing',
          // A key that is NOT the official one — what the signing workflow's
          // run summary actually prints.
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'kR2Ql8tXvN4mJ7cB1aZfP0sYuE6dW3gH9iL5nO8rT2A=',
        },
        () => {
          expect(() => validateConfig()).not.toThrow();
        },
      );
    });

    // deploy/.env.example ships the official key as an ACTIVE line directly
    // above the BINARY_GITHUB_REPOSITORY hint, so repointing while leaving it
    // in place is the DEFAULT mistake. It used to satisfy the "trust root is
    // set" rule (which only tested non-empty), boot clean, and then fail every
    // sync closed — freezing the fleet behind one console.error.
    it('production: override with ONLY the official key is rejected at boot', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_GITHUB_REPOSITORY: 'acme/breeze-selfhost-signing',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=',
        },
        () => {
          expect(() => validateConfig()).toThrow(/still \(only\) the official Breeze key/);
        },
      );
    });

    it('production: legacy GITHUB_REPO override with ONLY the official key is rejected too', () => {
      withEnv(
        {
          ...prodBase,
          GITHUB_REPO: 'acme/breeze-selfhost-signing',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=',
        },
        () => {
          expect(() => validateConfig()).toThrow(/still \(only\) the official Breeze key/);
        },
      );
    });

    // Keeping the official key alongside your own is legitimate: it lets an
    // instance verify official releases during a migration.
    it('production: override boots when the official key is present ALONGSIDE the self-hoster key', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_GITHUB_REPOSITORY: 'acme/breeze-selfhost-signing',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS:
            'yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=,kR2Ql8tXvN4mJ7cB1aZfP0sYuE6dW3gH9iL5nO8rT2A=',
        },
        () => {
          expect(() => validateConfig()).not.toThrow();
        },
      );
    });

    // The official repository is not an "override" — the official key is
    // exactly right there, and this must keep booting.
    it('production: official repository with the official key is unaffected', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_GITHUB_REPOSITORY: 'lanternops/breeze',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=',
        },
        () => {
          expect(() => validateConfig()).not.toThrow();
        },
      );
    });

    it.each([
      ['owner/..', 'dot-dot repository segment'],
      ['owner/.', 'single-dot repository segment'],
    ])('rejects %s (%s) — the pattern alone allows it', (value) => {
      withEnv({ ...prodBase, BINARY_GITHUB_REPOSITORY: value }, () => {
        expect(() => validateConfig()).toThrow(/BINARY_GITHUB_REPOSITORY/);
      });
    });

    it('treats an empty legacy GITHUB_REPO as unset (compose always injects the key)', () => {
      withEnv({ ...prodBase, GITHUB_REPO: '' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
  });

  describe('BINARY_EDITION (hosted fail-closed)', () => {
    const prodBase = {
      ...validEnv,
      NODE_ENV: 'production' as const,
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    };

    it('default (unset) boots unchanged in development', () => {
      withEnv(validEnv, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('default (unset) boots unchanged in production', () => {
      withEnv(prodBase, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('BINARY_EDITION=self-host boots unchanged in production', () => {
      withEnv({ ...prodBase, BINARY_EDITION: 'self-host' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('BINARY_EDITION=hosted has no effect in development (production-only rule)', () => {
      withEnv({ ...validEnv, BINARY_EDITION: 'hosted', BINARY_SOURCE: 'github' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('production: BINARY_EDITION=hosted with BINARY_SOURCE=github refuses to boot', () => {
      withEnv(
        { ...prodBase, BINARY_EDITION: 'hosted', BINARY_SOURCE: 'github' },
        () => {
          expect(() => validateConfig()).toThrow(/BINARY_EDITION=hosted requires BINARY_SOURCE=local/);
        },
      );
    });

    it('production: BINARY_EDITION=hosted with BINARY_SOURCE unset (defaults to github) refuses to boot', () => {
      withEnv(
        { ...prodBase, BINARY_EDITION: 'hosted' },
        () => {
          expect(() => validateConfig()).toThrow(/BINARY_EDITION=hosted requires BINARY_SOURCE=local/);
        },
      );
    });

    it('production: BINARY_EDITION=hosted with BINARY_SOURCE=local but no manifest trust root refuses to boot', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_EDITION: 'hosted',
          BINARY_SOURCE: 'local',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
          BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: '',
        },
        () => {
          expect(() => validateConfig()).toThrow(/BINARY_EDITION=hosted requires RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS/);
        },
      );
    });

    it('production: BINARY_EDITION=hosted with BINARY_SOURCE=local and a trust root boots cleanly', () => {
      withEnv(
        {
          ...prodBase,
          BINARY_EDITION: 'hosted',
          BINARY_SOURCE: 'local',
          RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: 'yzx8ftmcls6uBetFC5SYnZhBo+cbur3IX50TbBthTso=',
        },
        () => {
          expect(() => validateConfig()).not.toThrow();
        },
      );
    });
  });

  describe('AGENT_BACKUP_SERVER_URL', () => {
    it('accepts a valid https URL', () => {
      withEnv({ ...validEnv, AGENT_BACKUP_SERVER_URL: 'https://new.example.com' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('accepts http for localhost (dev)', () => {
      withEnv({ ...validEnv, AGENT_BACKUP_SERVER_URL: 'http://localhost:3001' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('refuses http for non-localhost', () => {
      withEnv({ ...validEnv, AGENT_BACKUP_SERVER_URL: 'http://new.example.com' }, () => {
        expect(() => validateConfig()).toThrow('AGENT_BACKUP_SERVER_URL');
      });
    });

    it('refuses a malformed value (never silently ignored)', () => {
      withEnv({ ...validEnv, AGENT_BACKUP_SERVER_URL: 'not a url' }, () => {
        expect(() => validateConfig()).toThrow('AGENT_BACKUP_SERVER_URL');
      });
    });

    it('unset is fine', () => {
      withEnv({ ...validEnv, AGENT_BACKUP_SERVER_URL: '' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
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

  it('warns when proxy trust is on but TRUST_CF_CONNECTING_IP is off in production (SR2-16)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    }, () => {
      validateConfig();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('TRUST_CF_CONNECTING_IP')
      );
    });
    warnSpy.mockRestore();
  });

  it('does not warn about TRUST_CF_CONNECTING_IP when it is enabled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
      TRUST_CF_CONNECTING_IP: 'true',
    }, () => {
      validateConfig();
      const cfWarnings = warnSpy.mock.calls
        .flat()
        .filter((m) => typeof m === 'string' && m.includes('TRUST_CF_CONNECTING_IP'));
      expect(cfWarnings).toHaveLength(0);
    });
    warnSpy.mockRestore();
  });

  it('accepts optional Stripe env vars (API-key model — no Connect OAuth)', () => {
    withEnv({
      ...validEnv,
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_x',
    }, () => {
      const config = validateConfig();
      expect(config.STRIPE_SECRET_KEY).toBe('sk_test_x');
      expect(config.STRIPE_WEBHOOK_SECRET).toBe('whsec_test_x');
    });
  });

  it('boots without any Stripe env (feature dormant)', () => {
    withEnv(validEnv, () => {
      expect(() => validateConfig()).not.toThrow();
    });
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

  // ---- Security remediation Wave 5, Task 6 — agent certificate/device
  // binding mode --------------------------------------------------------
  describe('AGENT_MTLS_BINDING_MODE', () => {
    it('defaults to off when unset', () => {
      withEnv(validEnv, () => {
        const config = validateConfig();
        expect(config.AGENT_MTLS_BINDING_MODE).toBe('off');
      });
    });

    it('accepts audit', () => {
      withEnv({ ...validEnv, AGENT_MTLS_BINDING_MODE: 'audit' }, () => {
        const config = validateConfig();
        expect(config.AGENT_MTLS_BINDING_MODE).toBe('audit');
      });
    });

    it('accepts enforce', () => {
      withEnv({ ...validEnv, AGENT_MTLS_BINDING_MODE: 'enforce' }, () => {
        const config = validateConfig();
        expect(config.AGENT_MTLS_BINDING_MODE).toBe('enforce');
      });
    });

    it('boot-refuses an invalid value instead of silently falling back', () => {
      withEnv({ ...validEnv, AGENT_MTLS_BINDING_MODE: 'bogus' }, () => {
        expect(() => validateConfig()).toThrow('AGENT_MTLS_BINDING_MODE');
      });
    });

    it('an absent value keeps production booting (default stays off)', () => {
      withEnv({ ...validEnv, NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.breeze.io', TRUST_PROXY_HEADERS: 'false' }, () => {
        const config = validateConfig();
        expect(config.AGENT_MTLS_BINDING_MODE).toBe('off');
      });
    });
  });

  // ---- Security remediation Wave 6, Task 9 — agent manifest-signing-key-ID
  // compatibility control. Explicit boolean: only 'true'/'false' are valid,
  // default 'false'. This is one of the two variables Task 9 owns. Declaring it
  // in envSchema is now sufficient to validate it — validateConfig() derives its
  // parse input from the schema (#2896). It used to also require a matching
  // entry in a hand-maintained pick list, and a missing entry meant the value
  // silently never reached the parser.
  describe('AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID', () => {
    it('defaults to false when unset', () => {
      withEnv(validEnv, () => {
        const config = validateConfig();
        expect(config.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID).toBe('false');
      });
    });

    it('accepts an explicit false', () => {
      withEnv({ ...validEnv, AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID: 'false' }, () => {
        const config = validateConfig();
        expect(config.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID).toBe('false');
      });
    });

    it('accepts an explicit true', () => {
      withEnv({ ...validEnv, AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID: 'true' }, () => {
        const config = validateConfig();
        expect(config.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID).toBe('true');
      });
    });

    // Also guards the exact bug class named in the task: a value that never
    // reaches the parser is undefined at parse time, so the schema default
    // silently wins and an invalid value is accepted at boot instead of
    // refusing to start. A bare `.toThrow()` regression-guard variant of this
    // test would add nothing beyond the message assertion below, since a thrown
    // error already proves the value reached the parser — so only one test.
    it('boot-refuses an invalid value instead of silently falling back to false', () => {
      withEnv({ ...validEnv, AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID: 'yes' }, () => {
        expect(() => validateConfig()).toThrow('AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID');
      });
    });

    it('an absent value keeps production booting (default stays false)', () => {
      withEnv({ ...validEnv, NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.breeze.io', TRUST_PROXY_HEADERS: 'false' }, () => {
        const config = validateConfig();
        expect(config.AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID).toBe('false');
      });
    });
  });

  // ---- Security remediation Wave 6, Task 9 (approved deviation D1) —
  // managed-software destination policy mode. compat is the default and the
  // safe state (Task 5 always fails closed on a private destination for a
  // capability-0 device); enforce is the fleet-upgraded end state.
  describe('MANAGED_SOFTWARE_POLICY_MODE', () => {
    it('defaults to compat when unset', () => {
      withEnv(validEnv, () => {
        const config = validateConfig();
        expect(config.MANAGED_SOFTWARE_POLICY_MODE).toBe('compat');
      });
    });

    it('accepts an explicit compat', () => {
      withEnv({ ...validEnv, MANAGED_SOFTWARE_POLICY_MODE: 'compat' }, () => {
        const config = validateConfig();
        expect(config.MANAGED_SOFTWARE_POLICY_MODE).toBe('compat');
      });
    });

    it('accepts enforce', () => {
      withEnv({ ...validEnv, MANAGED_SOFTWARE_POLICY_MODE: 'enforce' }, () => {
        const config = validateConfig();
        expect(config.MANAGED_SOFTWARE_POLICY_MODE).toBe('enforce');
      });
    });

    // Also guards the same drift bug class as
    // AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID above (see that describe block's
    // comment): a value that stops reaching the parser boots silently on the
    // schema default instead of refusing. A bare `.toThrow()` regression-guard
    // variant would add nothing over the message assertion below, so only one
    // test.
    it('boot-refuses an invalid value instead of silently falling back to compat', () => {
      withEnv({ ...validEnv, MANAGED_SOFTWARE_POLICY_MODE: 'strict' }, () => {
        expect(() => validateConfig()).toThrow('MANAGED_SOFTWARE_POLICY_MODE');
      });
    });

    it('an absent value keeps production booting (default stays compat)', () => {
      withEnv({ ...validEnv, NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://app.breeze.io', TRUST_PROXY_HEADERS: 'false' }, () => {
        const config = validateConfig();
        expect(config.MANAGED_SOFTWARE_POLICY_MODE).toBe('compat');
      });
    });
  });

  // ---- Security remediation Wave 5, Task 8 (TRANSPORT-001) — canonical
  // PUBLIC_API_URL form, required only when FORCE_HTTPS=true --------------
  describe('PUBLIC_API_URL canonical form (gated on FORCE_HTTPS)', () => {
    it('is not required when FORCE_HTTPS is unset — does not retroactively boot-refuse existing deployments', () => {
      withEnv(validEnv, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('is not required when FORCE_HTTPS is explicitly false', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: 'false' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('boot-refuses when FORCE_HTTPS=true and PUBLIC_API_URL is missing', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: 'true' }, () => {
        expect(() => validateConfig()).toThrow('PUBLIC_API_URL');
      });
    });

    it('boot-refuses when FORCE_HTTPS=1 and PUBLIC_API_URL is missing (accepts the "1" truthy form too)', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: '1' }, () => {
        expect(() => validateConfig()).toThrow('PUBLIC_API_URL');
      });
    });

    it('boot-refuses a non-https PUBLIC_API_URL when FORCE_HTTPS=true', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: 'true', PUBLIC_API_URL: 'http://api.example.com' }, () => {
        expect(() => validateConfig()).toThrow('PUBLIC_API_URL');
      });
    });

    it('boot-refuses a PUBLIC_API_URL with embedded userinfo when FORCE_HTTPS=true', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: 'true', PUBLIC_API_URL: 'https://user:pass@api.example.com' }, () => {
        expect(() => validateConfig()).toThrow('PUBLIC_API_URL');
      });
    });

    it('boot-refuses a PUBLIC_API_URL with a query string when FORCE_HTTPS=true', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: 'true', PUBLIC_API_URL: 'https://api.example.com?x=1' }, () => {
        expect(() => validateConfig()).toThrow('PUBLIC_API_URL');
      });
    });

    it('boot-refuses a PUBLIC_API_URL with a fragment when FORCE_HTTPS=true', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: 'true', PUBLIC_API_URL: 'https://api.example.com#section' }, () => {
        expect(() => validateConfig()).toThrow('PUBLIC_API_URL');
      });
    });

    it('boot-refuses a malformed PUBLIC_API_URL when FORCE_HTTPS=true', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: 'true', PUBLIC_API_URL: 'not a url' }, () => {
        expect(() => validateConfig()).toThrow('PUBLIC_API_URL');
      });
    });

    it('accepts a canonical https PUBLIC_API_URL when FORCE_HTTPS=true', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        FORCE_HTTPS: 'true',
        PUBLIC_API_URL: 'https://api.breeze.example.com',
      }, () => {
        const config = validateConfig();
        expect(config.PUBLIC_API_URL).toBe('https://api.breeze.example.com');
      });
    });

    it('accepts a canonical https PUBLIC_API_URL with a non-default port when FORCE_HTTPS=true', () => {
      withEnv({ ...validEnv, FORCE_HTTPS: 'true', PUBLIC_API_URL: 'https://api.example.com:8443' }, () => {
        const config = validateConfig();
        expect(config.PUBLIC_API_URL).toBe('https://api.example.com:8443');
      });
    });
  });

  // ---- OAuth DCR (Dynamic Client Registration) hardening (Task 21) -------
  // When DCR is on in production it must declare an anti-spam posture: EITHER
  // gate registration behind an initial-access-token (OAUTH_DCR_REQUIRE_IAT)
  // OR deliberately allow anonymous DCR (OAUTH_DCR_ALLOW_ANONYMOUS — required
  // for public MCP clients like Claude, which cannot supply an IAT). Boot must
  // refuse only when DCR is enabled with neither posture chosen.
  describe('OAuth DCR config validation', () => {
    it('refuses boot in production when OAUTH_DCR_ENABLED=true with neither IAT nor anonymous posture', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        OAUTH_DCR_ENABLED: 'true',
        OAUTH_DCR_REQUIRE_IAT: '',
        OAUTH_DCR_ALLOW_ANONYMOUS: '',
      }, () => {
        expect(() => validateConfig()).toThrow(/OAUTH_DCR_REQUIRE_IAT|OAUTH_DCR_ALLOW_ANONYMOUS/i);
      });
    });

    it('boots in production when OAUTH_DCR_ENABLED=true and OAUTH_DCR_ALLOW_ANONYMOUS=true (public MCP posture)', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        OAUTH_DCR_ENABLED: 'true',
        OAUTH_DCR_REQUIRE_IAT: '',
        OAUTH_DCR_ALLOW_ANONYMOUS: 'true',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // Security invariant: the posture flags are an explicit truthy-allowlist,
    // NOT a mere presence/non-empty check. A non-empty-but-falsy value must
    // still count as "no posture chosen" and boot-refuse — otherwise a
    // `OAUTH_DCR_ALLOW_ANONYMOUS=false` deploy would silently open an ungated
    // POST /oauth/reg, the exact misconfig this gate exists to prevent.
    it.each(['false', '0', 'no', 'off', 'disabled'])(
      'refuses boot in production when OAUTH_DCR_ALLOW_ANONYMOUS=%s (falsy) and no IAT',
      (falsyValue) => {
        withEnv({
          ...validEnv,
          NODE_ENV: 'production',
          CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
          TRUST_PROXY_HEADERS: 'true',
          OAUTH_DCR_ENABLED: 'true',
          OAUTH_DCR_REQUIRE_IAT: '',
          OAUTH_DCR_ALLOW_ANONYMOUS: falsyValue,
        }, () => {
          expect(() => validateConfig()).toThrow(/OAUTH_DCR_REQUIRE_IAT|OAUTH_DCR_ALLOW_ANONYMOUS/i);
        });
      },
    );

    // Availability: the truthy aliases accepted for the sibling flags must
    // also boot the public-MCP posture, so an operator setting `=1`/`yes`/`on`
    // doesn't hit a surprise boot-refuse on the exact config this feature ships.
    it.each(['1', 'yes', 'on'])(
      'boots in production when OAUTH_DCR_ALLOW_ANONYMOUS=%s (truthy alias)',
      (truthyValue) => {
        withEnv({
          ...validEnv,
          NODE_ENV: 'production',
          CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
          TRUST_PROXY_HEADERS: 'true',
          OAUTH_DCR_ENABLED: 'true',
          OAUTH_DCR_REQUIRE_IAT: '',
          OAUTH_DCR_ALLOW_ANONYMOUS: truthyValue,
        }, () => {
          expect(() => validateConfig()).not.toThrow();
        });
      },
    );

    it('boots in production when BOTH OAUTH_DCR_REQUIRE_IAT and OAUTH_DCR_ALLOW_ANONYMOUS are true (IAT wins at provider)', () => {
      withEnv({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
        TRUST_PROXY_HEADERS: 'true',
        OAUTH_DCR_ENABLED: 'true',
        OAUTH_DCR_REQUIRE_IAT: 'true',
        OAUTH_DCR_ALLOW_ANONYMOUS: 'true',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
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

  // ---- Wave 3 live-authorization rollout controls -------------------------
  // OAUTH_AUTH_EPOCH_ENFORCE_AFTER and EVENT_PERMISSION_EPOCH_MODE decide how
  // long pre-Wave-3 OAuth tokens and version-one event tickets keep working.
  // Both refusals live here rather than in config/env.ts: env.ts is imported
  // by this validator, by jobs, by seeds and by scripts, so a module-scope
  // throw there would preempt this aggregated report and take down unrelated
  // processes that never touch OAuth or event sockets.
  describe('live authorization rollout config', () => {
    const prodEnv = {
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
      TRUST_PROXY_HEADERS: 'true',
    };

    it('refuses boot in production when EVENT_PERMISSION_EPOCH_MODE is missing', () => {
      withEnv({ ...prodEnv, EVENT_PERMISSION_EPOCH_MODE: '' }, () => {
        expect(() => validateConfig()).toThrow(/EVENT_PERMISSION_EPOCH_MODE/i);
      });
    });

    it.each(['compat', 'enforce'])(
      'boots in production with EVENT_PERMISSION_EPOCH_MODE=%s',
      (mode) => {
        withEnv({ ...prodEnv, EVENT_PERMISSION_EPOCH_MODE: mode }, () => {
          expect(() => validateConfig()).not.toThrow();
        });
      },
    );

    // Shape is enforced in EVERY environment — an unrecognized mode would
    // otherwise fall back to the closed value at import and silently change
    // ticket acceptance.
    it.each(['development', 'production'])(
      'refuses boot in %s when EVENT_PERMISSION_EPOCH_MODE is not compat or enforce',
      (nodeEnv) => {
        withEnv({ ...prodEnv, NODE_ENV: nodeEnv, EVENT_PERMISSION_EPOCH_MODE: 'strict' }, () => {
          expect(() => validateConfig()).toThrow(/EVENT_PERMISSION_EPOCH_MODE must be compat or enforce/i);
        });
      },
    );

    it('refuses boot in production when MCP_OAUTH_ENABLED=true and OAUTH_AUTH_EPOCH_ENFORCE_AFTER is missing', () => {
      withEnv({ ...prodEnv, MCP_OAUTH_ENABLED: 'true', OAUTH_AUTH_EPOCH_ENFORCE_AFTER: '' }, () => {
        expect(() => validateConfig()).toThrow(/OAUTH_AUTH_EPOCH_ENFORCE_AFTER/i);
      });
    });

    it('does not require OAUTH_AUTH_EPOCH_ENFORCE_AFTER when OAuth is disabled', () => {
      withEnv({ ...prodEnv, MCP_OAUTH_ENABLED: 'false', OAUTH_AUTH_EPOCH_ENFORCE_AFTER: '' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    // A local timestamp would move the compatibility boundary with the host
    // timezone, so an explicit UTC/offset suffix is mandatory everywhere.
    it.each(['development', 'production'])(
      'refuses boot in %s when OAUTH_AUTH_EPOCH_ENFORCE_AFTER has no UTC/offset suffix',
      (nodeEnv) => {
        withEnv({
          ...prodEnv,
          NODE_ENV: nodeEnv,
          OAUTH_AUTH_EPOCH_ENFORCE_AFTER: '2026-08-06T00:30:00',
        }, () => {
          expect(() => validateConfig()).toThrow(/OAUTH_AUTH_EPOCH_ENFORCE_AFTER/i);
        });
      },
    );

    it('accepts an absolute UTC OAUTH_AUTH_EPOCH_ENFORCE_AFTER in production', () => {
      withEnv({
        ...prodEnv,
        MCP_OAUTH_ENABLED: 'true',
        OAUTH_JWKS_PRIVATE_JWK: '{"kty":"oct"}',
        OAUTH_COOKIE_SECRET: 'prod-test-oauth-cookie-secret-32-chars-min-strong-random',
        OAUTH_AUTH_EPOCH_ENFORCE_AFTER: '2026-08-06T00:30:00Z',
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
        // Wave 3: enabling OAuth in production also requires the absolute
        // auth-epoch compatibility deadline. Asserted on its own in the
        // "live authorization rollout config" suite above.
        OAUTH_AUTH_EPOCH_ENFORCE_AFTER: '2026-08-06T00:30:00Z',
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

    it('MSI_SIGNING_URL is inert: production boots without MSI_SIGNING_CF_ACCESS_SECRET', () => {
      withEnv({
        ...prodBase,
        MSI_SIGNING_URL: 'https://sign.example.com/sign-breeze-agent',
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

  // #1412: ANTHROPIC_BASE_URL lets a self-hosted operator point the AI Agent
  // at an Anthropic-compatible /v1/messages backend (vLLM / LiteLLM). It must
  // be a well-formed http(s) URL, and is FAIL-CLOSED: honored only when
  // self-host is affirmatively declared (IS_HOSTED explicitly false/0/no/off).
  // Unset / empty / garbage / truthy IS_HOSTED all refuse it, so a stray value
  // or an unmapped IS_HOSTED (the #570 footgun) can never redirect AI traffic.
  describe('ANTHROPIC_BASE_URL (#1412)', () => {
    it.each(['false', '0', 'no', 'off'])(
      'accepts a well-formed http(s) base URL when self-host is declared (IS_HOSTED=%j)',
      (isHosted) => {
        withEnv({ ...validEnv, IS_HOSTED: isHosted, ANTHROPIC_BASE_URL: 'http://localhost:8000' }, () => {
          expect(validateConfig().ANTHROPIC_BASE_URL).toBe('http://localhost:8000');
        });
      },
    );

    it('accepts an https URL with a port and path on a self-hosted deployment', () => {
      withEnv({ ...validEnv, IS_HOSTED: 'false', ANTHROPIC_BASE_URL: 'https://litellm.internal:8443/v1' }, () => {
        expect(validateConfig().ANTHROPIC_BASE_URL).toBe('https://litellm.internal:8443/v1');
      });
    });

    it('allows ANTHROPIC_BASE_URL unset on the hosted platform', () => {
      withEnv({ ...validEnv, IS_HOSTED: 'true' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it.each(['', '   '])(
      'treats an empty/whitespace ANTHROPIC_BASE_URL as unset (no error, no value) (%j)',
      (value) => {
        withEnv({ ...validEnv, IS_HOSTED: 'true', ANTHROPIC_BASE_URL: value }, () => {
          // Empty/whitespace short-circuits before the fail-closed gate even on
          // a hosted deploy — it is "unset", not a misconfig.
          expect(() => validateConfig()).not.toThrow();
        });
      },
    );

    it.each(['ftp://example.com', 'not-a-url', 'ws://localhost:8000'])(
      'rejects a non-http(s) ANTHROPIC_BASE_URL (%j)',
      (value) => {
        withEnv({ ...validEnv, IS_HOSTED: 'false', ANTHROPIC_BASE_URL: value }, () => {
          expect(() => validateConfig()).toThrow('ANTHROPIC_BASE_URL');
        });
      },
    );

    // Fail-closed: every non-affirmative-self-host IS_HOSTED value must refuse a
    // set base URL. 'true'/'1' = hosted; '' = unmapped (#570); 'maybe' = garbage.
    it.each(['true', '1', '', 'maybe'])(
      'boot-refuses ANTHROPIC_BASE_URL when IS_HOSTED is not an affirmative self-host signal (%j)',
      (isHosted) => {
        withEnv({ ...validEnv, IS_HOSTED: isHosted, ANTHROPIC_BASE_URL: 'https://litellm.internal/v1' }, () => {
          expect(() => validateConfig()).toThrow('ANTHROPIC_BASE_URL');
        });
      },
    );
  });

  describe('APNs push (all-or-none)', () => {
    const apnsFull = {
      APNS_AUTH_KEY: '-----BEGIN PRIVATE KEY-----\\nMIG...\\n-----END PRIVATE KEY-----',
      APNS_KEY_ID: 'ABC123KEYID',
      APNS_TEAM_ID: 'TEAM123456',
      APNS_BUNDLE_ID: 'app.breeze.mobile',
    };

    it('passes when no APNS_* variable is set (push disabled)', () => {
      withEnv(validEnv, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('passes when all four credentials are set (environment defaulted)', () => {
      withEnv({ ...validEnv, ...apnsFull }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('passes when the optional APNS_ENVIRONMENT is also set', () => {
      withEnv({ ...validEnv, ...apnsFull, APNS_ENVIRONMENT: 'sandbox' }, () => {
        const config = validateConfig();
        expect(config.APNS_ENVIRONMENT).toBe('sandbox');
      });
    });

    // Compose maps these as `${APNS_*:-}`, so an operator who has not configured
    // push still gets every key injected as "". That must read as "unset", not as
    // an opted-in partial set, and the ENVIRONMENT enum must not reject "".
    it('treats an all-empty APNS_* set as unset (compose injects "" for each)', () => {
      withEnv(
        {
          ...validEnv,
          APNS_AUTH_KEY: '',
          APNS_KEY_ID: '',
          APNS_TEAM_ID: '',
          APNS_BUNDLE_ID: '',
          APNS_ENVIRONMENT: '',
        },
        () => {
          const config = validateConfig();
          expect(config.APNS_ENVIRONMENT).toBeUndefined();
        }
      );
    });

    it('treats an empty APNS_ENVIRONMENT as unset when credentials are configured', () => {
      withEnv({ ...validEnv, ...apnsFull, APNS_ENVIRONMENT: '' }, () => {
        const config = validateConfig();
        expect(config.APNS_ENVIRONMENT).toBeUndefined();
      });
    });

    it('still refuses boot on an invalid APNS_ENVIRONMENT', () => {
      withEnv({ ...validEnv, ...apnsFull, APNS_ENVIRONMENT: 'staging' }, () => {
        expect(() => validateConfig()).toThrow('APNS_ENVIRONMENT');
      });
    });

    it('still refuses boot on a partial set even when the empty keys are present', () => {
      withEnv(
        {
          ...validEnv,
          APNS_TEAM_ID: 'TEAM123456',
          APNS_BUNDLE_ID: 'app.breeze.mobile',
          APNS_AUTH_KEY: '',
          APNS_KEY_ID: '',
          APNS_ENVIRONMENT: '',
        },
        () => {
          expect(() => validateConfig()).toThrow('APNS_AUTH_KEY');
        }
      );
    });

    it.each(['APNS_AUTH_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'])(
      'refuses boot when %s is missing but other APNS_* are set',
      (missing) => {
        const partial: Record<string, string> = { ...apnsFull };
        delete partial[missing];
        withEnv({ ...validEnv, ...partial }, () => {
          expect(() => validateConfig()).toThrow(missing);
        });
      },
    );

    it('refuses boot when only APNS_ENVIRONMENT is set (opts in without credentials)', () => {
      withEnv({ ...validEnv, APNS_ENVIRONMENT: 'production' }, () => {
        expect(() => validateConfig()).toThrow('APNS_AUTH_KEY');
      });
    });

    it('rejects an invalid APNS_ENVIRONMENT value', () => {
      withEnv({ ...validEnv, ...apnsFull, APNS_ENVIRONMENT: 'staging' }, () => {
        expect(() => validateConfig()).toThrow('APNS_ENVIRONMENT');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Issue #2896 — every key declared in envSchema must actually reach safeParse.
//
// `validateConfig()` used to build its parse input from a second,
// hand-maintained list of `KEY: env.KEY` lines. Seven keys had drifted out of
// it. A key missing from that list is `undefined` at parse time, so its rules
// never run: the schema default silently wins, an operator typo boots instead
// of failing, and `getConfig()` reports a value the runtime disagrees with.
// The input is now derived from the schema; these tests hold that line.
// ---------------------------------------------------------------------------

function withoutEnv(keys: string[], fn: () => void) {
  const original: Record<string, string | undefined> = {};
  for (const key of keys) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  try {
    fn();
  } finally {
    for (const [key, val] of Object.entries(original)) {
      if (val !== undefined) process.env[key] = val;
    }
  }
}

describe('envSchema ↔ validateConfig parse-input contract (#2896)', () => {
  // THE acceptance test. Asserting `Object.keys(buildEnvParseInput(...))`
  // against ENV_SCHEMA_KEYS would be tautological — that helper is a loop over
  // ENV_SCHEMA_KEYS, so it passes for any key set including an empty one. Worse,
  // it would not notice the actual regression: someone reintroducing a
  // hand-picked object literal at the safeParse call site, which leaves
  // buildEnvParseInput as dead exported code while every such test stays green.
  //
  // So observe the real thing instead — swap process.env for a recording proxy
  // and assert validateConfig() actually TOUCHES every declared key. That fails
  // on a reintroduced pick list, on a key that stops reaching the parser, and on
  // an empty ENV_SCHEMA_KEYS.
  it('validateConfig() reads every declared key from process.env', () => {
    const read = new Set<string>();
    const realEnv = process.env;
    const target: Record<string, string | undefined> = { ...realEnv, ...validEnv };
    const recording = new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'string') read.add(prop);
        return Reflect.get(t, prop);
      },
    });

    Object.defineProperty(process, 'env', { value: recording, configurable: true, writable: true });
    try {
      validateConfig();
    } finally {
      Object.defineProperty(process, 'env', { value: realEnv, configurable: true, writable: true });
    }

    expect(ENV_SCHEMA_KEYS.filter((key) => !read.has(key))).toEqual([]);
  });

  it('declares a non-trivial key set (guards an empty or truncated schema shape)', () => {
    expect(ENV_SCHEMA_KEYS.length).toBeGreaterThan(90);
    expect(new Set(ENV_SCHEMA_KEYS).size).toBe(ENV_SCHEMA_KEYS.length);
  });

  // The exact seven that had drifted out of the old hand-maintained list.
  it.each([
    'IP_ALLOWLIST_ENFORCEMENT_MODE',
    'AGENT_AUTO_PROMOTE',
    'SSO_DOMAIN_VERIFICATION_STRICT',
    'QBO_CLIENT_ID',
    'QBO_CLIENT_SECRET',
    'QBO_REDIRECT_URI',
    'QBO_ENVIRONMENT',
    'QBO_WEBHOOK_VERIFIER_TOKEN',
  ])('validates %s (regression: silently dropped before #2896)', (key) => {
    expect(ENV_SCHEMA_KEYS).toContain(key);
    expect(buildEnvParseInput({ [key]: 'sentinel' })[key]).toBe('sentinel');
  });
});

// ---------------------------------------------------------------------------
// Issue #3374 — the CONVERSE of #2896: a key READ inside validateConfig() /
// collectWarnings() but never DECLARED in envSchema.
//
// #2896 closed "declared but never parsed". The mirror-image drift stayed open:
// a rule written directly against `env.SOME_KEY` gets no type, no default, no
// validation, and no place in the schema-derived contract above — so the value
// the validator acts on and the value getConfig() reports can disagree, and a
// typo boots silently. Three keys were in that state when #3374 was filed
// (M365_GRAPH_ACTIONS_TOOLS_ENABLED, APP_ENCRYPTION_KEY_ID,
// TRUST_CF_CONNECTING_IP).
//
// Source-level rather than behavioural on purpose: the point is to fail the
// NEXT undeclared read at authoring time, and there is no runtime observation
// that distinguishes "read a declared key" from "read an undeclared one".
// ---------------------------------------------------------------------------

/** Body of a top-level function in `source`, by brace matching from its header. */
export function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start === -1) throw new Error(`function header not found: ${header}`);
  const open = source.indexOf('{', start);
  if (open === -1) throw new Error(`no body for: ${header}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced body for: ${header}`);
}

/**
 * SCREAMING_SNAKE keys read off the `env` parameter in `body` — `env.FOO`,
 * `env?.FOO`, `env['FOO']` — that are not in `declared`.
 *
 * Dynamic reads (`env[key]` over a local list, as the optional-secrets loop
 * does) are deliberately not matched: there is no literal to check, and those
 * keys are only inspected for placeholder-looking values, never acted on as
 * configuration.
 */
export function undeclaredEnvReads(body: string, declared: readonly string[]): string[] {
  const declaredSet = new Set(declared);
  const found = new Set<string>();
  const patterns = [
    /\benv\??\.([A-Z][A-Z0-9_]*)\b/g,
    /\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  ];
  for (const re of patterns) {
    for (const m of body.matchAll(re)) {
      const key = m[1];
      if (key && !declaredSet.has(key)) found.add(key);
    }
  }
  return [...found].sort();
}

describe('envSchema ↔ direct env reads contract (#3374)', () => {
  const source = readFileSync(new URL('./validate.ts', import.meta.url), 'utf8');

  it.each([
    ['collectWarnings', 'function collectWarnings('],
    ['validateConfig', 'export function validateConfig('],
  ])('%s reads no env key that envSchema does not declare', (_name, header) => {
    const undeclared = undeclaredEnvReads(functionBody(source, header), ENV_SCHEMA_KEYS);
    expect(
      undeclared,
      `These keys are read straight off \`env\` but are not declared in envSchema, so they get ` +
        `no validation, no default, and do not participate in the #2896 parse-input contract. ` +
        `Declare each in envObjectSchema (and read it from the parsed data where possible):\n  ` +
        undeclared.join('\n  '),
    ).toEqual([]);
  });

  // The exact three that were undeclared when #3374 was filed.
  it.each([
    'M365_GRAPH_ACTIONS_TOOLS_ENABLED',
    'APP_ENCRYPTION_KEY_ID',
    'TRUST_CF_CONNECTING_IP',
  ])('declares %s (regression: read but undeclared before #3374)', (key) => {
    expect(ENV_SCHEMA_KEYS).toContain(key);
    expect(buildEnvParseInput({ [key]: 'sentinel' })[key]).toBe('sentinel');
  });

  // Scope of the guard, stated precisely so nobody over-trusts it: it scans the
  // BODIES of those two functions for a literal `env.KEY`. It does NOT see keys
  // reached indirectly — `validateConfig()` passes `env` wholesale into the
  // three `*RuntimeConfigAtBoot` validators, which read ~23 further keys
  // (M365_GRAPH_ACTIONS_EXECUTOR_URL, M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID, …)
  // that are deliberately lazily parsed and deliberately absent from AppConfig.
  // Nor does it see `const e = env; e.FOO` or a destructured read. It is a guard
  // against the specific drift #3374 fixed, not a proof of absence.
  it('does not see keys reached indirectly (documents the scan boundary)', () => {
    expect(undeclaredEnvReads('{ helper(env); }', [])).toEqual([]);
    expect(undeclaredEnvReads('{ const e = env; return e.SNEAKY; }', [])).toEqual([]);
  });

  // Guards the detector itself: a broken matcher would report [] forever and
  // the suite above would pass vacuously.
  it('detects an undeclared read (and ignores a declared one)', () => {
    const body = `{ const a = env.TOTALLY_UNDECLARED; const b = env['ALSO_UNDECLARED']; const c = env.NODE_ENV; }`;
    expect(undeclaredEnvReads(body, ['NODE_ENV'])).toEqual([
      'ALSO_UNDECLARED',
      'TOTALLY_UNDECLARED',
    ]);
  });

  it('extracts a function body by brace matching, not to the first closing brace', () => {
    const src = 'function f(a) {\n  if (a) { return 1; }\n  return 2;\n}\nconst after = 3;';
    const body = functionBody(src, 'function f(');
    expect(body).toContain('return 2;');
    expect(body).not.toContain('after');
  });
});

// ---------------------------------------------------------------------------
// The two boolean typo-guards added with #3374. Both keys were previously
// undeclared, so neither rule could exist at all; without these tests the
// guards can be deleted with the whole suite still green.
//
// Same class as AGENT_AUTO_PROMOTE / ABUSE_SIGNALS_ENABLED below: the runtime
// readers (services/clientIp.ts isTruthy, writeActionRuntimeConfig.ts
// flagEnabled) treat ANY unrecognized value as OFF, so a typo silently disables
// the feature the operator believed they had enabled.
// ---------------------------------------------------------------------------

describe('TRUST_CF_CONNECTING_IP boolean guard (#3374)', () => {
  it.each(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', 'TRUE', ' off '])(
    'accepts the recognized boolean %j',
    (value) => {
      withEnv({ ...validEnv, TRUST_CF_CONNECTING_IP: value }, () => {
        expect(validateConfig().TRUST_CF_CONNECTING_IP).toBe(value);
      });
    },
  );

  // Both compose files inject the key unconditionally (`${VAR:-}` in
  // docker-compose.yml, `${VAR:-true}` in deploy/docker-compose.prod.yml), so ""
  // is what a large share of stacks actually pass. Refusing boot on it would
  // break every one of them.
  it.each(['', '   '])('treats a compose-injected empty value (%j) as unset', (value) => {
    withEnv({ ...validEnv, TRUST_CF_CONNECTING_IP: value }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it.each(['ture', 'enabled', 'y', 'TRUE!'])(
    'refuses boot on %j, which the runtime would silently read as OFF',
    (value) => {
      withEnv({ ...validEnv, TRUST_CF_CONNECTING_IP: value }, () => {
        expect(() => validateConfig()).toThrow(/TRUST_CF_CONNECTING_IP/);
      });
    },
  );
});

describe('M365_GRAPH_ACTIONS_TOOLS_ENABLED boolean guard (#3374)', () => {
  // Only the FALSY spellings are exercised for the accept case: a truthy value
  // additionally requires APP_ENCRYPTION_KEY_ID and a full executor descriptor,
  // which would test the pairing rule instead of the format guard. The truthy
  // path is covered by the pairing test near the top of this file.
  it.each(['false', '0', 'no', 'off', 'FALSE', ' off '])(
    'accepts the recognized falsy boolean %j',
    (value) => {
      withEnv({ ...validEnv, M365_GRAPH_ACTIONS_TOOLS_ENABLED: value }, () => {
        expect(validateConfig().M365_GRAPH_ACTIONS_TOOLS_ENABLED).toBe(value);
      });
    },
  );

  it.each(['', '   '])('treats a compose-injected empty value (%j) as unset', (value) => {
    withEnv({ ...validEnv, M365_GRAPH_ACTIONS_TOOLS_ENABLED: value }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it.each(['ture', 'enabled', 'y'])(
    'refuses boot on %j, which would silently leave the Tier-3 tools dark',
    (value) => {
      withEnv({ ...validEnv, M365_GRAPH_ACTIONS_TOOLS_ENABLED: value }, () => {
        expect(() => validateConfig()).toThrow(/M365_GRAPH_ACTIONS_TOOLS_ENABLED/);
      });
    },
  );

  // The pairing rule now runs during safeParse, so it fires even with NO
  // executor descriptor configured at all — previously the descriptor validator
  // threw first and this exact combination reported a different key. Also pins
  // that a whitespace-only key id does not satisfy the requirement (`.trim()`);
  // APP_ENCRYPTION_KEY_ID carries no .min(1) of its own to catch that.
  it.each(['', '   '])(
    'requires a non-blank APP_ENCRYPTION_KEY_ID (%j) even with no descriptor configured',
    (keyId) => {
      withEnv({ ...validEnv, M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true' }, () => {
        withoutEnv(
          [
            'M365_GRAPH_ACTIONS_EXECUTOR_URL',
            'M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID',
            'M365_GRAPH_ACTIONS_TOOLS_ORG_IDS',
          ],
          () => {
            withEnv({ APP_ENCRYPTION_KEY_ID: keyId }, () => {
              expect(() => validateConfig()).toThrow(/APP_ENCRYPTION_KEY_ID/);
            });
          },
        );
      });
    },
  );
});

describe('BREEZE_ROLE ↔ APP_ENCRYPTION_KEY_ID pairing (wave 3.5b, #4084)', () => {
  it.each(['api', 'worker'])(
    'refuses boot with BREEZE_ROLE=%s and no APP_ENCRYPTION_KEY_ID',
    (role) => {
      withEnv({ ...validEnv, BREEZE_ROLE: role }, () => {
        withoutEnv(['APP_ENCRYPTION_KEY_ID'], () => {
          expect(() => validateConfig()).toThrow(/APP_ENCRYPTION_KEY_ID/);
        });
      });
    },
  );

  it.each(['api', 'worker'])(
    'refuses boot with BREEZE_ROLE=%s and a whitespace-only APP_ENCRYPTION_KEY_ID',
    (role) => {
      withEnv({ ...validEnv, BREEZE_ROLE: role, APP_ENCRYPTION_KEY_ID: '   ' }, () => {
        expect(() => validateConfig()).toThrow(/APP_ENCRYPTION_KEY_ID/);
      });
    },
  );

  it.each(['api', 'worker'])(
    'passes with BREEZE_ROLE=%s when APP_ENCRYPTION_KEY_ID is set',
    (role) => {
      withEnv({ ...validEnv, BREEZE_ROLE: role, APP_ENCRYPTION_KEY_ID: 'current' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    },
  );

  it('does not require APP_ENCRYPTION_KEY_ID when BREEZE_ROLE is unset (default "all")', () => {
    withEnv({ ...validEnv }, () => {
      withoutEnv(['BREEZE_ROLE', 'APP_ENCRYPTION_KEY_ID'], () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
  });

  it('does not require APP_ENCRYPTION_KEY_ID when BREEZE_ROLE=all explicitly', () => {
    withEnv({ ...validEnv, BREEZE_ROLE: 'all' }, () => {
      withoutEnv(['APP_ENCRYPTION_KEY_ID'], () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
  });
});

// `isConfigInitialized()` gates ipAllowlistMode()'s pre-boot fallback. Its unit
// tests mock the whole config module, so without this the predicate itself is
// unexercised — and inverting it (`_config !== undefined`, always true for a
// `null`-initialised singleton) would make getConfig() throw on every pre-boot
// caller while the entire suite stayed green. Needs a fresh module registry
// because the singleton is process-wide and this file boots config ~200 times.
describe('isConfigInitialized (#2896)', () => {
  it('is false before validateConfig() and true after a successful run', async () => {
    vi.resetModules();
    const mod = await import('./validate');
    expect(mod.isConfigInitialized()).toBe(false);
    withEnv(validEnv, () => {
      mod.validateConfig();
    });
    expect(mod.isConfigInitialized()).toBe(true);
  });

  it('stays false when validateConfig() throws on invalid config', async () => {
    vi.resetModules();
    const mod = await import('./validate');
    withEnv({ ...validEnv, DATABASE_URL: 'not-a-postgres-url' }, () => {
      expect(() => mod.validateConfig()).toThrow();
    });
    expect(mod.isConfigInitialized()).toBe(false);
  });
});

describe('IP_ALLOWLIST_ENFORCEMENT_MODE (#2896)', () => {
  it('defaults to enforce when unset', () => {
    withEnv(validEnv, () => {
      withoutEnv(['IP_ALLOWLIST_ENFORCEMENT_MODE'], () => {
        expect(validateConfig().IP_ALLOWLIST_ENFORCEMENT_MODE).toBe('enforce');
      });
    });
  });

  it('carries an explicit off through to the config object', () => {
    withEnv({ ...validEnv, IP_ALLOWLIST_ENFORCEMENT_MODE: 'off' }, () => {
      expect(validateConfig().IP_ALLOWLIST_ENFORCEMENT_MODE).toBe('off');
    });
  });

  // Both compose files map this as `${IP_ALLOWLIST_ENFORCEMENT_MODE:-}`, so the
  // key is ALWAYS injected — as "" for the many operators who never set it.
  // Enforcing the enum without treating "" as unset would refuse boot on every
  // one of those stacks the moment this fix shipped.
  it.each(['', '   '])('treats a compose-injected empty value (%j) as unset', (value) => {
    withEnv({ ...validEnv, IP_ALLOWLIST_ENFORCEMENT_MODE: value }, () => {
      expect(validateConfig().IP_ALLOWLIST_ENFORCEMENT_MODE).toBe('enforce');
    });
  });

  // Before the fix every one of these booted and silently enforced.
  it.each(['Off', 'OFF', 'disabled', 'false', 'no'])(
    'refuses boot on the near-miss value %s',
    (value) => {
      withEnv({ ...validEnv, IP_ALLOWLIST_ENFORCEMENT_MODE: value }, () => {
        expect(() => validateConfig()).toThrow(/IP_ALLOWLIST_ENFORCEMENT_MODE/);
      });
    },
  );
});

describe('AGENT_AUTO_PROMOTE boolean guard (dead code until #2896)', () => {
  it('accepts an explicit false', () => {
    withEnv({ ...validEnv, AGENT_AUTO_PROMOTE: 'false' }, () => {
      expect(validateConfig().AGENT_AUTO_PROMOTE).toBe('false');
    });
  });

  it('leaves the value unset when unset', () => {
    withEnv(validEnv, () => {
      withoutEnv(['AGENT_AUTO_PROMOTE'], () => {
        expect(validateConfig().AGENT_AUTO_PROMOTE).toBeUndefined();
      });
    });
  });

  // The superRefine rule for this existed all along but never ran, because the
  // key never reached the parser.
  it('refuses boot on a typo that would otherwise parse as truthy', () => {
    withEnv({ ...validEnv, AGENT_AUTO_PROMOTE: 'falze' }, () => {
      expect(() => validateConfig()).toThrow(/AGENT_AUTO_PROMOTE/);
    });
  });
});

// Same guard, same reasoning as AGENT_AUTO_PROMOTE: the value silently governs
// whether signup-abuse detection runs, and an unrecognized value used to read
// as "off" — so ABUSE_SIGNALS_ENABLED=ture switched a HOSTED deployment's
// signup policing off with no error anywhere but one boot log line.
describe('ABUSE_SIGNALS_ENABLED boolean guard', () => {
  it('is declared in the schema, so the superRefine rule actually runs', () => {
    expect(ENV_SCHEMA_KEYS).toContain('ABUSE_SIGNALS_ENABLED');
    expect(buildEnvParseInput({ ABUSE_SIGNALS_ENABLED: 'sentinel' }).ABUSE_SIGNALS_ENABLED).toBe(
      'sentinel',
    );
  });

  it.each(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', 'FALSE', ' off '])(
    'accepts the recognized boolean %j',
    (value) => {
      withEnv({ ...validEnv, ABUSE_SIGNALS_ENABLED: value }, () => {
        expect(validateConfig().ABUSE_SIGNALS_ENABLED).toBe(value);
      });
    },
  );

  it('leaves the value unset when unset', () => {
    withEnv(validEnv, () => {
      withoutEnv(['ABUSE_SIGNALS_ENABLED'], () => {
        expect(validateConfig().ABUSE_SIGNALS_ENABLED).toBeUndefined();
      });
    });
  });

  // Both compose files map this as `${ABUSE_SIGNALS_ENABLED:-}`, so the key is
  // ALWAYS injected — as "" for every operator who never set it. Refusing boot
  // on "" would take down every one of those stacks.
  it.each(['', '   '])('treats a compose-injected empty value (%j) as unset', (value) => {
    withEnv({ ...validEnv, ABUSE_SIGNALS_ENABLED: value }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it.each(['ture', 'enabled', 'disabled', 'TRUE!', 'y'])(
    'refuses boot on the near-miss value %s',
    (value) => {
      withEnv({ ...validEnv, ABUSE_SIGNALS_ENABLED: value }, () => {
        expect(() => validateConfig()).toThrow(/ABUSE_SIGNALS_ENABLED/);
      });
    },
  );
});

// Durable event dispatch (wave 3.5c, #4085). Unlike ABUSE_SIGNALS_ENABLED
// above, an unrecognized EVENT_DISPATCH_MODE or an unknown subscriber id in
// EVENT_DISPATCH_QUEUE_SUBSCRIBERS is a HARD boot refusal, not a
// warn-and-fallback — see the superRefine rule in validate.ts.
describe('EVENT_DISPATCH_MODE / EVENT_DISPATCH_QUEUE_SUBSCRIBERS guard', () => {
  it('is declared in the schema, so the superRefine rule actually runs', () => {
    expect(ENV_SCHEMA_KEYS).toContain('EVENT_DISPATCH_MODE');
    expect(ENV_SCHEMA_KEYS).toContain('EVENT_DISPATCH_QUEUE_SUBSCRIBERS');
    expect(buildEnvParseInput({ EVENT_DISPATCH_MODE: 'sentinel' }).EVENT_DISPATCH_MODE).toBe(
      'sentinel',
    );
    expect(
      buildEnvParseInput({ EVENT_DISPATCH_QUEUE_SUBSCRIBERS: 'sentinel' })
        .EVENT_DISPATCH_QUEUE_SUBSCRIBERS,
    ).toBe('sentinel');
  });

  it.each(['off', 'shadow', 'enforce', 'OFF', ' shadow '])(
    'accepts the recognized mode %j',
    (value) => {
      withEnv({ ...validEnv, EVENT_DISPATCH_MODE: value }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    },
  );

  it('leaves EVENT_DISPATCH_MODE unset when unset', () => {
    withEnv(validEnv, () => {
      withoutEnv(['EVENT_DISPATCH_MODE'], () => {
        expect(validateConfig().EVENT_DISPATCH_MODE).toBeUndefined();
      });
    });
  });

  // Both compose files map this as `${EVENT_DISPATCH_MODE:-off}`, so an empty
  // string must never refuse boot even though it isn't a literal mode name.
  it.each(['', '   '])('treats a compose-injected empty value (%j) as unset', (value) => {
    withEnv({ ...validEnv, EVENT_DISPATCH_MODE: value }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it('refuses boot on an unrecognized EVENT_DISPATCH_MODE typo', () => {
    withEnv({ ...validEnv, EVENT_DISPATCH_MODE: 'enforced' }, () => {
      expect(() => validateConfig()).toThrow(/EVENT_DISPATCH_MODE/);
    });
  });

  it('accepts a csv of known subscriber ids', () => {
    withEnv(
      { ...validEnv, EVENT_DISPATCH_QUEUE_SUBSCRIBERS: 'webhook-delivery,notification-dispatcher' },
      () => {
        expect(() => validateConfig()).not.toThrow();
      },
    );
  });

  it('refuses boot on an unknown subscriber id in the csv', () => {
    withEnv(
      { ...validEnv, EVENT_DISPATCH_QUEUE_SUBSCRIBERS: 'webhook-delivery,not-a-subscriber' },
      () => {
        expect(() => validateConfig()).toThrow(/EVENT_DISPATCH_QUEUE_SUBSCRIBERS/);
      },
    );
  });

  // enforce with an empty cohort degenerates to "everyone stays local" (same
  // as off) — very likely a misconfiguration, but not a boot refusal.
  it('warns but does not throw on enforce with an empty subscriber cohort', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv({ ...validEnv, EVENT_DISPATCH_MODE: 'enforce' }, () => {
      withoutEnv(['EVENT_DISPATCH_QUEUE_SUBSCRIBERS'], () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EVENT_DISPATCH_QUEUE_SUBSCRIBERS'));
    warn.mockRestore();
  });
});

// Wave 5 Part B (#3827) sub-flag. Same guard, same reasoning as
// AGENT_AUTO_PROMOTE/ABUSE_SIGNALS_ENABLED above: this silently governs
// whether attemptPolicyDecision ever runs, so a typo must be caught at boot
// rather than silently reading as off at the envFlag reader.
describe('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED boolean guard', () => {
  it('is declared in the schema, so the superRefine rule actually runs', () => {
    expect(ENV_SCHEMA_KEYS).toContain('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED');
    expect(
      buildEnvParseInput({ BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED: 'sentinel' })
        .BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED,
    ).toBe('sentinel');
  });

  it.each(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', 'FALSE', ' off '])(
    'accepts the recognized boolean %j',
    (value) => {
      withEnv({ ...validEnv, BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED: value }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    },
  );

  it('leaves the value unset when unset', () => {
    withEnv(validEnv, () => {
      withoutEnv(['BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED'], () => {
        expect(validateConfig().BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED).toBeUndefined();
      });
    });
  });

  // Both compose api-env anchors map this as
  // `${BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED:-false}` — a default-bearing
  // interpolation, so the key reaches the container but the .env.example
  // documents it commented-out. Either way "" must never refuse boot.
  it.each(['', '   '])('treats an empty value (%j) as unset', (value) => {
    withEnv({ ...validEnv, BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED: value }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it.each(['ture', 'enabled', 'disabled', 'TRUE!', 'y'])(
    'refuses boot on the near-miss value %s',
    (value) => {
      withEnv({ ...validEnv, BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED: value }, () => {
        expect(() => validateConfig()).toThrow(/BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED/);
      });
    },
  );
});
