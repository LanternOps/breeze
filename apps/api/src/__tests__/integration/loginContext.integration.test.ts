/**
 * Real-DB integration coverage for the public GET /auth/login-context
 * endpoint (#2183 / #2194 review follow-up).
 *
 * This is the PR's only fully-public, unauthenticated route — it runs on
 * every render of the login page, before any tenant is known, and had zero
 * integration coverage. It's also the platform's one deliberate
 * tenant-leakage gate: on a multi-partner instance it must reveal NOTHING
 * (no branding, no SSO hint) rather than guess which partner the visitor
 * belongs to. These cases exercise the real handler (routes/auth/loginContext.ts)
 * against genuine Postgres (RLS via withSystemDbAccessContext) and genuine
 * Redis (the route rate-limits 30/min per IP and fails CLOSED without Redis;
 * cleanupDatabase()'s per-test `flushdb` in setup.ts keeps that bucket fresh
 * for every test).
 *
 * Wire contract under test: packages/shared/src/types/loginContext.ts.
 * `partnerSso` is `{ providerName, loginUrl, enforceSSO } | null` — presence
 * of `partnerSso` IS the availability signal, there is no separate
 * `available` field.
 *
 * "Which partners exist" is GLOBAL state. cleanupDatabase() (setup.ts) used
 * to silently fail to truncate `partners`/`organizations` — the cascade
 * reached `audit_logs`, whose `audit_log_block_truncate` trigger rejected the
 * whole statement and the error was swallowed — so this suite originally
 * carried a suite-local trigger-aware truncate workaround. That fix now lives
 * in cleanupDatabase() itself (#2205): the global per-test beforeEach disables
 * the audit trigger around the reset and fails loudly on any other truncate
 * error, so the tenant roots are genuinely empty before every test here and
 * the local workaround has been removed.
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/loginContext.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { getTestDb } from './setup';
import { ssoProviders, partnerLoginBranding } from '../../db/schema';
import { createPartner } from './db-utils';
import { loginContextRoutes } from '../../routes/auth/loginContext';

async function createPartnerAxisProvider(
  partnerId: string,
  opts: { status?: 'active' | 'inactive' | 'testing'; enforceSSO?: boolean; name?: string } = {},
) {
  const db = getTestDb();
  const [row] = await db
    .insert(ssoProviders)
    .values({
      orgId: null,
      partnerId,
      name: opts.name ?? 'Acme MSP SSO',
      type: 'oidc',
      status: opts.status ?? 'active',
      enforceSSO: opts.enforceSSO ?? false,
    })
    .returning();
  if (!row) throw new Error('failed to create partner-axis provider fixture');
  return row;
}

async function createBranding(
  partnerId: string,
  opts: { logoUrl?: string | null; accentColor?: string | null; headline?: string | null } = {},
) {
  const db = getTestDb();
  const [row] = await db
    .insert(partnerLoginBranding)
    .values({
      partnerId,
      logoUrl: opts.logoUrl ?? 'https://cdn.example.test/acme-logo.png',
      // Valid #rrggbb hex — the 2026-07-04 migration adds a DB-level CHECK
      // constraint enforcing this shape.
      accentColor: opts.accentColor ?? '#123abc',
      headline: opts.headline ?? 'Welcome to Acme MSP',
    })
    .returning();
  if (!row) throw new Error('failed to create partner_login_branding fixture');
  return row;
}

function buildApp(): Hono {
  const app = new Hono();
  app.route('/auth', loginContextRoutes);
  return app;
}

describe('GET /auth/login-context — real-DB e2e (#2183)', () => {
  it('single partner + active provider + branding row: returns branding and the new partnerSso contract (providerName, loginUrl, enforceSSO — no `available` field)', async () => {
    const app = buildApp();
    const partner = await createPartner();
    await createBranding(partner.id, { logoUrl: 'https://cdn.example.test/logo.png', accentColor: '#123abc', headline: 'Welcome' });
    await createPartnerAxisProvider(partner.id, { status: 'active', enforceSSO: true, name: 'Acme Okta' });

    const res = await app.request('/auth/login-context');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.branding).toEqual({
      logoUrl: 'https://cdn.example.test/logo.png',
      accentColor: '#123abc',
      headline: 'Welcome',
    });
    expect(body.partnerSso).toEqual({
      providerName: 'Acme Okta',
      loginUrl: `/api/v1/sso/login/partner/${partner.id}`,
      enforceSSO: true,
    });
    expect(body.partnerSso.available).toBeUndefined();
  });

  it('a status=testing provider is never advertised publicly: partnerSso is null while branding still returns', async () => {
    const app = buildApp();
    const partner = await createPartner();
    await createBranding(partner.id, { headline: 'Testing Partner' });
    await createPartnerAxisProvider(partner.id, { status: 'testing', enforceSSO: true });

    const res = await app.request('/auth/login-context');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.partnerSso).toBeNull();
    expect(body.branding).toEqual({
      logoUrl: 'https://cdn.example.test/acme-logo.png',
      accentColor: '#123abc',
      headline: 'Testing Partner',
    });
  });

  it('more than one partner: leak-nothing gate returns { branding: null, partnerSso: null } even though both have branding/providers', async () => {
    const app = buildApp();
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    await createBranding(partnerA.id, { headline: 'Partner A' });
    await createBranding(partnerB.id, { headline: 'Partner B' });
    await createPartnerAxisProvider(partnerA.id, { status: 'active' });
    await createPartnerAxisProvider(partnerB.id, { status: 'active' });

    const res = await app.request('/auth/login-context');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toEqual({ branding: null, partnerSso: null });
  });

  it('single partner with no branding row: branding is null (partnerSso still resolves normally)', async () => {
    const app = buildApp();
    const partner = await createPartner();
    await createPartnerAxisProvider(partner.id, { status: 'active', enforceSSO: false, name: 'No Branding IdP' });

    const res = await app.request('/auth/login-context');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.branding).toBeNull();
    expect(body.partnerSso).toEqual({
      providerName: 'No Branding IdP',
      loginUrl: `/api/v1/sso/login/partner/${partner.id}`,
      enforceSSO: false,
    });
  });

  it('zero partners: returns { branding: null, partnerSso: null } (partnerRows.length !== 1 branch)', async () => {
    const app = buildApp();
    const res = await app.request('/auth/login-context');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ branding: null, partnerSso: null });
  });
});

describe('GET /auth/login-context/partner/:slug — real-DB e2e (#4017)', () => {
  it('resolves branding + partnerSso by slug on a multi-partner instance', async () => {
    const app = buildApp();
    const partner = await createPartner({ slug: 'acme-msp-4017' });
    await createPartner({ slug: 'other-msp-4017' });
    await createBranding(partner.id, { headline: 'Welcome to Acme' });
    await createPartnerAxisProvider(partner.id, { status: 'active', name: 'Acme Okta' });

    const res = await app.request('/auth/login-context/partner/acme-msp-4017');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branding.headline).toBe('Welcome to Acme');
    expect(body.partnerSso).toEqual({
      providerName: 'Acme Okta',
      loginUrl: `/api/v1/sso/login/partner/${partner.id}`,
      enforceSSO: false,
    });
  });

  it('matches the slug case-insensitively', async () => {
    const app = buildApp();
    const partner = await createPartner({ slug: 'case-msp-4017' });
    await createPartnerAxisProvider(partner.id, { status: 'active', name: 'Case IdP' });

    const body = await (await app.request('/auth/login-context/partner/Case-MSP-4017')).json();
    expect(body.partnerSso?.providerName).toBe('Case IdP');
  });

  it('resolves each of several case-variant slugs to its own partner, and refuses to guess for a spelling matching none exactly', async () => {
    const app = buildApp();
    const variants = ['variant-msp-4017', 'VARIANT-MSP-4017', 'Variant-Msp-4017'];
    for (const slug of variants) {
      const partner = await createPartner({ slug });
      await createPartnerAxisProvider(partner.id, { status: 'active', name: `IdP for ${slug}` });
    }

    for (const slug of variants) {
      const body = await (await app.request(`/auth/login-context/partner/${slug}`)).json();
      expect(body.partnerSso?.providerName).toBe(`IdP for ${slug}`);
    }

    const ambiguous = await (await app.request('/auth/login-context/partner/vArIaNt-MsP-4017')).json();
    expect(ambiguous).toEqual({ branding: null, partnerSso: null });
  });

  it('picks the OLDEST active provider, the same one the partner SSO entry route starts', async () => {
    const app = buildApp();
    const partner = await createPartner({ slug: 'multi-provider-4017' });
    await createPartnerAxisProvider(partner.id, { status: 'active', name: 'First Provider' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await createPartnerAxisProvider(partner.id, { status: 'active', name: 'Second Provider' });

    const body = await (await app.request('/auth/login-context/partner/multi-provider-4017')).json();
    expect(body.partnerSso.providerName).toBe('First Provider');
  });

  it('answers an unknown slug, an unconfigured partner, and suspended / soft-deleted partners identically', async () => {
    const app = buildApp();
    await createPartner({ slug: 'quiet-partner-4017' });
    const suspended = await createPartner({ slug: 'suspended-partner-4017', status: 'suspended' });
    await createPartnerAxisProvider(suspended.id, { status: 'active' });
    await createBranding(suspended.id);
    const deleted = await createPartner({ slug: 'deleted-partner-4017', deletedAt: new Date() });
    await createPartnerAxisProvider(deleted.id, { status: 'active' });

    const slugs = ['does-not-exist-4017', 'quiet-partner-4017', 'suspended-partner-4017', 'deleted-partner-4017'];
    for (const slug of slugs) {
      const res = await app.request(`/auth/login-context/partner/${slug}`);
      expect({
        slug,
        status: res.status,
        body: await res.text(),
        cacheControl: res.headers.get('cache-control'),
      }).toEqual({
        slug,
        status: 200,
        body: JSON.stringify({ branding: null, partnerSso: null }),
        cacheControl: 'no-store',
      });
    }
  });

  it('resolves on a hosted instance, where the singleton route stays silent', async () => {
    const previous = process.env.IS_HOSTED;
    process.env.IS_HOSTED = 'true';
    try {
      const app = buildApp();
      const partner = await createPartner({ slug: 'hosted-partner-4017' });
      await createPartnerAxisProvider(partner.id, { status: 'active', name: 'Hosted Okta' });

      const bySlug = await (await app.request('/auth/login-context/partner/hosted-partner-4017')).json();
      expect(bySlug.partnerSso.providerName).toBe('Hosted Okta');

      const singleton = await (await app.request('/auth/login-context')).json();
      expect(singleton).toEqual({ branding: null, partnerSso: null });
    } finally {
      if (previous === undefined) delete process.env.IS_HOSTED;
      else process.env.IS_HOSTED = previous;
    }
  });

  it('rate-limits by client after 30 requests, in a bucket separate from the singleton route', async () => {
    const app = buildApp();
    await createPartner({ slug: 'rl-partner-4017' });

    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await app.request('/auth/login-context/partner/rl-partner-4017')).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);

    // The singleton route's budget is untouched.
    expect((await app.request('/auth/login-context')).status).toBe(200);
  });
});
