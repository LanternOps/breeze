/**
 * Real-DB integration coverage for the public POST /auth/sso-discovery
 * endpoint (#3229 review follow-up).
 *
 * WHY THIS FILE EXISTS. The existing unit suite
 * (apps/api/src/routes/auth/ssoDiscovery.test.ts) mocks Drizzle with a chain
 * that never inspects the argument passed to `.where()`. That means the
 * security-critical SQL predicates the handler builds — `isNotNull(verifiedAt)`,
 * `eq(status, 'active')`, `eq(enforceSSO, true)`, and the
 * `orderBy(createdAt, id)` that decides which provider is named — are not
 * actually proven by that suite: any of them could be deleted from
 * routes/auth/ssoDiscovery.ts and all of its unit tests would still pass.
 * Only a real-Postgres run can prove the predicates are wired into the SQL
 * that actually executes. This file is that proof, structured like the
 * sibling public pre-auth route's integration test
 * (loginContext.integration.test.ts): build a bare Hono app around the real
 * route, seed genuine rows via the superuser test client (getTestDb(),
 * bypasses RLS — same posture as loginContext's fixtures), and assert on the
 * real HTTP response.
 *
 * Redis: the route calls rateLimiter unconditionally and fails CLOSED without
 * Redis (same posture as GET /auth/login-context). setup.ts's per-test
 * beforeEach flushes the shared test Redis DB, so every test here starts with
 * a clean 20-per-5-minutes bucket for its one request — no limiter mock
 * needed.
 *
 * Wire contract under test: packages/shared/src/types/ssoDiscovery.ts.
 * `sso` is `{ providerName, loginUrl, enforceSSO: true } | null` — presence of
 * `sso` IS the availability signal.
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/ssoDiscovery.integration.test.ts
 */
import './setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { ssoProviders, ssoVerifiedDomains } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { ssoDiscoveryRoutes } from '../../routes/auth/ssoDiscovery';

/** Suffix every seeded domain with a random token so cases within a single
 * test (e.g. the two-orgs-same-domain collision case) and across tests can
 * never bleed into each other via a stray unique-index collision. */
function uniqueDomain(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}.sso-discovery.example.test`;
}

async function createVerifiedDomain(
  orgId: string,
  domain: string,
  opts: { verified?: boolean } = {},
) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoVerifiedDomains)
    .values({
      orgId,
      domain,
      verificationToken: `seed-token-${randomUUID()}`,
      verifiedAt: opts.verified === false ? null : new Date(),
    })
    .returning();
  if (!row) throw new Error('failed to create sso_verified_domains fixture');
  return row;
}

async function createOrgProvider(
  orgId: string,
  opts: {
    status?: 'active' | 'inactive' | 'testing';
    enforceSSO?: boolean;
    name?: string;
    type?: 'oidc' | 'saml';
    createdAt?: Date;
  } = {},
) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoProviders)
    .values({
      orgId,
      partnerId: null,
      name: opts.name ?? 'Test SSO Provider',
      type: opts.type ?? 'oidc',
      status: opts.status ?? 'active',
      enforceSSO: opts.enforceSSO ?? false,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning();
  if (!row) throw new Error('failed to create sso_providers fixture');
  return row;
}

function buildApp(): Hono {
  const app = new Hono();
  app.route('/auth', ssoDiscoveryRoutes);
  return app;
}

async function postDiscovery(app: Hono, email: string) {
  return app.request('/auth/sso-discovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

describe('POST /auth/sso-discovery — real-DB e2e (#3229)', () => {
  it('happy path: verified domain + active enforcing oidc provider names that provider and sets Cache-Control: no-store', async () => {
    const app = buildApp();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const domain = uniqueDomain('happy');
    await createVerifiedDomain(org.id, domain);
    await createOrgProvider(org.id, { status: 'active', enforceSSO: true, name: 'Acme Okta' });

    const res = await postDiscovery(app, `user@${domain}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({
      sso: {
        providerName: 'Acme Okta',
        loginUrl: `/api/v1/sso/login/${org.id}`,
        enforceSSO: true,
      },
    });
  });

  it('unverified domain (verified_at IS NULL): sso is null even though the org otherwise fully qualifies — proves the isNotNull filter is real', async () => {
    const app = buildApp();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const domain = uniqueDomain('unverified');
    await createVerifiedDomain(org.id, domain, { verified: false });
    await createOrgProvider(org.id, { status: 'active', enforceSSO: true, name: 'Should Never Be Named' });

    const res = await postDiscovery(app, `user@${domain}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sso: null });
  });

  it('two different orgs each verify the SAME domain: the (org_id, domain) unique index permits the collision, and discovery refuses to guess which org owns it', async () => {
    const app = buildApp();
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const domain = uniqueDomain('collision');
    // Both inserts must succeed — if the unique index were on `domain` alone
    // (not `(org_id, domain)`), the second insert would throw here and fail
    // the test before the assertion below is ever reached.
    await createVerifiedDomain(orgA.id, domain);
    await createVerifiedDomain(orgB.id, domain);
    await createOrgProvider(orgA.id, { status: 'active', enforceSSO: true, name: 'Org A IdP' });
    await createOrgProvider(orgB.id, { status: 'active', enforceSSO: true, name: 'Org B IdP' });

    const res = await postDiscovery(app, `user@${domain}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sso: null });
  });

  it('org whose only active provider has enforce_sso=false: sso is null — proves the enforceSSO predicate is real', async () => {
    const app = buildApp();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const domain = uniqueDomain('no-enforce');
    await createVerifiedDomain(org.id, domain);
    await createOrgProvider(org.id, { status: 'active', enforceSSO: false, name: 'Optional SSO Provider' });

    const res = await postDiscovery(app, `user@${domain}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sso: null });
  });

  it('the enforcing provider is status=inactive with no other active enforcing provider: sso is null — proves the status predicate is real', async () => {
    const app = buildApp();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const domain = uniqueDomain('inactive-enforcer');
    await createVerifiedDomain(org.id, domain);
    await createOrgProvider(org.id, { status: 'inactive', enforceSSO: true, name: 'Disabled Enforcer' });

    const res = await postDiscovery(app, `user@${domain}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sso: null });
  });

  it('ordering: names the OLDEST active provider (the one GET /sso/login/:orgId actually launches), not the one that enforces', async () => {
    const app = buildApp();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const domain = uniqueDomain('ordering');
    await createVerifiedDomain(org.id, domain);
    const older = await createOrgProvider(org.id, {
      status: 'active',
      enforceSSO: false,
      name: 'Oldest Non-Enforcing Provider',
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
    await createOrgProvider(org.id, {
      status: 'active',
      enforceSSO: true,
      name: 'Newer Enforcing Provider',
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });

    const res = await postDiscovery(app, `user@${domain}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sso: {
        providerName: older.name,
        loginUrl: `/api/v1/sso/login/${org.id}`,
        enforceSSO: true,
      },
    });
  });

  it('the oldest active provider is type=saml (a newer active oidc provider enforces): sso is null — the entry route only supports OIDC', async () => {
    const app = buildApp();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const domain = uniqueDomain('saml-oldest');
    await createVerifiedDomain(org.id, domain);
    await createOrgProvider(org.id, {
      status: 'active',
      enforceSSO: false,
      type: 'saml',
      name: 'Oldest SAML Provider',
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
    await createOrgProvider(org.id, {
      status: 'active',
      enforceSSO: true,
      type: 'oidc',
      name: 'Newer OIDC Enforcer',
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });

    const res = await postDiscovery(app, `user@${domain}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sso: null });
  });
});
