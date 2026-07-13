import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadEnv = async () => import('./env');

const OAUTH_ENV_KEYS = [
  'MCP_OAUTH_ENABLED',
  'OAUTH_DCR_ENABLED',
  'OAUTH_DCR_REQUIRE_IAT',
  'OAUTH_DCR_ALLOW_ANONYMOUS',
  'OAUTH_ISSUER',
  'OAUTH_RESOURCE_URL',
  'OAUTH_JWKS_PRIVATE_JWK',
  'OAUTH_JWKS_PUBLIC_JWK',
  'OAUTH_COOKIE_SECRET',
  'NODE_ENV',
  'MFA_FORCE_FOR_PARTNER_ADMIN',
  'DASHBOARD_URL',
  'PUBLIC_APP_URL',
  'AUTH_BROWSER_TRANSITIONS_ENFORCED',
  'AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED',
] as const;

const clearOauthEnv = () => {
  for (const key of OAUTH_ENV_KEYS) delete process.env[key];
};

describe('config env', () => {
  beforeEach(() => {
    clearOauthEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearOauthEnv();
  });

  it('defaults MCP_OAUTH_ENABLED to false when unset', async () => {
    const mod = await loadEnv();
    expect(mod.MCP_OAUTH_ENABLED).toBe(false);
  });

  it('treats recognized true values as enabled', async () => {
    for (const value of ['true', '1', 'yes', 'on']) {
      process.env.MCP_OAUTH_ENABLED = value;
      vi.resetModules();
      const mod = await loadEnv();
      expect(mod.MCP_OAUTH_ENABLED).toBe(true);
    }
  });

  it('treats unrecognized MCP_OAUTH_ENABLED values as false', async () => {
    process.env.MCP_OAUTH_ENABLED = 'foo';
    const mod = await loadEnv();
    expect(mod.MCP_OAUTH_ENABLED).toBe(false);
  });

  describe('durable browser-transition rollout', () => {
    it('keeps issuer readiness and terminal preparation disabled by default', async () => {
      const mod = await loadEnv();

      expect(mod.authBrowserTransitionsEnforced()).toBe(false);
      expect(mod.authBrowserTerminalPreparationEnabled()).toBe(false);
    });

    it.each(['true', '1', 'yes', 'on'])('enables both stages only for explicit truthy values (%s)', async (value) => {
      process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED = value;
      process.env.AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED = value;
      const mod = await loadEnv();

      expect(mod.authBrowserTransitionsEnforced()).toBe(true);
      expect(mod.authBrowserTerminalPreparationEnabled()).toBe(true);
    });

    it('fails closed at runtime when terminal preparation is requested before issuer readiness', async () => {
      process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED = 'false';
      process.env.AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED = 'true';
      const mod = await loadEnv();

      expect(mod.authBrowserTransitionsEnforced()).toBe(false);
      expect(mod.authBrowserTerminalPreparationEnabled()).toBe(false);
    });
  });

  // Task 21 (May 2026): DCR now defaults OFF in every environment.
  // Production deploys must explicitly set OAUTH_DCR_ENABLED=true AND
  // OAUTH_DCR_REQUIRE_IAT=true (boot-refused otherwise — see validate.ts).
  it('defaults OAUTH_DCR_ENABLED to false in development', async () => {
    process.env.NODE_ENV = 'development';
    const mod = await loadEnv();
    expect(mod.OAUTH_DCR_ENABLED).toBe(false);
  });

  it('defaults OAUTH_DCR_ENABLED to false in production', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await loadEnv();
    expect(mod.OAUTH_DCR_ENABLED).toBe(false);
  });

  it('allows OAUTH_DCR_ENABLED to opt in explicitly', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OAUTH_DCR_ENABLED = 'true';
    const mod = await loadEnv();
    expect(mod.OAUTH_DCR_ENABLED).toBe(true);
  });

  it('defaults OAUTH_DCR_REQUIRE_IAT to false when unset', async () => {
    const mod = await loadEnv();
    expect(mod.OAUTH_DCR_REQUIRE_IAT).toBe(false);
  });

  it('allows OAUTH_DCR_REQUIRE_IAT to opt in explicitly', async () => {
    process.env.OAUTH_DCR_REQUIRE_IAT = 'true';
    const mod = await loadEnv();
    expect(mod.OAUTH_DCR_REQUIRE_IAT).toBe(true);
  });

  it('defaults OAUTH_ISSUER and OAUTH_RESOURCE_URL to empty strings', async () => {
    const mod = await loadEnv();
    expect(mod.OAUTH_ISSUER).toBe('');
    expect(mod.OAUTH_RESOURCE_URL).toBe('');
  });

  it('allows OAUTH_RESOURCE_URL to override the derived value', async () => {
    process.env.OAUTH_ISSUER = 'https://issuer.example';
    process.env.OAUTH_RESOURCE_URL = 'https://resource.example/custom';
    const mod = await loadEnv();
    expect(mod.OAUTH_RESOURCE_URL).toBe('https://resource.example/custom');
  });

  // mfaForcePartnerAdmin is the kill-switch for the role-level MFA gate
  // introduced in Task 8 of the launch-readiness sprint. Defaults ON so
  // the secure-by-default posture holds, but ops can flip it OFF without
  // a code change when an enrollment outage locks legitimate users out.
  it('defaults mfaForcePartnerAdmin to true when unset', async () => {
    const mod = await loadEnv();
    expect(mod.mfaForcePartnerAdmin()).toBe(true);
  });

  it('returns false when MFA_FORCE_FOR_PARTNER_ADMIN is explicitly disabled', async () => {
    process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
    const mod = await loadEnv();
    expect(mod.mfaForcePartnerAdmin()).toBe(false);
  });

  it('returns true when MFA_FORCE_FOR_PARTNER_ADMIN is explicitly true', async () => {
    process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'true';
    const mod = await loadEnv();
    expect(mod.mfaForcePartnerAdmin()).toBe(true);
  });

  describe('authBrowserPublicOrigin', () => {
    it('prefers DASHBOARD_URL and returns only its canonical origin', async () => {
      process.env.DASHBOARD_URL = ' https://app.example.test/some/path/ ';
      process.env.PUBLIC_APP_URL = 'https://fallback.example.test';

      const mod = await loadEnv();

      expect(mod.authBrowserPublicOrigin()).toBe('https://app.example.test');
    });

    it('falls back to PUBLIC_APP_URL', async () => {
      process.env.PUBLIC_APP_URL = 'http://localhost:4321/dashboard';

      const mod = await loadEnv();

      expect(mod.authBrowserPublicOrigin()).toBe('http://localhost:4321');
    });

    it.each([
      'javascript:alert(1)',
      'ftp://app.example.test',
      'https://user:password@app.example.test',
      'https://',
      'not a url',
    ])('rejects unsafe or malformed configured origin %s', async (configured) => {
      process.env.DASHBOARD_URL = configured;

      const mod = await loadEnv();

      expect(mod.authBrowserPublicOrigin()).toBeNull();
    });

    it('returns null rather than deriving an origin from a request host', async () => {
      const mod = await loadEnv();

      expect(mod.authBrowserPublicOrigin()).toBeNull();
    });
  });

  // Fail-closed self-host gate for private-network fetching (on-prem PSAs, DNS
  // appliances, internal OIDC IdPs). Only an AFFIRMATIVE self-host declaration
  // opens RFC1918/ULA; unset/garbage/truthy IS_HOSTED stays strict (#570).
  describe('selfHostAllowsPrivateNetwork', () => {
    afterEach(() => {
      delete process.env.IS_HOSTED;
    });

    it('is true only for recognized self-host signals', async () => {
      for (const value of ['false', '0', 'no', 'off', 'FALSE', ' off ']) {
        process.env.IS_HOSTED = value;
        vi.resetModules();
        const mod = await loadEnv();
        expect(mod.selfHostAllowsPrivateNetwork()).toBe(true);
      }
    });

    it('is false when IS_HOSTED is unset (fail-closed)', async () => {
      delete process.env.IS_HOSTED;
      const mod = await loadEnv();
      expect(mod.selfHostAllowsPrivateNetwork()).toBe(false);
    });

    it('is false for hosted/truthy or garbage IS_HOSTED', async () => {
      for (const value of ['true', '1', 'yes', 'on', '', 'garbage']) {
        process.env.IS_HOSTED = value;
        vi.resetModules();
        const mod = await loadEnv();
        expect(mod.selfHostAllowsPrivateNetwork()).toBe(false);
      }
    });
  });
});
