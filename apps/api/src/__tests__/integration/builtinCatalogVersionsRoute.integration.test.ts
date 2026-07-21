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
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

let activeOrgId: string | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeOrgId) return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: activeOrgId,
        accessibleOrgIds: [activeOrgId],
        user: { id: null, email: 'integration@test' },
      });
      return withDbAccessContext(
        {
          scope: 'organization',
          orgId: activeOrgId,
          accessibleOrgIds: [activeOrgId],
          accessiblePartnerIds: null,
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

beforeEach(() => {
  activeOrgId = null;
});

afterEach(() => {
  activeOrgId = null;
  vi.clearAllMocks();
});

describe('built-in package versions via route (#1957)', () => {
  it('GET /catalog/:id/versions returns the built-in version for an org under its partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
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
    activeOrgId = org.id;
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

  it('does NOT leak a built-in (or its versions) to an org under a DIFFERENT partner', async () => {
    const partnerA = await createPartner();
    const { catalog } = await seedBuiltin(partnerA.id);

    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    activeOrgId = orgB.id;

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
});
