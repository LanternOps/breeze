/**
 * Partner-wide catalog deletion must inspect deployment references outside the
 * authenticated request's organization RLS ceiling. A full-partner member's
 * request context intentionally omits suspended organizations, but deployments
 * in those organizations still hold a real FK to shared package versions.
 * Such a hidden reference must never lead to a hard delete or storage-object
 * deletion: the package is archived instead (#4980), and only a package with
 * no reference anywhere is hard-deleted.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const { deleteObjectsMock } = vi.hoisted(() => ({
  deleteObjectsMock: vi.fn(async () => undefined),
}));
vi.mock('../../services/s3Storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/s3Storage')>()),
  deleteObjects: deleteObjectsMock,
}));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeRouteAudit: vi.fn(),
}));

import { getTestDb } from './setup';
import { createOrganization, setupTestEnvironment } from './db-utils';
import {
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwareVersions,
} from '../../db/schema';
import { createAccessToken } from '../../services/jwt';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP);

async function seedPartnerPackage(withHiddenDeployment: boolean) {
  deleteObjectsMock.mockClear();
  const env = await setupTestEnvironment({ scope: 'partner' });
  const suspended = await createOrganization({
    partnerId: env.partner.id,
    name: 'Synthetic suspended deployment owner',
    status: 'suspended',
  });
  const database = getTestDb();
  const [catalog] = await database.insert(softwareCatalog).values({
    partnerId: env.partner.id,
    name: 'Synthetic shared package',
  }).returning();
  if (!catalog) throw new Error('failed to seed partner-wide catalog');
  const s3Key = `software/partner/${env.partner.id}/${catalog.id}/shared.msi`;
  const [version] = await database.insert(softwareVersions).values({
    catalogId: catalog.id,
    version: '1.0.0',
    isLatest: true,
    s3Key,
  }).returning();
  if (!version) throw new Error('failed to seed package version');
  const [method] = await database.insert(softwareInstallMethods).values({
    catalogId: catalog.id,
    platform: 'windows',
    kind: 'winget',
    packageId: `Synthetic.Shared.${randomUUID()}`,
  }).returning();
  if (!method) throw new Error('failed to seed install method');
  let deploymentId: string | null = null;
  if (withHiddenDeployment) {
    const [deployment] = await database.insert(softwareDeployments).values({
      orgId: suspended.id,
      name: 'Synthetic suspended-org deployment',
      softwareVersionId: version.id,
      deploymentType: 'install',
      targetType: 'device',
      scheduleType: 'immediate',
    }).returning();
    if (!deployment) throw new Error('failed to seed deployment');
    deploymentId = deployment.id;
  }

  const token = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
  const app = new Hono();
  const { softwareRoutes } = await import('../../routes/software');
  app.route('/software', softwareRoutes);
  const deleteCatalog = () => app.request(`/software/catalog/${catalog.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return { database, catalog, version, method, deploymentId, s3Key, deleteCatalog };
}

describe('partner-wide catalog deletion across lifecycle-hidden organizations', () => {
  runDb('archives (never hard-deletes) when only a suspended org retains a deployment', async () => {
    const { database, catalog, version, method, deploymentId, s3Key, deleteCatalog } =
      await seedPartnerPackage(true);

    const res = await deleteCatalog();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ success: true, id: catalog.id, archived: true });

    // The RLS-invisible reference was seen: nothing was removed from storage
    // or the database, the package was only archived.
    expect(deleteObjectsMock).not.toHaveBeenCalled();
    const [row] = await database.select({ deletedAt: softwareCatalog.deletedAt })
      .from(softwareCatalog).where(eq(softwareCatalog.id, catalog.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await database.select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id)))
      .toHaveLength(1);
    expect(await database.select({ id: softwareInstallMethods.id })
      .from(softwareInstallMethods).where(eq(softwareInstallMethods.id, method.id)))
      .toHaveLength(1);
    expect(await database.select({ id: softwareDeployments.id, versionId: softwareDeployments.softwareVersionId })
      .from(softwareDeployments).where(eq(softwareDeployments.id, deploymentId!)))
      .toEqual([{ id: deploymentId, versionId: version.id }]);
  });

  runDb('hard-deletes the package and its objects when no org references it', async () => {
    const { database, catalog, version, method, s3Key, deleteCatalog } =
      await seedPartnerPackage(false);

    // Companion to the case above: the same setup minus the hidden-org
    // deployment takes the ordinary delete path, proving the system-scoped
    // reference check is what chose archive, not a blanket rule.
    const res = await deleteCatalog();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ success: true, id: catalog.id });
    expect(deleteObjectsMock).toHaveBeenCalledWith([s3Key]);
    expect(await database.select({ id: softwareCatalog.id })
      .from(softwareCatalog).where(eq(softwareCatalog.id, catalog.id)))
      .toHaveLength(0);
    expect(await database.select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id)))
      .toHaveLength(0);
    expect(await database.select({ id: softwareInstallMethods.id })
      .from(softwareInstallMethods).where(eq(softwareInstallMethods.id, method.id)))
      .toHaveLength(0);
  });
});
