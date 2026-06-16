/**
 * Software-catalog delete vs. deployment FK (#1407).
 *
 * software_deployments.software_version_id references software_versions with
 * the default ON DELETE RESTRICT, so deleting a catalog item whose version is
 * still referenced by a deployment used to throw an unhandled 500 (FK
 * violation). Drives the real DELETE /software/catalog/:id route against the
 * real docker postgres as breeze_app and proves it now returns a clean 409
 * (and preserves the row) when a deployment still references the version, and
 * still deletes (200) when nothing references it.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

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
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

import { getTestDb } from './setup';
import { softwareCatalog, softwareVersions, softwareDeployments } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';

async function buildApp() {
  const { softwareRoutes } = await import('../../routes/software');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/software', softwareRoutes);
  return app;
}

async function seedCatalogWithVersion(orgId: string) {
  const [catalog] = await getTestDb()
    .insert(softwareCatalog)
    .values({ orgId, name: 'Acme Tool' })
    .returning();
  if (!catalog) throw new Error('failed to seed catalog');
  const [version] = await getTestDb()
    .insert(softwareVersions)
    .values({ catalogId: catalog.id, version: '1.0.0', isLatest: true })
    .returning();
  if (!version) throw new Error('failed to seed version');
  return { catalog, version };
}

beforeEach(() => {
  activeOrgId = null;
});

afterEach(() => {
  activeOrgId = null;
  vi.clearAllMocks();
});

describe('DELETE /software/catalog/:id vs deployment FK (#1407)', () => {
  it('returns 409 (not 500) and preserves the item when a version is still deployed', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;

    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb()
      .insert(softwareDeployments)
      .values({
        orgId: org.id,
        name: 'Deploy Acme',
        softwareVersionId: version.id,
        deploymentType: 'install',
        targetType: 'device',
        scheduleType: 'immediate',
      });

    const app = await buildApp();
    const res = await app.request(`/software/catalog/${catalog.id}?orgId=${org.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/deployment/i);

    // The catalog item (and its version) must survive — history preserved.
    const [stillThere] = await getTestDb()
      .select({ id: softwareCatalog.id })
      .from(softwareCatalog)
      .where(eq(softwareCatalog.id, catalog.id))
      .limit(1);
    expect(stillThere).toBeDefined();
  });

  it('deletes (200) when no deployment references the versions', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;

    const { catalog } = await seedCatalogWithVersion(org.id);

    const app = await buildApp();
    const res = await app.request(`/software/catalog/${catalog.id}?orgId=${org.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);

    const [gone] = await getTestDb()
      .select({ id: softwareCatalog.id })
      .from(softwareCatalog)
      .where(eq(softwareCatalog.id, catalog.id))
      .limit(1);
    expect(gone).toBeUndefined();
  });
});
