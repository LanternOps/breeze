/**
 * Real-Postgres contract for backup_restore_authorizations: RLS isolation,
 * the parent-org guard, immutability, the binding CHECK, the atomic
 * authorization + audit write, and the lookups command delivery and recovery
 * authentication use. A mocked suite cannot prove any of these — they live in
 * the database (migrations/2026-12-17-170000-backup-restore-authorizations.sql).
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  auditLogs,
  backupConfigs,
  backupJobs,
  backupRestoreAuthorizations,
  backupSnapshots,
  bareMetalRecoveries,
  devices,
  recoveryTokens,
  sites,
} from '../../db/schema';
import {
  UNATTESTED_RESTORE_AUDIT_ACTION,
  findCommandRestoreAuthorization,
  findRecoveryRestoreAuthorizations,
  recordRestoreAuthorization,
  unattestedRestoreResourceDigest,
  type RestoreAuthorizationWriter,
} from '../../services/backupRestoreAuthorization';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Postgres error code from a Drizzle rejection (wrapped under `.cause`) or a raw one. */
async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    return { code: e.cause?.code ?? e.code, message: `${e.message ?? ''} ${e.cause?.message ?? ''}` };
  }
  throw new Error('expected the statement to fail');
}

type Tenant = { orgId: string; deviceId: string; snapshotDbId: string; userId: string; tokenId: string; recoveryId: string };

async function seedTenant(org: { id: string }, partnerId: string, unique: string, tag: string): Promise<Tenant> {
  const [site] = await db.insert(sites).values({ orgId: org.id, name: `RA ${tag} ${unique}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org.id, siteId: site!.id, agentId: `ra-${tag}-${unique}`, hostname: `ra-${tag}-${unique}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org.id, name: `RAC ${tag} ${unique}`, type: 'file', provider: 's3',
    providerConfig: { bucket: `bucket-${unique}`, region: 'us-east-1' },
  }).returning({ id: backupConfigs.id });
  const [job] = await db.insert(backupJobs).values({
    orgId: org.id, configId: config!.id, deviceId: device!.id, status: 'completed',
  }).returning({ id: backupJobs.id });
  const [snap] = await db.insert(backupSnapshots).values({
    orgId: org.id, jobId: job!.id, deviceId: device!.id, configId: config!.id, snapshotId: `snap-${tag}-${unique}`,
    storageIdentity: `s3::::bucket-${unique}`,
  }).returning({ id: backupSnapshots.id });
  const user = await createUser({ partnerId, orgId: org.id, email: `ra-${tag}-${unique}@example.com` });
  const [token] = await db.insert(recoveryTokens).values({
    orgId: org.id, deviceId: device!.id, snapshotId: snap!.id, tokenHash: `${tag}${unique}`.padEnd(64, '0').slice(0, 64),
    restoreType: 'bare_metal', status: 'active', expiresAt: new Date(Date.now() + 3_600_000),
  }).returning({ id: recoveryTokens.id });
  const [recovery] = await db.insert(bareMetalRecoveries).values({
    orgId: org.id, deviceId: device!.id, snapshotId: snap!.id, identity: 'original',
    codeHash: `c${tag}${unique}`.padEnd(64, '0').slice(0, 64), codeExpiresAt: new Date(Date.now() + 3_600_000),
    nonceHash: `n${tag}${unique}`.padEnd(64, '0').slice(0, 64), status: 'created',
  }).returning({ id: bareMetalRecoveries.id });
  return { orgId: org.id, deviceId: device!.id, snapshotDbId: snap!.id, userId: user.id, tokenId: token!.id, recoveryId: recovery!.id };
}

async function seedTwoTenants() {
  const unique = uid();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const a = await withSystemDbAccessContext(() => seedTenant(orgA, partner.id, unique, 'a'));
  const b = await withSystemDbAccessContext(() => seedTenant(orgB, partner.id, unique, 'b'));
  return { a, b };
}

function row(t: Tenant, overrides: Partial<typeof backupRestoreAuthorizations.$inferInsert> = {}) {
  return {
    orgId: t.orgId,
    snapshotDbId: t.snapshotDbId,
    deviceId: t.deviceId,
    commandType: 'backup_restore',
    reason: 'unattested_legacy',
    authorizedByUserId: t.userId,
    resourceDigest: unattestedRestoreResourceDigest({ snapshotDbId: t.snapshotDbId, targetDeviceId: t.deviceId, commandType: 'backup_restore' }),
    commandId: randomUUID(),
    auditWrittenAt: new Date(),
    ...overrides,
  };
}

describe('backup_restore_authorizations tenancy and integrity contract', () => {
  runDb('refuses a cross-tenant insert under an org-scoped context (42501)', async () => {
    const { a, b } = await seedTwoTenants();
    const err = await pgError(withDbAccessContext(orgContext(b.orgId), () => db.insert(backupRestoreAuthorizations).values(row(a))));
    expect(err.code).toBe('42501');
  });

  runDb('a row is visible to its own org only, and cannot be re-pointed to another org', async () => {
    const { a, b } = await seedTwoTenants();
    const values = row(a);
    await withDbAccessContext(orgContext(a.orgId), () => db.insert(backupRestoreAuthorizations).values(values));
    const underB = await withDbAccessContext(orgContext(b.orgId), () => findCommandRestoreAuthorization(values.commandId!));
    expect(underB).toBeNull();
    const underA = await withDbAccessContext(orgContext(a.orgId), () => findCommandRestoreAuthorization(values.commandId!));
    expect(underA).toMatchObject({ orgId: a.orgId, snapshotDbId: a.snapshotDbId, deviceId: a.deviceId, commandType: 'backup_restore' });

    const repoint = await pgError(withDbAccessContext(orgContext(a.orgId), () =>
      db.update(backupRestoreAuthorizations).set({ orgId: b.orgId }).where(eq(backupRestoreAuthorizations.commandId, values.commandId!)),
    ));
    expect(repoint.code).toBe('42501');
  });

  runDb('refuses a row whose snapshot or target device belongs to another org, even under system scope', async () => {
    const { a, b } = await seedTwoTenants();
    const foreignSnapshot = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupRestoreAuthorizations).values(row(a, { snapshotDbId: b.snapshotDbId }))));
    expect(foreignSnapshot.code).toBe('42501');
    const foreignDevice = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupRestoreAuthorizations).values(row(a, { deviceId: b.deviceId }))));
    expect(foreignDevice.code).toBe('42501');
    const foreignToken = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupRestoreAuthorizations).values(row(a, { commandId: null, recoveryTokenId: b.tokenId }))));
    expect(foreignToken.code).toBe('42501');
  });

  runDb('refuses a recovery binding that names another snapshot or device (23514)', async () => {
    const { a } = await seedTwoTenants();
    const unique = uid();
    const otherSnapshot = await withSystemDbAccessContext(async () => {
      const [job] = await db.select({ jobId: backupSnapshots.jobId, configId: backupSnapshots.configId })
        .from(backupSnapshots).where(eq(backupSnapshots.id, a.snapshotDbId));
      const [snap] = await db.insert(backupSnapshots).values({
        orgId: a.orgId, jobId: job!.jobId, deviceId: a.deviceId, configId: job!.configId, snapshotId: `snap-other-${unique}`,
      }).returning({ id: backupSnapshots.id });
      return snap!.id;
    });
    const err = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupRestoreAuthorizations).values(row(a, { snapshotDbId: otherSnapshot, commandId: null, recoveryId: a.recoveryId }))));
    expect(err.code).toBe('23514');
  });

  runDb('binds exactly one restore: none or two bindings are refused (23514)', async () => {
    const { a } = await seedTwoTenants();
    const none = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupRestoreAuthorizations).values(row(a, { commandId: null }))));
    expect(none.code).toBe('23514');
    const two = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupRestoreAuthorizations).values(row(a, { recoveryTokenId: a.tokenId }))));
    expect(two.code).toBe('23514');
  });

  runDb('rows are immutable except their org', async () => {
    const { a } = await seedTwoTenants();
    const values = row(a);
    await withSystemDbAccessContext(() => db.insert(backupRestoreAuthorizations).values(values));
    for (const change of [
      { commandType: 'mssql_restore' },
      { snapshotDbId: a.snapshotDbId, deviceId: a.deviceId, commandId: randomUUID() },
      { reason: 'unattested' },
    ]) {
      const err = await pgError(withSystemDbAccessContext(() =>
        db.update(backupRestoreAuthorizations).set(change).where(eq(backupRestoreAuthorizations.commandId, values.commandId!))));
      expect(err.message).toContain('immutable');
    }
  });

  runDb('only a privileged restore command type and a known reason are accepted', async () => {
    const { a } = await seedTwoTenants();
    const verify = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupRestoreAuthorizations).values(row(a, { commandType: 'backup_verify' }))));
    expect(verify.code).toBe('23514');
    const failed = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupRestoreAuthorizations).values(row(a, { reason: 'attestation_failed' }))));
    expect(failed.code).toBe('23514');
  });
});

describe('recordRestoreAuthorization (real database)', () => {
  runDb('writes the authorization and its audit event in the org\'s own context', async () => {
    const { a } = await seedTwoTenants();
    const commandId = randomUUID();
    const id = await withDbAccessContext(orgContext(a.orgId), () => recordRestoreAuthorization({
      orgId: a.orgId,
      snapshotDbId: a.snapshotDbId,
      targetDeviceId: a.deviceId,
      commandType: 'backup_restore',
      reason: 'unattested_legacy',
      userId: a.userId,
      binding: { commandId },
    }));
    const found = await withDbAccessContext(orgContext(a.orgId), () => findCommandRestoreAuthorization(commandId));
    expect(found?.id).toBe(id);
    const audits = await withSystemDbAccessContext(() => db.select().from(auditLogs).where(and(
      eq(auditLogs.orgId, a.orgId),
      eq(auditLogs.action, UNATTESTED_RESTORE_AUDIT_ACTION),
    )));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ authorizationId: id, commandId, snapshotDbId: a.snapshotDbId, targetDeviceId: a.deviceId });
  });

  runDb('a failed audit write leaves no authorization behind', async () => {
    const { a } = await seedTwoTenants();
    const commandId = randomUUID();
    const failingAudit: RestoreAuthorizationWriter = {
      insertAuthorization: async (r) => { await db.insert(backupRestoreAuthorizations).values(r); },
      insertAudit: async () => { throw new Error('audit write failed'); },
      atomically: (fn) => db.transaction(() => fn()),
    };
    await expect(withDbAccessContext(orgContext(a.orgId), () => recordRestoreAuthorization({
      orgId: a.orgId,
      snapshotDbId: a.snapshotDbId,
      targetDeviceId: a.deviceId,
      commandType: 'backup_restore',
      reason: 'unattested_legacy',
      userId: a.userId,
      binding: { commandId },
    }, failingAudit))).rejects.toThrow('audit write failed');
    const found = await withSystemDbAccessContext(() => findCommandRestoreAuthorization(commandId));
    expect(found).toBeNull();
  });

  runDb('finds the authorization bound to a recovery token or to its recovery', async () => {
    const { a } = await seedTwoTenants();
    await withDbAccessContext(orgContext(a.orgId), async () => {
      await recordRestoreAuthorization({
        orgId: a.orgId, snapshotDbId: a.snapshotDbId, targetDeviceId: a.deviceId, commandType: 'bmr_recover',
        reason: 'unattested', userId: a.userId, binding: { recoveryTokenId: a.tokenId },
      });
      await recordRestoreAuthorization({
        orgId: a.orgId, snapshotDbId: a.snapshotDbId, targetDeviceId: a.deviceId, commandType: 'bmr_recover',
        reason: 'unattested', userId: a.userId, binding: { recoveryId: a.recoveryId },
      });
    });
    const byToken = await withDbAccessContext(orgContext(a.orgId), () => findRecoveryRestoreAuthorizations({ recoveryTokenId: a.tokenId }));
    expect(byToken).toHaveLength(1);
    const both = await withDbAccessContext(orgContext(a.orgId), () =>
      findRecoveryRestoreAuthorizations({ recoveryTokenId: a.tokenId, recoveryId: a.recoveryId }));
    expect(both).toHaveLength(2);
  });

  runDb('deleting the bound recovery token deletes its authorization', async () => {
    const { a } = await seedTwoTenants();
    await withDbAccessContext(orgContext(a.orgId), () => recordRestoreAuthorization({
      orgId: a.orgId, snapshotDbId: a.snapshotDbId, targetDeviceId: a.deviceId, commandType: 'bmr_recover',
      reason: 'unattested', userId: a.userId, binding: { recoveryTokenId: a.tokenId },
    }));
    await withSystemDbAccessContext(async () => {
      await db.update(bareMetalRecoveries).set({ recoveryTokenId: null }).where(eq(bareMetalRecoveries.recoveryTokenId, a.tokenId));
      await db.delete(recoveryTokens).where(eq(recoveryTokens.id, a.tokenId));
    });
    const left = await withSystemDbAccessContext(() => findRecoveryRestoreAuthorizations({ recoveryTokenId: a.tokenId }));
    expect(left).toHaveLength(0);
  });
});
