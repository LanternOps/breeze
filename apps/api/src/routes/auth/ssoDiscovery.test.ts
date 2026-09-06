import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  ssoProviders: {
    id: 'ssoProviders.id',
    orgId: 'ssoProviders.orgId',
    name: 'ssoProviders.name',
    type: 'ssoProviders.type',
    status: 'ssoProviders.status',
    enforceSSO: 'ssoProviders.enforceSSO',
    createdAt: 'ssoProviders.createdAt',
  },
  ssoVerifiedDomains: {
    orgId: 'ssoVerifiedDomains.orgId',
    domain: 'ssoVerifiedDomains.domain',
    verifiedAt: 'ssoVerifiedDomains.verifiedAt',
  },
  users: { id: 'users.id', email: 'users.email' },
}));

vi.mock('../../services', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 19, resetAt: new Date() })),
  getRedis: vi.fn(() => ({})),
  getTrustedClientIp: vi.fn(() => '203.0.113.7'),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '203.0.113.7'),
  getImmediatePeerIpOrUndefined: vi.fn(() => '203.0.113.7'),
  rateLimitIpKey: vi.fn((ip: string) => ip),
  trustsForwardedHeadersFrom: vi.fn(() => true),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { ssoDiscoveryRoutes } from './ssoDiscovery';
import { db } from '../../db';
import { rateLimiter, getRedis } from '../../services';
import { captureException } from '../../services/sentry';

const ORG_UUID = '00000000-0000-4000-8000-0000000000a1';
const ORG_UUID_2 = '00000000-0000-4000-8000-0000000000a2';

/**
 * The route issues up to three reads, each a distinct chain shape:
 *  1. verified-domain lookup   `.from(t).where(c).limit(2)`
 *  2. enforcement probe        `.from(t).where(c).limit(1)`
 *  3. entry-route provider     `.from(t).where(c).orderBy(...).limit(1)`
 * This helper answers whichever shape the call under test uses.
 */
const orderByCalls: unknown[][] = [];

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn((...args: unknown[]) => {
          orderByCalls.push(args);
          return { limit: vi.fn().mockResolvedValue(rows) };
        }),
      }),
    }),
  };
}

/** Queue per-call results in the order the route reads them. */
function queueSelects(...results: unknown[][]) {
  orderByCalls.length = 0;
  const mock = vi.mocked(db.select).mockReset();
  for (const rows of results) mock.mockReturnValueOnce(selectChain(rows) as never);
  mock.mockReturnValue(selectChain([]) as never);
}

const VERIFIED_DOMAIN = [{ orgId: ORG_UUID }];
const ENFORCING_PROVIDER = [{ id: 'p-enforcing' }];
const OIDC_ENTRY_PROVIDER = [{ name: 'Authentik', type: 'oidc' }];

async function discover(body: unknown) {
  return ssoDiscoveryRoutes.request('/sso-discovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /auth/sso-discovery (#3229)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({} as never);
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() } as never);
    queueSelects();
  });

  describe('positive resolution', () => {
    it('names the org SSO provider when a verified domain maps to an SSO-mandating org', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);

      const res = await discover({ email: 'tech@acme.example' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        sso: {
          providerName: 'Authentik',
          loginUrl: `/api/v1/sso/login/${ORG_UUID}`,
          enforceSSO: true,
        },
      });
    });

    it('never caches the answer', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);

      const res = await discover({ email: 'tech@acme.example' });

      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('matches the domain case-insensitively and ignores address casing', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);

      const res = await discover({ email: '  Tech@ACME.Example  ' });

      expect(res.status).toBe(200);
      expect((await res.json()).sso).not.toBeNull();
    });

    // The entry route GET /sso/login/:orgId picks the OLDEST ACTIVE provider
    // regardless of enforce_sso (sso.ts). Discovery must name that same
    // provider or the button says one thing and launches another.
    it('names the oldest active provider, not the enforcing one', async () => {
      queueSelects(
        VERIFIED_DOMAIN,
        [{ id: 'newer-enforcing-provider' }],
        [{ name: 'Legacy Okta', type: 'oidc' }],
      );

      const res = await discover({ email: 'tech@acme.example' });

      expect((await res.json()).sso.providerName).toBe('Legacy Okta');
    });

    // The mock cannot execute SQL, so the ONLY unit-level way to catch a
    // dropped or reordered ORDER BY is to assert the columns it was handed.
    // The real ordering behaviour is proved in ssoDiscovery.integration.test.ts.
    it('orders the entry-route lookup by createdAt then id, like every other SSO-discovery surface', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);

      await discover({ email: 'tech@acme.example' });

      const schema = await import('../../db/schema');
      expect(orderByCalls).toEqual([[schema.ssoProviders.createdAt, schema.ssoProviders.id]]);
    });

    it('strips the FQDN root dot so `user@example.com.` matches the stored domain', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);

      const res = await discover({ email: 'tech@acme.example.' });

      expect((await res.json()).sso).not.toBeNull();
    });
  });

  // The whole point of the contract: the answer is a function of the DOMAIN and
  // the tenant's own published config, never of whether an ACCOUNT exists.
  describe('no account-existence oracle', () => {
    it('answers identically for a real-looking and a nonsense local part on the same domain', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);
      const known = await discover({ email: 'tech@acme.example' });
      const knownBody = await known.json();

      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);
      const unknown = await discover({ email: 'no-such-person-9f2a@acme.example' });

      expect(known.status).toBe(unknown.status);
      expect(await unknown.json()).toEqual(knownBody);
    });

    it('never reads the users table', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);

      await discover({ email: 'tech@acme.example' });

      const schema = await import('../../db/schema');
      const readTables = vi
        .mocked(db.select)
        .mock.results.map((r) => (r.value as { from: ReturnType<typeof vi.fn> }).from.mock.calls[0]?.[0]);
      expect(readTables).not.toContain(schema.users);
    });
  });

  describe('uniform negative answer', () => {
    const NONE = { sso: null };

    it('returns the negative answer for an unrecognized domain', async () => {
      queueSelects([]);
      const res = await discover({ email: 'someone@unknown.example' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(NONE);
    });

    // Two orgs can each verify the same domain (the unique index is on
    // (org_id, domain), not domain alone). Attributing the login to either one
    // would be a guess, and a wrong guess sends the user to a stranger's IdP.
    it('returns the negative answer when two orgs claim the same domain', async () => {
      queueSelects([{ orgId: ORG_UUID }, { orgId: ORG_UUID_2 }]);
      const res = await discover({ email: 'someone@shared.example' });
      expect(await res.json()).toEqual(NONE);
    });

    it('returns the negative answer when the org has SSO but does not mandate it', async () => {
      queueSelects(VERIFIED_DOMAIN, []);
      const res = await discover({ email: 'tech@acme.example' });
      expect(await res.json()).toEqual(NONE);
    });

    // Distinct from the non-OIDC case below: here the enforcement probe found a
    // provider but the entry-route lookup came back empty. Should be impossible
    // (enforcing implies active), but the route defends against it, so the
    // defence is exercised rather than assumed.
    it('returns the negative answer when the entry-route lookup finds nothing', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, []);
      const res = await discover({ email: 'tech@acme.example' });
      expect(await res.json()).toEqual(NONE);
    });

    // The entry route rejects a non-OIDC provider with 400 (sso.ts). Advertising
    // a button that is guaranteed to fail is worse than showing none.
    it('returns the negative answer when the entry-route provider is not OIDC', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, [{ name: 'Shibboleth', type: 'saml' }]);
      const res = await discover({ email: 'tech@acme.example' });
      expect(await res.json()).toEqual(NONE);
    });

    it('degrades to the negative answer when the database read throws', async () => {
      vi.mocked(db.select).mockReset().mockImplementation(() => {
        throw new Error('connection terminated');
      });

      const res = await discover({ email: 'tech@acme.example' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(NONE);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(captureException).toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('keys the bucket on the client, never on the email', async () => {
      queueSelects(VERIFIED_DOMAIN, ENFORCING_PROVIDER, OIDC_ENTRY_PROVIDER);

      await discover({ email: 'tech@acme.example' });

      const key = vi.mocked(rateLimiter).mock.calls[0]?.[1] as string;
      expect(key).toMatch(/^sso-discovery:/);
      expect(key).not.toContain('acme.example');
      expect(key).not.toContain('tech@');
    });

    it('rejects with 429 once the client bucket is exhausted, without touching the DB', async () => {
      vi.mocked(rateLimiter).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60_000),
      } as never);

      const res = await discover({ email: 'tech@acme.example' });

      expect(res.status).toBe(429);
      expect(db.select).not.toHaveBeenCalled();
    });

    // rateLimiter fails CLOSED when Redis is missing, so an unavailable Redis
    // denies rather than silently serving an unlimited discovery oracle.
    it('is denied when Redis is unavailable', async () => {
      vi.mocked(getRedis).mockReturnValue(null as never);
      vi.mocked(rateLimiter).mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() } as never);

      const res = await discover({ email: 'tech@acme.example' });

      expect(res.status).toBe(429);
    });
  });

  describe('input validation', () => {
    it('rejects a body that is not an email address', async () => {
      const res = await discover({ email: 'not-an-email' });
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('rejects a missing email', async () => {
      const res = await discover({});
      expect(res.status).toBe(400);
    });
  });
});
