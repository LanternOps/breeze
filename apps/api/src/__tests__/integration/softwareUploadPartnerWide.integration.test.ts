/**
 * Partner-wide package upload, end to end through the real software router on
 * real Postgres as `breeze_app` (#11412 W01, origin #9246). Object storage is
 * mocked; auth, RBAC, RLS and the session/catalog/version writes are real (MFA
 * is satisfied by the token claim, not exercised).
 *
 * Pins the plan's review focus:
 *   1. a full-partner admin with a child org selected in the switcher
 *      (`?orgId=<child>` on every request) uploads to the partner-owned
 *      session and the partner-keyed object, and blank args on the built-in
 *      SentinelOne package store its SITE_TOKEN template;
 *   2. a partner user with orgAccess 'selected' cannot create a session;
 *   3. a child-org token that knows a partner session id gets 404 on every
 *      session route (RLS hides the row) and the session survives.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const { uploadBinaryMock } = vi.hoisted(() => ({
  uploadBinaryMock: vi.fn(async () => undefined),
}));
vi.mock('../../services/s3Storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/s3Storage')>()),
  isS3Configured: () => true,
  uploadBinary: uploadBinaryMock,
  deleteBinary: vi.fn(async () => undefined),
}));
vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeRouteAudit: vi.fn(),
}));

import { getTestDb } from './setup';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createRole,
  createUser,
  grantRolePermissions,
  setupTestEnvironment,
} from './db-utils';
import { softwareCatalog, softwareUploadSessions, softwareVersions } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP);
const S1_TEMPLATE = 'SITE_TOKEN={s1_site_token} /q /NORESTART';
const FILE = Buffer.from('synthetic-msi-bytes');

async function mintToken(p: {
  userId: string; email: string; roleId: string; scope: 'partner' | 'organization';
  partnerId: string; orgId: string | null;
}) {
  return createAccessToken({
    sub: p.userId,
    email: p.email,
    roleId: p.roleId,
    orgId: p.orgId,
    partnerId: p.partnerId,
    scope: p.scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

async function seed() {
  uploadBinaryMock.mockClear();
  const env = await setupTestEnvironment({ scope: 'partner' }); // orgAccess 'all'
  const partnerId = env.partner.id;
  const childOrgId = env.organization.id;
  const database = getTestDb();
  const [catalog] = await database.insert(softwareCatalog).values({
    partnerId,
    integrationProvider: 'sentinelone',
    name: 'SentinelOne Agent',
    vendor: 'SentinelOne',
    category: 'security',
  }).returning();
  if (!catalog) throw new Error('failed to seed the partner-wide S1 catalog row');

  const adminToken = await mintToken({
    userId: env.user.id, email: env.user.email, roleId: env.role.id,
    scope: 'partner', partnerId, orgId: null,
  });

  // Same partner, orgAccess 'selected': RLS admits it (breeze_has_partner_access),
  // so only the partner-wide write gate keeps it out.
  const selectedUser = await createUser({ partnerId, orgId: null });
  const selectedRole = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(selectedRole.id, [{ resource: '*', action: '*' }]);
  await assignUserToPartner(selectedUser.id, partnerId, selectedRole.id, 'selected');
  const selectedToken = await mintToken({
    userId: selectedUser.id, email: selectedUser.email, roleId: selectedRole.id,
    scope: 'partner', partnerId, orgId: null,
  });

  // A customer user of the child org.
  const childUser = await createUser({ partnerId, orgId: childOrgId });
  const childRole = await createRole({ scope: 'organization', orgId: childOrgId });
  await grantRolePermissions(childRole.id, [{ resource: '*', action: '*' }]);
  await assignUserToOrganization(childUser.id, childOrgId, childRole.id);
  const childToken = await mintToken({
    userId: childUser.id, email: childUser.email, roleId: childRole.id,
    scope: 'organization', partnerId, orgId: childOrgId,
  });

  const app = new Hono();
  const { softwareRoutes } = await import('../../routes/software');
  app.route('/software', softwareRoutes);

  const base = `/software/catalog/${catalog.id}/versions/uploads`;
  const call = (token: string, path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  const create = (token: string, query = '', extra: Record<string, unknown> = {}) =>
    call(token, `${base}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: 'SentinelInstaller.msi',
        fileSize: FILE.length,
        chunkSize: 256 * 1024,
        version: '24.1.2',
        supportedOs: ['windows'],
        ...extra,
      }),
    });

  return { database, partnerId, childOrgId, catalog, adminToken, selectedToken, childToken, base, call, create };
}

describe('partner-wide package upload through the real router (breeze_app)', () => {
  runDb('a full-partner admin with a child org selected uploads to the partner-owned session and object', async () => {
    const { database, partnerId, childOrgId, catalog, adminToken, base, call, create } = await seed();
    const q = `?orgId=${childOrgId}`;

    const created = await create(adminToken, q);
    expect(created.status, await created.clone().text()).toBe(201);
    const { uploadId } = (await created.json()).data as { uploadId: string };

    const [session] = await database.select({ orgId: softwareUploadSessions.orgId, partnerId: softwareUploadSessions.partnerId })
      .from(softwareUploadSessions).where(eq(softwareUploadSessions.id, uploadId));
    expect(session).toEqual({ orgId: null, partnerId });

    const chunk = await call(adminToken, `${base}/${uploadId}/chunks?offset=0&orgId=${childOrgId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: FILE,
    });
    expect(chunk.status, await chunk.clone().text()).toBe(200);
    expect((await chunk.json()).data).toEqual({ bytesReceived: FILE.length });

    const completed = await call(adminToken, `${base}/${uploadId}/complete${q}`, { method: 'POST' });
    expect(completed.status, await completed.clone().text()).toBe(201);
    const version = (await completed.json()).data as { id: string };

    const [row] = await database.select({
      s3Key: softwareVersions.s3Key,
      silentInstallArgs: softwareVersions.silentInstallArgs,
      fileType: softwareVersions.fileType,
      isLatest: softwareVersions.isLatest,
    }).from(softwareVersions).where(eq(softwareVersions.id, version.id));
    expect(row?.s3Key).toBe(`software/partner/${partnerId}/${catalog.id}/${version.id}/SentinelInstaller.msi`);
    expect(row?.silentInstallArgs).toBe(S1_TEMPLATE);
    expect(row?.fileType).toBe('msi');
    expect(row?.isLatest).toBe(true);
    expect(uploadBinaryMock).toHaveBeenCalledWith(expect.any(String), row?.s3Key, expect.any(String));

    expect(await database.select({ id: softwareUploadSessions.id })
      .from(softwareUploadSessions).where(eq(softwareUploadSessions.id, uploadId))).toHaveLength(0);
  });

  runDb('a child-org token gets 404 on every route of a partner session, which survives', async () => {
    const { database, adminToken, childToken, base, call, create } = await seed();
    const created = await create(adminToken);
    expect(created.status, await created.clone().text()).toBe(201);
    const { uploadId } = (await created.json()).data as { uploadId: string };

    const status = await call(childToken, `${base}/${uploadId}`);
    expect(status.status).toBe(404);
    const chunk = await call(childToken, `${base}/${uploadId}/chunks?offset=0`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: FILE,
    });
    expect(chunk.status).toBe(404);
    const complete = await call(childToken, `${base}/${uploadId}/complete`, { method: 'POST' });
    expect(complete.status).toBe(404);
    const aborted = await call(childToken, `${base}/${uploadId}`, { method: 'DELETE' });
    expect(aborted.status).toBe(404);

    const [survivor] = await database.select({ bytesReceived: softwareUploadSessions.bytesReceived })
      .from(softwareUploadSessions).where(eq(softwareUploadSessions.id, uploadId));
    expect(survivor).toEqual({ bytesReceived: 0 });
    expect(uploadBinaryMock).not.toHaveBeenCalled();
  });

  runDb('a child-org token cannot create a session on the partner-wide package', async () => {
    const { database, catalog, childOrgId, childToken, create } = await seed();
    const res = await create(childToken, `?orgId=${childOrgId}`);
    expect(res.status).toBe(404);
    expect(await database.select({ id: softwareUploadSessions.id })
      .from(softwareUploadSessions).where(eq(softwareUploadSessions.catalogId, catalog.id))).toHaveLength(0);
  });

  runDb('a partner user with orgAccess "selected" gets 403 at create and no session row is written', async () => {
    const { database, catalog, selectedToken, create } = await seed();
    const res = await create(selectedToken);
    expect(res.status, await res.clone().text()).toBe(403);
    expect((await res.json()).error).toBe(
      'Modifying a partner-wide package requires full partner org access (orgAccess must be "all")',
    );
    const [count] = await database.select({ n: sql<number>`count(*)::int` })
      .from(softwareUploadSessions).where(eq(softwareUploadSessions.catalogId, catalog.id));
    expect(count?.n).toBe(0);
  });

  runDb('a partner user with orgAccess "selected" cannot drive a full admin\'s partner session', async () => {
    const { database, adminToken, selectedToken, base, call, create } = await seed();
    const created = await create(adminToken);
    expect(created.status, await created.clone().text()).toBe(201);
    const { uploadId } = (await created.json()).data as { uploadId: string };

    const chunk = await call(selectedToken, `${base}/${uploadId}/chunks?offset=0`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: FILE,
    });
    expect(chunk.status).toBe(403);
    const aborted = await call(selectedToken, `${base}/${uploadId}`, { method: 'DELETE' });
    expect(aborted.status).toBe(403);
    expect(await database.select({ id: softwareUploadSessions.id })
      .from(softwareUploadSessions).where(eq(softwareUploadSessions.id, uploadId))).toHaveLength(1);
  });

  runDb('S1 MSI args without {s1_site_token} are refused at create (400), before any session exists', async () => {
    const { database, catalog, adminToken, create } = await seed();
    const res = await create(adminToken, '', { silentInstallArgs: 'msiexec /i "{file}" /qn /norestart' });
    expect(res.status).toBe(400);
    expect((await res.json()).issues).toEqual(['install_args_missing_placeholders']);
    expect(await database.select({ id: softwareUploadSessions.id })
      .from(softwareUploadSessions).where(eq(softwareUploadSessions.catalogId, catalog.id))).toHaveLength(0);
  });
});
