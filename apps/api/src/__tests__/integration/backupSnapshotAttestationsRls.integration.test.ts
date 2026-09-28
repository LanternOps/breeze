/**
 * Real-Postgres contract for backup_snapshot_attestations: RLS isolation,
 * the parent-org guard, the immutability/status trigger and the table's CHECK
 * constraints. A mocked suite cannot prove any of these — they live in the
 * database (migrations/2026-11-08-110000-backup-snapshot-attestations.sql).
 */
import './setup';

import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotAttestations,
  backupSnapshots,
  devices,
  sites,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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

type Tenant = { orgId: string; siteId: string; deviceId: string; configId: string; jobId: string; snapshotDbId: string; snapshotId: string };

async function seedTenant(org: { id: string }, unique: string, tag: string): Promise<Tenant> {
  const [site] = await db.insert(sites).values({ orgId: org.id, name: `ATS ${tag} ${unique}` }).returning({ id: sites.id });
  const [device] = await db.insert(devices).values({
    orgId: org.id, siteId: site!.id, agentId: `at-${tag}-${unique}`, hostname: `at-${tag}-${unique}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id });
  const [config] = await db.insert(backupConfigs).values({
    orgId: org.id, name: `ATC ${tag} ${unique}`, type: 'file', provider: 's3',
    providerConfig: { bucket: `bucket-${unique}`, region: 'us-east-1' },
  }).returning({ id: backupConfigs.id });
  const [job] = await db.insert(backupJobs).values({
    orgId: org.id, configId: config!.id, deviceId: device!.id, status: 'completed',
  }).returning({ id: backupJobs.id });
  const snapshotId = `snap-${tag}-${unique}`;
  const [snap] = await db.insert(backupSnapshots).values({
    orgId: org.id, jobId: job!.id, deviceId: device!.id, configId: config!.id, snapshotId,
    storageIdentity: `s3::::bucket-${unique}`,
  }).returning({ id: backupSnapshots.id });
  return { orgId: org.id, siteId: site!.id, deviceId: device!.id, configId: config!.id, jobId: job!.id, snapshotDbId: snap!.id, snapshotId };
}

function attestationValues(t: Tenant, overrides: Partial<typeof backupSnapshotAttestations.$inferInsert> = {}) {
  const statement = `{"v":1,"snapshotId":"${t.snapshotId}"}`;
  return {
    orgId: t.orgId,
    snapshotDbId: t.snapshotDbId,
    jobId: t.jobId,
    deviceId: t.deviceId,
    providerSnapshotId: t.snapshotId,
    storageIdentity: 's3::::bucket',
    keyLayout: 'legacy_flat',
    dispatchedBaseProviderSnapshotId: null,
    parentProviderSnapshotId: null,
    verificationMode: 'server_fetched',
    acceptedVia: 'agent_result',
    resultReceivedAt: new Date(),
    formatVersion: 1,
    statement,
    statementSha256: sha(statement),
    manifestKey: `snapshots/${t.snapshotId}/manifest.json`,
    manifestSha256: sha('manifest'),
    manifestSize: 8,
    status: 'pending',
    ...overrides,
  };
}

async function seedTwoTenants() {
  const unique = uid();
  // Organizations first, each committed on its own: createOrganization writes
  // through a separate connection, which would wait on locks an open
  // transaction below already holds.
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  // One transaction per tenant: partner-export org locks must be taken in
  // ascending id order within a transaction.
  const a = await withSystemDbAccessContext(() => seedTenant(orgA, unique, 'a'));
  const b = await withSystemDbAccessContext(() => seedTenant(orgB, unique, 'b'));
  return { a, b, unique };
}

describe('backup_snapshot_attestations tenancy and integrity contract', () => {
  runDb('refuses a cross-tenant insert under an org-scoped context (42501)', async () => {
    const { a, b } = await seedTwoTenants();
    const err = await pgError(
      withDbAccessContext(orgContext(b.orgId), () => db.insert(backupSnapshotAttestations).values(attestationValues(a))),
    );
    expect(err.code).toBe('42501');
  });

  runDb('a row is visible to its own org and invisible to another org', async () => {
    const { a, b } = await seedTwoTenants();
    await withDbAccessContext(orgContext(a.orgId), () => db.insert(backupSnapshotAttestations).values(attestationValues(a)));
    const underB = await withDbAccessContext(orgContext(b.orgId), () =>
      db.select().from(backupSnapshotAttestations).where(eq(backupSnapshotAttestations.snapshotDbId, a.snapshotDbId)),
    );
    expect(underB).toHaveLength(0);
    const underA = await withDbAccessContext(orgContext(a.orgId), () =>
      db.select().from(backupSnapshotAttestations).where(eq(backupSnapshotAttestations.snapshotDbId, a.snapshotDbId)),
    );
    expect(underA).toHaveLength(1);
    expect(underA[0]!.orgId).toBe(a.orgId);
  });

  runDb('an org-scoped context cannot re-point its own row to another org (RLS WITH CHECK)', async () => {
    const { a, b } = await seedTwoTenants();
    await withDbAccessContext(orgContext(a.orgId), () => db.insert(backupSnapshotAttestations).values(attestationValues(a)));
    const err = await pgError(withDbAccessContext(orgContext(a.orgId), () =>
      db.update(backupSnapshotAttestations).set({ orgId: b.orgId }).where(eq(backupSnapshotAttestations.snapshotDbId, a.snapshotDbId)),
    ));
    expect(err.code).toBe('42501');
    expect(err.message).toContain('row-level security');
  });

  runDb('refuses a row whose snapshot, job or device belongs to another org, even under system scope', async () => {
    const { a, b } = await seedTwoTenants();
    // org A's row pointing at org B's snapshot/job/device.
    const mixed = attestationValues(a, { snapshotDbId: b.snapshotDbId, jobId: b.jobId, deviceId: b.deviceId, providerSnapshotId: b.snapshotId });
    const underSystem = await pgError(withSystemDbAccessContext(() => db.insert(backupSnapshotAttestations).values(mixed)));
    expect(underSystem.code).toBe('42501');
    // Only the job foreign: still refused.
    const jobOnly = attestationValues(a, { jobId: b.jobId });
    expect((await pgError(withSystemDbAccessContext(() => db.insert(backupSnapshotAttestations).values(jobOnly)))).code).toBe('42501');
    // Under org A's own context org B's parents are invisible: also refused.
    const underOrg = await pgError(withDbAccessContext(orgContext(a.orgId), () => db.insert(backupSnapshotAttestations).values(mixed)));
    expect(underOrg.code).toBe('42501');
  });

  runDb('refuses a row whose device or snapshot id does not match its snapshot row (23514)', async () => {
    const { a } = await seedTwoTenants();
    const wrongId = attestationValues(a, { providerSnapshotId: `${a.snapshotId}-other` });
    expect((await pgError(withSystemDbAccessContext(() => db.insert(backupSnapshotAttestations).values(wrongId)))).code).toBe('23514');
  });

  runDb('hash and binding columns are immutable; status moves pending -> verified | mismatch once', async () => {
    const { a } = await seedTwoTenants();
    const [row] = await withSystemDbAccessContext(() =>
      db.insert(backupSnapshotAttestations).values(attestationValues(a)).returning({ id: backupSnapshotAttestations.id }),
    );
    const id = row!.id;
    const immut = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshotAttestations).set({ manifestSha256: sha('other') }).where(eq(backupSnapshotAttestations.id, id)),
    ));
    expect(immut.message).toContain('immutable');
    const stmt = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshotAttestations).set({ statement: '{}' }).where(eq(backupSnapshotAttestations.id, id)),
    ));
    expect(stmt.message).toContain('immutable');

    await withSystemDbAccessContext(() =>
      db.update(backupSnapshotAttestations).set({ status: 'verified', verifiedAt: new Date() }).where(eq(backupSnapshotAttestations.id, id)),
    );
    const back = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshotAttestations).set({ status: 'pending' }).where(eq(backupSnapshotAttestations.id, id)),
    ));
    expect(back.message).toContain('not allowed');
    const flip = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshotAttestations).set({ status: 'mismatch' }).where(eq(backupSnapshotAttestations.id, id)),
    ));
    expect(flip.message).toContain('not allowed');
    const note = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshotAttestations).set({ verifyError: 'later' }).where(eq(backupSnapshotAttestations.id, id)),
    ));
    expect(note.message).toContain('immutable');
    const retry = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshotAttestations).set({ attemptCount: 3, nextAttemptAt: new Date() }).where(eq(backupSnapshotAttestations.id, id)),
    ));
    expect(retry.message).toContain('immutable');
  });

  runDb('producer_only rows are terminal and cannot be pending', async () => {
    const { a, b } = await seedTwoTenants();
    const bad = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupSnapshotAttestations).values(attestationValues(a, { verificationMode: 'producer_only', status: 'pending' })),
    ));
    expect(bad.code).toBe('23514');
    const [row] = await withSystemDbAccessContext(() =>
      db.insert(backupSnapshotAttestations)
        .values(attestationValues(b, { verificationMode: 'producer_only', status: 'producer_only' }))
        .returning({ id: backupSnapshotAttestations.id }),
    );
    const change = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshotAttestations).set({ status: 'verified' }).where(eq(backupSnapshotAttestations.id, row!.id)),
    ));
    expect(change.message).toContain('not allowed');
  });

  runDb('parent must be null or the dispatched base (23514)', async () => {
    const { a } = await seedTwoTenants();
    const bad = await pgError(withSystemDbAccessContext(() =>
      db.insert(backupSnapshotAttestations).values(attestationValues(a, {
        dispatchedBaseProviderSnapshotId: 'base-1', parentProviderSnapshotId: 'base-2',
      })),
    ));
    expect(bad.code).toBe('23514');
  });

  runDb('one attestation per snapshot (23505)', async () => {
    const { a } = await seedTwoTenants();
    await withSystemDbAccessContext(() => db.insert(backupSnapshotAttestations).values(attestationValues(a)));
    const dup = await pgError(withSystemDbAccessContext(() => db.insert(backupSnapshotAttestations).values(attestationValues(a))));
    expect(dup.code).toBe('23505');
  });

  runDb('org_id follows a device move; deleting the snapshot removes the attestation', async () => {
    const { a, b } = await seedTwoTenants();
    await withSystemDbAccessContext(() => db.insert(backupSnapshotAttestations).values(attestationValues(a)));
    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE devices SET org_id = ${b.orgId}::uuid, site_id = ${b.siteId}::uuid WHERE id = ${a.deviceId}::uuid`),
    );
    const [moved] = await withSystemDbAccessContext(() =>
      db.select().from(backupSnapshotAttestations).where(eq(backupSnapshotAttestations.snapshotDbId, a.snapshotDbId)),
    );
    expect(moved!.orgId).toBe(b.orgId);

    await withSystemDbAccessContext(() => db.delete(backupSnapshots).where(eq(backupSnapshots.id, a.snapshotDbId)));
    const gone = await withSystemDbAccessContext(() =>
      db.select().from(backupSnapshotAttestations).where(eq(backupSnapshotAttestations.snapshotDbId, a.snapshotDbId)),
    );
    expect(gone).toHaveLength(0);
  });

  runDb('backup_snapshots projection columns default and are constrained', async () => {
    const { a } = await seedTwoTenants();
    const [snap] = await withSystemDbAccessContext(() =>
      db.select({ integrityStatus: backupSnapshots.integrityStatus, resultProvenance: backupSnapshots.resultProvenance })
        .from(backupSnapshots).where(eq(backupSnapshots.id, a.snapshotDbId)),
    );
    expect(snap).toEqual({ integrityStatus: 'unattested_legacy', resultProvenance: null });
    const bad = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshots).set({ integrityStatus: 'trusted' }).where(eq(backupSnapshots.id, a.snapshotDbId)),
    ));
    expect(bad.code).toBe('23514');
    const badProv = await pgError(withSystemDbAccessContext(() =>
      db.update(backupSnapshots).set({ resultProvenance: 'operator' }).where(eq(backupSnapshots.id, a.snapshotDbId)),
    ));
    expect(badProv.code).toBe('23514');
  });
});
