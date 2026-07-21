/**
 * Built-in package versions are readable through the ROUTE by an org member (#1957).
 *
 * Built-in EDR packages (Huntress/SentinelOne) live in software_catalog with
 * org_id NULL + partner_id set. The 2026-07-02 migration broadened RLS so an
 * org-scoped caller can read their OWN partner's built-in + its versions, and
 * the /catalog LIST route was widened to surface them — but GET /catalog/:id
 * and GET /catalog/:id/versions still filtered `eq(org_id)`, which structurally
 * excludes an org_id-NULL row. The version fetch 404'd, the deploy wizard showed
 * "No versions" with a grayed-out deploy, and the package's Versions tab was
 * blank. builtinCatalogRls.integration.test.ts proves the DB policy is correct;
 * only this route-level path proves the handler's WHERE no longer drops built-ins.
 *
 * Drives the real softwareRoutes against the real docker postgres as breeze_app.
 * NOTE: these cases MUST stay in the real-DB integration suite — built-in
 * cross-partner isolation is enforced by RLS, and the mocked `drizzle-orm` in
 * software.test.ts ignores WHERE clauses, so an isolation assertion there would
 * pass vacuously. Do not "simplify" this into the unit suite.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mutable per-test auth context: the mocked authMiddleware injects it and opens
// the matching real DB (RLS) context, so tests can drive both organization- and
// partner-scoped callers through the same real RLS boundary the handler trusts.
type ActiveAuth = {
  scope: 'organization' | 'partner';
  orgId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[];
};
let activeAuth: ActiveAuth | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuth) return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', {
        scope: activeAuth.scope,
        partnerId: activeAuth.partnerId,
        orgId: activeAuth.orgId,
        accessibleOrgIds: activeAuth.accessibleOrgIds,
        user: { id: null, email: 'integration@test' },
      });
      return withDbAccessContext(
        {
          scope: activeAuth.scope,
          orgId: activeAuth.orgId,
          accessibleOrgIds: activeAuth.accessibleOrgIds,
          accessiblePartnerIds:
            activeAuth.scope === 'partner' && activeAuth.partnerId ? [activeAuth.partnerId] : null,
          currentPartnerId: activeAuth.partnerId,
          userId: null,
        },
        () => next(),
      );
    },
    requireScope: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

vi.mock('../../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

import { getTestDb } from './setup';
import { softwareCatalog, softwareVersions } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';

async function buildApp() {
  const { softwareRoutes } = await import('../../routes/software');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/software', softwareRoutes);
  return app;
}

/** Seed a partner-scoped built-in Huntress package + templated version (org_id NULL). */
async function seedBuiltin(partnerId: string) {
  const [catalog] = await getTestDb()
    .insert(softwareCatalog)
    .values({
      orgId: null,
      partnerId,
      integrationProvider: 'huntress',
      name: 'Huntress EDR Agent',
      vendor: 'Huntress',
      category: 'security',
      isManaged: true,
    })
    .returning();
  if (!catalog) throw new Error('failed to seed built-in catalog');
  const [version] = await getTestDb()
    .insert(softwareVersions)
    .values({
      catalogId: catalog.id,
      version: 'latest',
      downloadUrl: 'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe',
      fileType: 'exe',
      isLatest: true,
    })
    .returning();
  if (!version) throw new Error('failed to seed built-in version');
  return { catalog, version };
}

/** Seed a normal org-owned package + version (org_id set, partner_id NULL). */
async function seedOrgOwned(orgId: string) {
  const [catalog] = await getTestDb()
    .insert(softwareCatalog)
    .values({ orgId, name: 'Acme Tool', vendor: 'Acme', category: 'utility' })
    .returning();
  if (!catalog) throw new Error('failed to seed org-owned catalog');
  const [version] = await getTestDb()
    .insert(softwareVersions)
    .values({ catalogId: catalog.id, version: '1.0.0', fileType: 'exe', isLatest: true })
    .returning();
  if (!version) throw new Error('failed to seed org-owned version');
  return { catalog, version };
}

beforeEach(() => {
  activeAuth = null;
});

afterEach(() => {
  activeAuth = null;
  vi.clearAllMocks();
});

describe('built-in package versions via route (#1957)', () => {
  it('GET /catalog/:id/versions returns the built-in version for an org under its partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeAuth = { scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const { catalog } = await seedBuiltin(partner.id);

    const app = await buildApp();
    const res = await app.request(
      `/software/catalog/${catalog.id}/versions?orgId=${org.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );

    // Before the fix this 404'd (eq(org_id) excludes the org_id-NULL built-in),
    // yielding the "No versions" / blank Versions tab.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].version).toBe('latest');
  });

  it('GET /catalog/:id returns the built-in item with versionCount for an org under its partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeAuth = { scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const { catalog } = await seedBuiltin(partner.id);

    const app = await buildApp();
    const res = await app.request(
      `/software/catalog/${catalog.id}?orgId=${org.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.integrationProvider).toBe('huntress');
    expect(Number(body.data.versionCount)).toBe(1);
  });

  // Regression guard for the dominant production path (MSP-uploaded custom
  // packages): the fix rewrote the WHERE clause for org-owned rows too, so prove
  // an org still reads its OWN org-scoped package. Nothing else (the mocked unit
  // suite ignores WHERE) covers this.
  it('GET /catalog/:id + /versions still return an org-owned (non-built-in) package', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeAuth = { scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const { catalog } = await seedOrgOwned(org.id);

    const app = await buildApp();
    const itemRes = await app.request(
      `/software/catalog/${catalog.id}?orgId=${org.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(itemRes.status).toBe(200);
    expect(Number((await itemRes.json()).data.versionCount)).toBe(1);

    const versionsRes = await app.request(
      `/software/catalog/${catalog.id}/versions?orgId=${org.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(versionsRes.status).toBe(200);
    expect((await versionsRes.json()).data).toHaveLength(1);
  });

  it('does NOT leak a built-in (or its versions) to an org under a DIFFERENT partner', async () => {
    const partnerA = await createPartner();
    const { catalog } = await seedBuiltin(partnerA.id);

    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    activeAuth = { scope: 'organization', orgId: orgB.id, partnerId: partnerB.id, accessibleOrgIds: [orgB.id] };

    const app = await buildApp();
    const versionsRes = await app.request(
      `/software/catalog/${catalog.id}/versions?orgId=${orgB.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(versionsRes.status).toBe(404);

    const itemRes = await app.request(
      `/software/catalog/${catalog.id}?orgId=${orgB.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(itemRes.status).toBe(404);
  });

  // Under PARTNER scope RLS exposes every org under the partner, so the JS guard
  // (item.orgId !== orgId) — dead code under org scope, where RLS pre-filters to
  // one org — is the ONLY thing stopping a partner caller from reading sibling
  // org B's package by id while scoped to org A. Proves that branch works, and
  // that the same partner's built-in is still readable.
  it('partner-scope caller: reads own built-in (200) but not a sibling org-owned package (404)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const { catalog: builtin } = await seedBuiltin(partner.id);
    const { catalog: orgBPkg } = await seedOrgOwned(orgB.id);

    // Partner admin acting in org A's context (orgId=orgA) but with partner-wide
    // RLS visibility across both orgs.
    activeAuth = {
      scope: 'partner',
      orgId: null,
      partnerId: partner.id,
      accessibleOrgIds: [orgA.id, orgB.id],
    };

    const app = await buildApp();
    const builtinRes = await app.request(
      `/software/catalog/${builtin.id}/versions?orgId=${orgA.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(builtinRes.status).toBe(200);

    // org B's package is RLS-visible to this partner caller, but resolved orgId is
    // org A → the JS guard must reject the cross-org read.
    const siblingRes = await app.request(
      `/software/catalog/${orgBPkg.id}?orgId=${orgA.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(siblingRes.status).toBe(404);
  });
});
