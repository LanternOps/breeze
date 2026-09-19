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

const { deleteObjectsMock } = vi.hoisted(() => ({ deleteObjectsMock: vi.fn(async () => undefined) }));
vi.mock('../../services/s3Storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/s3Storage')>()),
  deleteObjects: deleteObjectsMock,
}));

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
        // Mirrors buildOrgAccessClosures in middleware/auth.ts: canAccessOrg is a
        // required member of AuthContext that both real constructors always set,
        // so a stub that omits it makes the route throw instead of authorizing.
        canAccessOrg: (orgId: string) => orgId === activeOrgId,
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
import {
  devices,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwareInventory,
  softwareVersions,
} from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';

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

function deploymentFor(orgId: string, softwareVersionId: string, name: string) {
  return {
    orgId,
    name,
    softwareVersionId,
    deploymentType: 'install' as const,
    targetType: 'device' as const,
    scheduleType: 'immediate' as const,
  };
}

function methodDeploymentFor(orgId: string, installMethodId: string, name: string) {
  return {
    orgId,
    name,
    installMethodId,
    deploymentType: 'install' as const,
    targetType: 'device' as const,
    scheduleType: 'immediate' as const,
  };
}

async function seedInstallMethod(catalogId: string) {
  const [method] = await getTestDb().insert(softwareInstallMethods).values({
    catalogId,
    platform: 'windows',
    kind: 'winget',
    packageId: `Synthetic.Package.${crypto.randomUUID()}`,
  }).returning();
  if (!method) throw new Error('failed to seed install method');
  return method;
}

async function expectStillBlocked<T>(promise: Promise<T>) {
  expect(await Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
  ])).toBe('blocked');
}

beforeEach(() => {
  activeOrgId = null;
  deleteObjectsMock.mockReset();
  deleteObjectsMock.mockResolvedValue(undefined);
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

  it('returns 409 before storage deletion when an install-method deployment references the catalog', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb().update(softwareVersions).set({ s3Key: 'software/test/method-ref.msi' })
      .where(eq(softwareVersions.id, version.id));
    const method = await seedInstallMethod(catalog.id);
    await getTestDb().insert(softwareDeployments)
      .values(methodDeploymentFor(org.id, method.id, 'Method reference'));

    const res = await (await buildApp()).request(
      `/software/catalog/${catalog.id}?orgId=${org.id}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer token' } },
    );
    expect(res.status).toBe(409);
    expect(deleteObjectsMock).not.toHaveBeenCalled();
    expect(await getTestDb().select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id)))
      .toHaveLength(1);
  });

  it('returns 409 before storage deletion when software inventory references the catalog', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    activeOrgId = org.id;
    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb().update(softwareVersions).set({ s3Key: 'software/test/inventory-ref.msi' })
      .where(eq(softwareVersions.id, version.id));
    const [device] = await getTestDb().insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `catalog-delete-${crypto.randomUUID()}`,
      hostname: 'catalog-delete-inventory',
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '1.0.0',
    }).returning();
    if (!device) throw new Error('failed to seed inventory device');
    await getTestDb().insert(softwareInventory).values({
      deviceId: device.id,
      orgId: org.id,
      catalogId: catalog.id,
      name: 'Synthetic installed package',
    });

    const res = await (await buildApp()).request(
      `/software/catalog/${catalog.id}?orgId=${org.id}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer token' } },
    );
    expect(res.status).toBe(409);
    expect(deleteObjectsMock).not.toHaveBeenCalled();
    expect(await getTestDb().select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id)))
      .toHaveLength(1);
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

  it('deletes uploaded package objects before removing their locator rows', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb().update(softwareVersions).set({ s3Key: 'software/test/package.msi' })
      .where(eq(softwareVersions.id, version.id));

    deleteObjectsMock.mockImplementation(async () => {
      const [row] = await getTestDb().select({ id: softwareVersions.id })
        .from(softwareVersions).where(eq(softwareVersions.id, version.id));
      expect(row).toBeDefined();
    });

    const app = await buildApp();
    const res = await app.request(`/software/catalog/${catalog.id}?orgId=${org.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(200);
    expect(deleteObjectsMock).toHaveBeenCalledWith(['software/test/package.msi']);
  });

  it('preserves the catalog locator when object deletion fails', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb().update(softwareVersions).set({ s3Key: 'software/test/package.msi' })
      .where(eq(softwareVersions.id, version.id));
    deleteObjectsMock.mockRejectedValueOnce(new Error('synthetic storage failure'));

    const app = await buildApp();
    const res = await app.request(`/software/catalog/${catalog.id}?orgId=${org.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(500);
    const [row] = await getTestDb().select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id));
    expect(row).toBeDefined();
  });

  it('serializes a concurrent version insert behind catalog deletion', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
    const { catalog } = await seedCatalogWithVersion(org.id);

    let enteredDelete!: () => void;
    const deleting = new Promise<void>((resolve) => { enteredDelete = resolve; });
    let releaseDelete!: () => void;
    const release = new Promise<void>((resolve) => { releaseDelete = resolve; });
    deleteObjectsMock.mockImplementationOnce(async () => {
      enteredDelete();
      await release;
    });

    const app = await buildApp();
    const deleteRequest = app.request(`/software/catalog/${catalog.id}?orgId=${org.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer token' },
    });
    await deleting;

    const insertResult = getTestDb().insert(softwareVersions).values({
      catalogId: catalog.id,
      version: '2.0.0',
      isLatest: false,
    }).then(() => 'inserted' as const, (error: unknown) => ({ error }));
    expect(await Promise.race([
      insertResult,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ])).toBe('blocked');

    releaseDelete();
    expect((await deleteRequest).status).toBe(200);
    const outcome = await insertResult;
    expect(outcome).toEqual({ error: expect.anything() });
    const error = (outcome as { error: { code?: string; cause?: { code?: string } } }).error;
    expect(error.code ?? error.cause?.code).toBe('23503');
  });

  it('deployment-wins: waits for the referencing transaction, then returns 409 without deleting the object', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb().update(softwareVersions).set({ s3Key: 'software/test/deployment-wins.msi' })
      .where(eq(softwareVersions.id, version.id));

    let referenceInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { referenceInserted = resolve; });
    let releaseReference!: () => void;
    const release = new Promise<void>((resolve) => { releaseReference = resolve; });
    const deploymentTransaction = getTestDb().transaction(async (tx) => {
      await tx.insert(softwareDeployments)
        .values(deploymentFor(org.id, version.id, 'Deployment wins'));
      referenceInserted();
      await release;
    });
    await inserted;

    const app = await buildApp();
    const deleting = Promise.resolve(app.request(`/software/catalog/${catalog.id}?orgId=${org.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer token' },
    }));
    await expectStillBlocked(deleting);

    releaseReference();
    await deploymentTransaction;
    expect((await deleting).status).toBe(409);
    expect(deleteObjectsMock).not.toHaveBeenCalled();
    const [stillThere] = await getTestDb().select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id));
    expect(stillThere).toBeDefined();
  });

  it('delete-wins: fences a later deployment until the version and object are gone', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb().update(softwareVersions).set({ s3Key: 'software/test/delete-wins.msi' })
      .where(eq(softwareVersions.id, version.id));

    let objectDeleteEntered!: () => void;
    const entered = new Promise<void>((resolve) => { objectDeleteEntered = resolve; });
    let releaseObjectDelete!: () => void;
    const release = new Promise<void>((resolve) => { releaseObjectDelete = resolve; });
    deleteObjectsMock.mockImplementationOnce(async () => {
      objectDeleteEntered();
      await release;
    });

    const app = await buildApp();
    const deleting = app.request(`/software/catalog/${catalog.id}?orgId=${org.id}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer token' },
    });
    await entered;

    const inserting = getTestDb().insert(softwareDeployments)
      .values(deploymentFor(org.id, version.id, 'Delete wins'))
      .then(() => 'inserted' as const, (error: unknown) => ({ error }));
    await expectStillBlocked(inserting);

    releaseObjectDelete();
    expect((await deleting).status).toBe(200);
    const outcome = await inserting;
    expect(outcome).toEqual({ error: expect.anything() });
    const error = (outcome as { error: { code?: string; cause?: { code?: string } } }).error;
    expect(error.code ?? error.cause?.code).toBe('23503');
    expect(deleteObjectsMock).toHaveBeenCalledWith(['software/test/delete-wins.msi']);
  });

  it('method deployment-wins: waits, then returns 409 without deleting the object', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb().update(softwareVersions).set({ s3Key: 'software/test/method-deployment-wins.msi' })
      .where(eq(softwareVersions.id, version.id));
    const method = await seedInstallMethod(catalog.id);

    let referenceInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { referenceInserted = resolve; });
    let releaseReference!: () => void;
    const release = new Promise<void>((resolve) => { releaseReference = resolve; });
    const deploymentTransaction = getTestDb().transaction(async (tx) => {
      await tx.insert(softwareDeployments)
        .values(methodDeploymentFor(org.id, method.id, 'Method deployment wins'));
      referenceInserted();
      await release;
    });
    await inserted;

    const deleting = Promise.resolve((await buildApp()).request(
      `/software/catalog/${catalog.id}?orgId=${org.id}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer token' } },
    ));
    await expectStillBlocked(deleting);
    releaseReference();
    await deploymentTransaction;
    expect((await deleting).status).toBe(409);
    expect(deleteObjectsMock).not.toHaveBeenCalled();
  });

  it('method delete-wins: fences a later deployment until the method is gone', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeOrgId = org.id;
    const { catalog, version } = await seedCatalogWithVersion(org.id);
    await getTestDb().update(softwareVersions).set({ s3Key: 'software/test/method-delete-wins.msi' })
      .where(eq(softwareVersions.id, version.id));
    const method = await seedInstallMethod(catalog.id);

    let objectDeleteEntered!: () => void;
    const entered = new Promise<void>((resolve) => { objectDeleteEntered = resolve; });
    let releaseObjectDelete!: () => void;
    const release = new Promise<void>((resolve) => { releaseObjectDelete = resolve; });
    deleteObjectsMock.mockImplementationOnce(async () => {
      objectDeleteEntered();
      await release;
    });

    const deleting = (await buildApp()).request(
      `/software/catalog/${catalog.id}?orgId=${org.id}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer token' } },
    );
    await entered;
    const inserting = getTestDb().insert(softwareDeployments)
      .values(methodDeploymentFor(org.id, method.id, 'Method delete loses'))
      .then(() => 'inserted' as const, (error: unknown) => ({ error }));
    await expectStillBlocked(inserting);
    releaseObjectDelete();
    expect((await deleting).status).toBe(200);
    const outcome = await inserting;
    expect(outcome).toEqual({ error: expect.anything() });
    const error = (outcome as { error: { code?: string; cause?: { code?: string } } }).error;
    expect(error.code ?? error.cause?.code).toBe('23503');
  });
});

describe('tenant cascade catalog serialization', () => {
  async function expectInsertFenced(
    owner: { orgId: string } | { partnerId: string },
    catalogId: string,
  ) {
    const [version] = await getTestDb().insert(softwareVersions).values({
      catalogId,
      version: '1.0.0',
      isLatest: true,
      s3Key: `software/synthetic/${catalogId}/1.0.0.msi`,
    }).returning();
    expect(version).toBeDefined();

    let inventoryLocked!: () => void;
    const locked = new Promise<void>((resolve) => { inventoryLocked = resolve; });
    let releaseDelete!: () => void;
    const release = new Promise<void>((resolve) => { releaseDelete = resolve; });
    deleteObjectsMock.mockImplementationOnce(async () => {
      inventoryLocked();
      await release;
    });

    const { __testOnly } = await import('../../services/tenantCascade');
    const deleting = __testOnly.deleteSoftwareCatalogsAndObjects(owner);
    await locked;

    const inserting = getTestDb().insert(softwareVersions).values({
      catalogId,
      version: '2.0.0',
      isLatest: false,
      s3Key: `software/synthetic/${catalogId}/2.0.0.msi`,
    }).then(() => 'inserted' as const, (error: unknown) => ({ error }));
    expect(await Promise.race([
      inserting,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ])).toBe('blocked');

    releaseDelete();
    expect(await deleting).toEqual({ catalogs: 1, versions: 1 });
    const outcome = await inserting;
    expect(outcome).toEqual({ error: expect.anything() });
    const error = (outcome as { error: { code?: string; cause?: { code?: string } } }).error;
    expect(error.code ?? error.cause?.code).toBe('23503');
  }

  it('holds the org catalog parent through object, version, and catalog deletion', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog)
      .values({ orgId: org.id, name: 'Synthetic org package' }).returning();
    if (!catalog) throw new Error('failed to seed org catalog');
    await expectInsertFenced({ orgId: org.id }, catalog.id);
  });

  it('holds the partner catalog parent through object, version, and catalog deletion', async () => {
    const partner = await createPartner();
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      partnerId: partner.id,
      integrationProvider: 'huntress',
      name: 'Synthetic partner package',
    }).returning();
    if (!catalog) throw new Error('failed to seed partner catalog');
    await expectInsertFenced({ partnerId: partner.id }, catalog.id);
  });

  async function expectLateDeploymentAbortsBeforeObjectDelete(
    owner: { orgId: string } | { partnerId: string },
    orgId: string,
    catalogId: string,
    target: 'version' | 'method' = 'version',
  ) {
    const [version] = await getTestDb().insert(softwareVersions).values({
      catalogId,
      version: '1.0.0',
      isLatest: true,
      s3Key: `software/synthetic/${catalogId}/late-deployment.msi`,
    }).returning();
    if (!version) throw new Error('failed to seed version');
    const method = target === 'method' ? await seedInstallMethod(catalogId) : null;

    let referenceInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { referenceInserted = resolve; });
    let releaseReference!: () => void;
    const release = new Promise<void>((resolve) => { releaseReference = resolve; });
    const deploymentTransaction = getTestDb().transaction(async (tx) => {
      await tx.insert(softwareDeployments)
        .values(target === 'method'
          ? methodDeploymentFor(orgId, method!.id, 'Late cascade method deployment')
          : deploymentFor(orgId, version.id, 'Late cascade deployment'));
      referenceInserted();
      await release;
    });
    await inserted;

    const { __testOnly } = await import('../../services/tenantCascade');
    const deleting = __testOnly.deleteSoftwareCatalogsAndObjects(owner);
    await expectStillBlocked(deleting);
    releaseReference();
    await deploymentTransaction;

    await expect(deleting).rejects.toThrow(/concurrent deployment reference/i);
    expect(deleteObjectsMock).not.toHaveBeenCalled();
    const [stillThere] = await getTestDb().select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id));
    expect(stillThere).toBeDefined();
  }

  async function expectCascadeDeleteFencesLateDeployment(
    owner: { orgId: string } | { partnerId: string },
    orgId: string,
    catalogId: string,
    target: 'version' | 'method' = 'version',
  ) {
    const [version] = await getTestDb().insert(softwareVersions).values({
      catalogId,
      version: '2.0.0',
      isLatest: true,
      s3Key: `software/synthetic/${catalogId}/delete-wins.msi`,
    }).returning();
    if (!version) throw new Error('failed to seed version');
    const method = target === 'method' ? await seedInstallMethod(catalogId) : null;

    let objectDeleteEntered!: () => void;
    const entered = new Promise<void>((resolve) => { objectDeleteEntered = resolve; });
    let releaseObjectDelete!: () => void;
    const release = new Promise<void>((resolve) => { releaseObjectDelete = resolve; });
    deleteObjectsMock.mockImplementationOnce(async () => {
      objectDeleteEntered();
      await release;
    });

    const { __testOnly } = await import('../../services/tenantCascade');
    const deleting = __testOnly.deleteSoftwareCatalogsAndObjects(owner);
    await entered;

    const inserting = getTestDb().insert(softwareDeployments)
      .values(target === 'method'
        ? methodDeploymentFor(orgId, method!.id, 'Late method deployment loses')
        : deploymentFor(orgId, version.id, 'Late deployment loses'))
      .then(() => 'inserted' as const, (error: unknown) => ({ error }));
    await expectStillBlocked(inserting);

    releaseObjectDelete();
    await expect(deleting).resolves.toEqual({ catalogs: 1, versions: 1 });
    const outcome = await inserting;
    expect(outcome).toEqual({ error: expect.anything() });
    const error = (outcome as { error: { code?: string; cause?: { code?: string } } }).error;
    expect(error.code ?? error.cause?.code).toBe('23503');
    expect(deleteObjectsMock).toHaveBeenCalledWith([
      `software/synthetic/${catalogId}/delete-wins.msi`,
    ]);
  }

  it('org cascade deployment-wins: aborts before object deletion and preserves the locator', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog)
      .values({ orgId: org.id, name: 'Org late-deployment package' }).returning();
    if (!catalog) throw new Error('failed to seed org catalog');
    await expectLateDeploymentAbortsBeforeObjectDelete({ orgId: org.id }, org.id, catalog.id);
  });

  it('partner cascade deployment-wins: aborts before object deletion and preserves the locator', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      partnerId: partner.id,
      integrationProvider: 'huntress',
      name: 'Partner late-deployment package',
    }).returning();
    if (!catalog) throw new Error('failed to seed partner catalog');
    await expectLateDeploymentAbortsBeforeObjectDelete(
      { partnerId: partner.id }, org.id, catalog.id,
    );
  });

  it('org cascade delete-wins: fences a later deployment until the version is gone', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog)
      .values({ orgId: org.id, name: 'Org delete-wins package' }).returning();
    if (!catalog) throw new Error('failed to seed org catalog');
    await expectCascadeDeleteFencesLateDeployment({ orgId: org.id }, org.id, catalog.id);
  });

  it('partner cascade delete-wins: fences a later deployment until the version is gone', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      partnerId: partner.id,
      integrationProvider: 'huntress',
      name: 'Partner delete-wins package',
    }).returning();
    if (!catalog) throw new Error('failed to seed partner catalog');
    await expectCascadeDeleteFencesLateDeployment(
      { partnerId: partner.id }, org.id, catalog.id,
    );
  });

  it('org cascade method deployment-wins: aborts before object deletion', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog)
      .values({ orgId: org.id, name: 'Org late-method package' }).returning();
    if (!catalog) throw new Error('failed to seed org catalog');
    await expectLateDeploymentAbortsBeforeObjectDelete(
      { orgId: org.id }, org.id, catalog.id, 'method',
    );
  });

  it('partner cascade method deployment-wins: aborts before object deletion', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      partnerId: partner.id,
      integrationProvider: 'huntress',
      name: 'Partner late-method package',
    }).returning();
    if (!catalog) throw new Error('failed to seed partner catalog');
    await expectLateDeploymentAbortsBeforeObjectDelete(
      { partnerId: partner.id }, org.id, catalog.id, 'method',
    );
  });

  it('org cascade method delete-wins: fences a later deployment until the method is gone', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog)
      .values({ orgId: org.id, name: 'Org method-delete package' }).returning();
    if (!catalog) throw new Error('failed to seed org catalog');
    await expectCascadeDeleteFencesLateDeployment(
      { orgId: org.id }, org.id, catalog.id, 'method',
    );
  });

  it('partner cascade method delete-wins: fences a later deployment until the method is gone', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      partnerId: partner.id,
      integrationProvider: 'huntress',
      name: 'Partner method-delete package',
    }).returning();
    if (!catalog) throw new Error('failed to seed partner catalog');
    await expectCascadeDeleteFencesLateDeployment(
      { partnerId: partner.id }, org.id, catalog.id, 'method',
    );
  });
});
