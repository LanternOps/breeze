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
