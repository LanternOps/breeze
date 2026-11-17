import './setup';

/**
 * #9087: POST /orgs/:orgId/trust-page/publish and /unpublish are self-managed DB-context routes. Drive the REAL
 * handlers over HTTP against real Postgres (forced RLS as breeze_app) and Redis, with the auth middleware
 * reproducing the production split: self-managed paths get NO ambient context, every other path gets the request
 * transaction. A handler step left outside its own `withAuthDbAccessContext` would fail here (contextless query),
 * and the public card proves "live when the response returns".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';

const authState = vi.hoisted(() => ({ ctx: null as null | { partnerId: string; orgId: string; userId: string } }));
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  const { isSelfManagedDbContextRoute } = await import('../../middleware/selfManagedDbContextRoutes');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      const s = authState.ctx;
      if (!s) return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', {
        scope: 'partner', partnerId: s.partnerId, partnerOrgAccess: 'all', orgId: null, accessibleOrgIds: [s.orgId],
        canAccessOrg: (id: string) => id === s.orgId, user: { id: s.userId, email: 'publisher@integration.test' }, token: { mfa: true },
      });
      // Production split (middleware/auth.ts runScopedHandler).
      if (isSelfManagedDbContextRoute(c.req.method, c.req.path)) return next();
      return withDbAccessContext(actual.buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [s.orgId], partnerId: s.partnerId, userId: s.userId }), () => next());
    },
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

import { getTestDb } from './setup';
import { auditLogs, trustPages } from '../../db/schema';
import { getRedis } from '../../services/redis';
import { rebuildServingSetFromDb, isServing } from '../../services/trustPage/servingSet';

async function buildApp() {
  const { trustPageRoutes } = await import('../../routes/trustPage');
  const { trustPagePublicRoutes } = await import('../../routes/trustPagePublic');
  const { trustPageAttestationRoutes } = await import('../../routes/trustPageAttestation');
  const app = new Hono();
  app.route('/api/v1/orgs', trustPageRoutes);
  // Production order (index.ts): the attestation prefix before the generic /trust router.
  app.route('/api/v1/trust/attestation', trustPageAttestationRoutes);
  app.route('/api/v1/trust', trustPagePublicRoutes);
  return app;
}

async function seed() {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `pr-int-${suffix}`;
  const orgSlug = `po-int-${suffix}`;
  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Route Partner', ${partnerSlug}, 'active', 'trusted', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`route-${suffix}@example.com`}, 'Publisher', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Route Org', ${orgSlug}, 'active', 'USD', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { partnerId: partner!.id, orgId: org!.id, userId: user!.id, partnerSlug, orgSlug };
}

async function waitForAudit(action: string, resourceId: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [row] = await getTestDb().select().from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId))).limit(1);
    if (row) return row;
    if (Date.now() > deadline) throw new Error(`audit row ${action} for ${resourceId} never appeared`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('trust-page publish/unpublish routes, self-managed (#9087)', () => {
  beforeEach(() => { authState.ctx = null; expect(getRedis()).not.toBeNull(); });

  it('publish commits, serves, audits and answers; the card is live on return; unpublish takes it down', async () => {
    const s = await seed();
    authState.ctx = { partnerId: s.partnerId, orgId: s.orgId, userId: s.userId };
    const app = await buildApp();
    const member = `${s.partnerSlug}/${s.orgSlug}`;
    // A built (empty) set: from here the card answers from the set alone, so a missing member is a 404.
    await rebuildServingSetFromDb();
    expect(await isServing(member)).toBe(false);

    // GET (not self-managed) creates the draft inside the request transaction.
    const draft = await app.request(`/api/v1/orgs/${s.orgId}/trust-page`, { headers: { authorization: 'Bearer t' } });
    expect(draft.status).toBe(200);

    const pub = await app.request(`/api/v1/orgs/${s.orgId}/trust-page/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, authorization: { authorizedBy: 'Jane Doe, COO' } }),
    });
    expect(pub.status).toBe(200);
    const body = (await pub.json()).data;
    expect(body.publicPath).toBe(`/portal/trust/${s.partnerSlug}/${s.orgSlug}`);
    expect(body.serving).toBe('applied');
    // Committed, served and cached before the response.
    const [row] = await getTestDb().select().from(trustPages).where(eq(trustPages.orgId, s.orgId));
    expect(row!.publishedAt).not.toBeNull();
    expect(await isServing(member)).toBe(true);
    const card = await app.request(`/api/v1/trust/card/${s.partnerSlug}/${s.orgSlug}`);
    expect(card.status).toBe(200);
    await waitForAudit('trust_page.publish', row!.id);

    const unpub = await app.request(`/api/v1/orgs/${s.orgId}/trust-page/unpublish`, { method: 'POST' });
    expect(unpub.status).toBe(200);
    expect((await unpub.json()).data.serving).toBe('applied');
    expect(await isServing(member)).toBe(false);
    expect((await app.request(`/api/v1/trust/card/${s.partnerSlug}/${s.orgSlug}`)).status).toBe(404);
    await waitForAudit('trust_page.unpublish', row!.id);
  });

  // #12103: the serving set is an admission filter, never an authority. A member it still holds after the DB says
  // unpublished (a reconcile that never ran, or the non-destructive fallback merge) must not serve anything: every
  // public route re-checks the live row and answers the generic 404.
  it('a member still in the serving set but unpublished in the DB is the generic 404 on every public route', async () => {
    const s = await seed();
    authState.ctx = { partnerId: s.partnerId, orgId: s.orgId, userId: s.userId };
    const app = await buildApp();
    const member = `${s.partnerSlug}/${s.orgSlug}`;
    await rebuildServingSetFromDb();
    const draft = await app.request(`/api/v1/orgs/${s.orgId}/trust-page`, { headers: { authorization: 'Bearer t' } });
    expect(draft.status).toBe(200);
    const pageId = (await draft.json()).data.page.id as string;
    // A public, disclosure-confirmed document, so the document route has something to serve while published.
    const [doc] = (await getTestDb().execute(sql`
      INSERT INTO org_documents (org_id, title, storage_backend, data, content_type, byte_size, sha256, original_filename)
      VALUES (${s.orgId}::uuid, 'Policy', 'db', '\\x01'::bytea, 'application/pdf', 1, ${'b'.repeat(64)}, 'policy.pdf')
      RETURNING id`)) as unknown as Array<{ id: string }>;
    await getTestDb().execute(sql`
      INSERT INTO trust_page_documents (trust_page_id, document_id, org_id, visibility, sort_order, disclosure_confirmed_at)
      VALUES (${pageId}::uuid, ${doc!.id}::uuid, ${s.orgId}::uuid, 'public', 0, now())`);

    const pub = await app.request(`/api/v1/orgs/${s.orgId}/trust-page/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, authorization: { authorizedBy: 'Jane Doe, COO' } }),
    });
    expect(pub.status).toBe(200);
    expect(await isServing(member)).toBe(true);

    const routes = {
      card: `/api/v1/trust/card/${s.partnerSlug}/${s.orgSlug}`,
      payload: `/api/v1/trust/public/${s.partnerSlug}/${s.orgSlug}`,
      badge: `/api/v1/trust/public/${s.partnerSlug}/${s.orgSlug}/badge.svg`,
      document: `/api/v1/trust/public/${s.partnerSlug}/${s.orgSlug}/documents/${doc!.id}`,
      attestation: `/api/v1/trust/attestation/${s.partnerSlug}/${s.orgSlug}`,
    };
    // Control: while published, every route gets past admission. The attestation may answer 503 when this
    // environment has no signing key; either way it is not the 404 asserted below.
    for (const [name, path] of Object.entries(routes)) {
      const res = await app.request(path);
      if (name === 'attestation') expect(res.status, name).not.toBe(404);
      else expect(res.status, name).toBe(200);
    }

    // Unpublished in the DB only; the set is left holding the member.
    await getTestDb().update(trustPages).set({ publishedAt: null }).where(eq(trustPages.orgId, s.orgId));
    expect(await isServing(member)).toBe(true);
    for (const [name, path] of Object.entries(routes)) {
      const res = await app.request(path);
      expect(res.status, name).toBe(404);
      expect(await res.json(), name).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
    }
  });

  it('a stale revision is a 409 inside the context and leaves the set and the page untouched', async () => {
    const s = await seed();
    authState.ctx = { partnerId: s.partnerId, orgId: s.orgId, userId: s.userId };
    const app = await buildApp();
    await rebuildServingSetFromDb();
    await app.request(`/api/v1/orgs/${s.orgId}/trust-page`, { headers: { authorization: 'Bearer t' } });
    const res = await app.request(`/api/v1/orgs/${s.orgId}/trust-page/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 5, authorization: { authorizedBy: 'Jane Doe, COO' } }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REVISION_MISMATCH');
    const [row] = await getTestDb().select().from(trustPages).where(eq(trustPages.orgId, s.orgId));
    expect(row!.publishedAt).toBeNull();
    expect(await isServing(`${s.partnerSlug}/${s.orgSlug}`)).toBe(false);
  });

  it('an org outside the caller\'s access is the generic 404', async () => {
    const s = await seed();
    const other = await seed();
    authState.ctx = { partnerId: s.partnerId, orgId: s.orgId, userId: s.userId };
    const app = await buildApp();
    const res = await app.request(`/api/v1/orgs/${other.orgId}/trust-page/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0 }),
    });
    expect(res.status).toBe(404);
  });
});
