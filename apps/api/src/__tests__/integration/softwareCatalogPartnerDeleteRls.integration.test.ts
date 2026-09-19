/**
 * Partner-wide catalog deletion must inspect deployment references outside the
 * authenticated request's organization RLS ceiling. A full-partner member's
 * request context intentionally omits suspended organizations, but deployments
 * in those organizations still hold a real FK to shared package versions.
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
import { softwareCatalog, softwareDeployments, softwareVersions } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP);

describe('partner-wide catalog deletion across lifecycle-hidden organizations', () => {
  runDb('returns 409 before storage deletion when a suspended org retains a deployment', async () => {
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
    const [version] = await database.insert(softwareVersions).values({
      catalogId: catalog.id,
      version: '1.0.0',
      isLatest: true,
      s3Key: `software/partner/${env.partner.id}/shared.msi`,
    }).returning();
    if (!version) throw new Error('failed to seed package version');
    const [deployment] = await database.insert(softwareDeployments).values({
      orgId: suspended.id,
      name: 'Synthetic suspended-org deployment',
      softwareVersionId: version.id,
      deploymentType: 'install',
      targetType: 'device',
      scheduleType: 'immediate',
    }).returning();
    if (!deployment) throw new Error('failed to seed deployment');

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

    const denied = await app.request(`/software/catalog/${catalog.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(denied.status, await denied.clone().text()).toBe(409);
    expect(deleteObjectsMock).not.toHaveBeenCalled();
    expect(await database.select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id)))
      .toHaveLength(1);
    expect(await database.select({ id: softwareDeployments.id })
      .from(softwareDeployments).where(eq(softwareDeployments.id, deployment.id)))
      .toHaveLength(1);

    // Removing the genuine reference restores the ordinary full-partner delete
    // path and proves the system-scoped recheck did not turn into a blanket deny.
    await database.delete(softwareDeployments).where(eq(softwareDeployments.id, deployment.id));
    const allowed = await app.request(`/software/catalog/${catalog.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect(deleteObjectsMock).toHaveBeenCalledWith([
      `software/partner/${env.partner.id}/shared.msi`,
    ]);
    expect(await database.select({ id: softwareVersions.id })
      .from(softwareVersions).where(eq(softwareVersions.id, version.id)))
      .toHaveLength(0);
  });
});
