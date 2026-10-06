/**
 * Real-Postgres proof of the snapshot attestation lifecycle: recording from
 * an authenticated agent result (compare-and-set, projection, provenance),
 * the storage-reconciliation exclusion and the late-result exception,
 * server-side verification (including across a device org move), and the
 * durable-provenance closure queries.
 *
 * WHY A REAL DATABASE: the insert guard, the status trigger, the unique index
 * behind the compare-and-set and RLS all live in Postgres; a mocked suite
 * would pass with any of them missing.
 */
import './setup';

import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueVerificationMock = vi.hoisted(() => vi.fn(async () => 'job'));
vi.mock('../../jobs/backupSnapshotAttestationWorker', () => ({
  enqueueSnapshotAttestationVerification: enqueueVerificationMock,
}));

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotAttestations,
  backupSnapshots,
  backupVerifications,
  deviceCommands,
  devices,
  sites,
} from '../../db/schema';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { recordSnapshotAttestation, type RecordSnapshotAttestationInput } from '../../services/backupAttestation';
import { defaultVerifyDeps, verifySnapshotAttestation } from '../../services/backupAttestationVerify';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
import { setBackupMetricsRecorder } from '../../services/backupMetrics';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

type Fixture = {
  partnerId: string; orgId: string; siteId: string; deviceId: string; agentId: string; configId: string;
  storageIdentity: string; jobId: string; snapshotId: string;
};

async function seed(opts: { provider?: 's3' | 'local'; integrity?: number | null } = {}): Promise<Fixture> {
  const unique = uid();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const provider = opts.provider ?? 's3';
  const providerConfig = provider === 's3'
    ? { bucket: `att-${unique}`, region: 'us-east-1', endpoint: 'https://s3.example.test' }
    : { path: `/tmp/att-${unique}` };
  return withSystemDbAccessContext(async () => {
    const [site] = await db.insert(sites).values({ orgId: org.id, name: `ATT ${unique}` }).returning({ id: sites.id });
    const agentId = `att-agent-${unique}`;
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site!.id, agentId, hostname: `att-${unique}`, osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
      backupIntegrityProtocolVersion: opts.integrity === undefined ? 1 : opts.integrity,
    }).returning({ id: devices.id });
    const [config] = await db.insert(backupConfigs).values({
      orgId: org.id, name: `ATT ${unique}`, type: 'file', provider, providerConfig,
    }).returning({ id: backupConfigs.id });
    const storageIdentity = normalizeStorageIdentity(provider, providerConfig);
    const [job] = await db.insert(backupJobs).values({
      orgId: org.id, configId: config!.id, deviceId: device!.id, status: 'running', storageIdentity,
      startedAt: new Date(),
    }).returning({ id: backupJobs.id });
    return {
      partnerId: partner.id, orgId: org.id, siteId: site!.id, deviceId: device!.id, agentId, configId: config!.id,
      storageIdentity, jobId: job!.id, snapshotId: `snapshot-${unique}`,
    };
  });
}

function manifestBytes(snapshotId: string, backupPaths: string[] = [`snapshots/${snapshotId}/files/a.txt`]): Uint8Array {
  return Buffer.from(JSON.stringify({
    id: snapshotId,
    files: backupPaths.map((p, i) => ({ sourcePath: `C:/f${i}`, backupPath: p, size: 1 })),
  }));
}

function statementFor(f: Fixture, manifest: Uint8Array, o: { agentId?: string; dispatched?: string | null; parent?: string | null } = {}): string {
  return JSON.stringify({
    v: 1, snapshotId: f.snapshotId, jobId: f.jobId, agentId: o.agentId ?? f.agentId,
    dispatchedBaseSnapshotId: o.dispatched ?? null, parentSnapshotId: o.parent ?? null, keyLayout: 'legacy_flat',
    objects: [{ role: 'manifest', key: `snapshots/${f.snapshotId}/manifest.json`, sha256: sha(manifest), size: manifest.byteLength }],
  });
}

/** The agent WS inline path: org-scoped context, dispatch expectation consumed. */
function agentResult(f: Fixture, attestation: unknown, overrides: Record<string, unknown> = {}) {
  return withDbAccessContext(orgContext(f.orgId), () =>
    applyBackupCommandResultToJob({
      jobId: f.jobId, orgId: f.orgId, deviceId: f.deviceId, resultStatus: 'completed',
      result: { snapshotId: f.snapshotId, filesBackedUp: 1, bytesBackedUp: 1, attestation, ...overrides } as never,
      dispatchExpectationVerified: true,
    }),
  );
}

async function snapshotRow(f: Fixture) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(backupSnapshots).where(and(eq(backupSnapshots.jobId, f.jobId), eq(backupSnapshots.snapshotId, f.snapshotId))),
  );
  return row;
}

async function attestationRows(snapshotDbId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(backupSnapshotAttestations).where(eq(backupSnapshotAttestations.snapshotDbId, snapshotDbId)),
  );
}

function recordInput(f: Fixture, snapshotDbId: string, statement: string): RecordSnapshotAttestationInput {
  return {
    snapshotDbId, orgId: f.orgId, jobId: f.jobId, deviceId: f.deviceId, providerSnapshotId: f.snapshotId,
    storageIdentity: f.storageIdentity, pinnedBaseProviderSnapshotId: null, reportsLayout: false,
    reportsSystemState: false, referencedFiles: undefined, deviceAgentId: f.agentId,
    deviceIntegrityProtocolVersion: 1, acceptedVia: 'agent_result', dispatchExpectationVerified: true,
    resultReceivedAt: new Date(), attestation: { statement },
  };
}

beforeEach(() => {
  enqueueVerificationMock.mockClear();
});

describe('recording from agent results', () => {
  runDb('records a pending attestation visible only to its org and queues verification after commit', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    const statement = statementFor(f, manifest);
    const applied = await agentResult(f, { statement });
    expect(applied.applied).toBe(true);

    const snap = await snapshotRow(f);
    expect(snap).toMatchObject({ integrityStatus: 'pending', resultProvenance: 'agent_result' });
    const rows = await attestationRows(snap!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending', verificationMode: 'server_fetched', acceptedVia: 'agent_result', orgId: f.orgId,
      statement, statementSha256: sha(statement), manifestSha256: sha(manifest), manifestSize: manifest.byteLength,
    });
    expect(enqueueVerificationMock).toHaveBeenCalledWith(snap!.id);

    const other = await createOrganization({ partnerId: (await createPartner()).id });
    const underOther = await withDbAccessContext(orgContext(other.id), () =>
      db.select().from(backupSnapshotAttestations).where(eq(backupSnapshotAttestations.snapshotDbId, snap!.id)),
    );
    expect(underOther).toHaveLength(0);
  });

  runDb('an identical re-send is a no-op; a different statement never replaces the first', async () => {
    const outcomes: string[] = [];
    setBackupMetricsRecorder({ onAttestation: (outcome) => outcomes.push(outcome) });
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    const statement = statementFor(f, manifest);
    await agentResult(f, { statement });
    const snap = await snapshotRow(f);
    enqueueVerificationMock.mockClear();

    const enqueue = vi.fn(async () => 'x');
    const same = await withSystemDbAccessContext(() => recordSnapshotAttestation(recordInput(f, snap!.id, statement), { enqueueVerification: enqueue }));
    expect(same.outcome).toBe('duplicate_same');

    const other = statementFor(f, manifestBytes(f.snapshotId, [`snapshots/${f.snapshotId}/files/b.txt`]));
    const conflict = await withSystemDbAccessContext(() => recordSnapshotAttestation(recordInput(f, snap!.id, other), { enqueueVerification: enqueue }));
    expect(conflict.outcome).toBe('conflict');
    await new Promise((r) => setImmediate(r));
    expect(enqueue).not.toHaveBeenCalled();

    const rows = await attestationRows(snap!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statement).toBe(statement);
    expect((await snapshotRow(f))!.integrityStatus).toBe('pending');
    expect(outcomes).toEqual(['recorded', 'duplicate_same', 'conflict']);
    setBackupMetricsRecorder(null);
  });

  runDb('a device-local destination is producer_only at once and never queued', async () => {
    const f = await seed({ provider: 'local' });
    await agentResult(f, { statement: statementFor(f, manifestBytes(f.snapshotId)) });
    const snap = await snapshotRow(f);
    expect(snap!.integrityStatus).toBe('producer_only');
    const rows = await attestationRows(snap!.id);
    expect(rows[0]).toMatchObject({ status: 'producer_only', verificationMode: 'producer_only' });
    expect(enqueueVerificationMock).not.toHaveBeenCalled();
  });

  runDb('a capable helper that reports no attestation leaves the snapshot unattested, an older one legacy', async () => {
    const capable = await seed();
    await agentResult(capable, undefined);
    expect((await snapshotRow(capable))!.integrityStatus).toBe('unattested');

    const older = await seed({ integrity: 0 });
    await agentResult(older, undefined);
    expect((await snapshotRow(older))!.integrityStatus).toBe('unattested_legacy');
  });

  runDb('a helper that has not reported its integrity protocol is not filed as an older one', async () => {
    const unreported = await seed({ integrity: null });
    await agentResult(unreported, undefined);
    expect((await snapshotRow(unreported))!.integrityStatus).toBe('unattested');
  });

  runDb('a statement that does not bind fails the snapshot, and a later valid one cannot replace that', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    await agentResult(f, { statement: statementFor(f, manifest, { agentId: 'another-agent' }) });
    const snap = await snapshotRow(f);
    expect(snap!.integrityStatus).toBe('attestation_failed');
    expect(await attestationRows(snap!.id)).toHaveLength(0);

    const later = await withSystemDbAccessContext(() =>
      recordSnapshotAttestation(recordInput(f, snap!.id, statementFor(f, manifest)), { enqueueVerification: vi.fn() }),
    );
    expect(later).toEqual({ outcome: 'conflict', reason: 'previously_failed' });
    expect((await snapshotRow(f))!.integrityStatus).toBe('attestation_failed');
  });

  runDb('a result not bound to a consumed dispatch expectation records nothing', async () => {
    const f = await seed();
    await withDbAccessContext(orgContext(f.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: f.jobId, orgId: f.orgId, deviceId: f.deviceId, resultStatus: 'completed',
        result: { snapshotId: f.snapshotId, attestation: { statement: statementFor(f, manifestBytes(f.snapshotId)) } } as never,
      }),
    );
    const snap = await snapshotRow(f);
    expect(await attestationRows(snap!.id)).toHaveLength(0);
    expect(snap!.integrityStatus).toBe('unattested');
  });
});

describe('storage reconciliation and late results', () => {
  async function reconcile(f: Fixture, attestation?: unknown) {
    return withDbAccessContext(orgContext(f.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: f.jobId, orgId: f.orgId, deviceId: f.deviceId, resultStatus: 'completed', source: 'reconcile',
        result: { snapshotId: f.snapshotId, filesBackedUp: 1, ...(attestation ? { attestation } : {}) } as never,
        dispatchExpectationVerified: true,
      }),
    );
  }

  runDb('reconciliation never creates an attestation, even from a result carrying one', async () => {
    const f = await seed();
    await reconcile(f, { statement: statementFor(f, manifestBytes(f.snapshotId)) });
    const snap = await snapshotRow(f);
    expect(snap).toMatchObject({ resultProvenance: 'reconcile', integrityStatus: 'unattested' });
    expect(await attestationRows(snap!.id)).toHaveLength(0);
    expect(enqueueVerificationMock).not.toHaveBeenCalled();
  });

  runDb('the producing device\u2019s own late result may attest a reconciled row', async () => {
    const f = await seed();
    await reconcile(f);
    const statement = statementFor(f, manifestBytes(f.snapshotId));
    const late = await agentResult(f, { statement });
    const snap = await snapshotRow(f);
    expect(late).toEqual({ applied: false, snapshotDbId: snap!.id, providerSnapshotId: f.snapshotId });
    expect(snap).toMatchObject({ resultProvenance: 'agent_result_after_reconcile', integrityStatus: 'pending' });
    const rows = await attestationRows(snap!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ acceptedVia: 'late_agent_result', statement });
    // The job itself is untouched by the late result.
    const [job] = await withSystemDbAccessContext(() => db.select().from(backupJobs).where(eq(backupJobs.id, f.jobId)));
    expect(job!.status).toBe('completed');
  });

  runDb('a late result without a consumed expectation, for another snapshot id, or from another device attests nothing', async () => {
    const f = await seed();
    await reconcile(f);
    const statement = statementFor(f, manifestBytes(f.snapshotId));
    // Not bound to a dispatch expectation.
    await withDbAccessContext(orgContext(f.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: f.jobId, orgId: f.orgId, deviceId: f.deviceId, resultStatus: 'completed',
        result: { snapshotId: f.snapshotId, attestation: { statement } } as never,
      }),
    );
    // Another snapshot id.
    await agentResult(f, { statement }, { snapshotId: `${f.snapshotId}-other` });
    // Another device in the same org.
    const [sibling] = await withSystemDbAccessContext(() =>
      db.insert(devices).values({
        orgId: f.orgId, siteId: f.siteId, agentId: `sib-${uid()}`, hostname: `sib-${uid()}`, osType: 'windows',
        osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', backupIntegrityProtocolVersion: 1,
      }).returning({ id: devices.id }),
    );
    await withDbAccessContext(orgContext(f.orgId), () =>
      applyBackupCommandResultToJob({
        jobId: f.jobId, orgId: f.orgId, deviceId: sibling!.id, resultStatus: 'completed',
        result: { snapshotId: f.snapshotId, attestation: { statement } } as never,
        dispatchExpectationVerified: true,
      }),
    );
    const snap = await snapshotRow(f);
    expect(snap).toMatchObject({ resultProvenance: 'reconcile', integrityStatus: 'unattested' });
    expect(await attestationRows(snap!.id)).toHaveLength(0);
  });

  runDb('closure queries over durable provenance return no rows after reconcile and late-result traffic', async () => {
    const reconciled = await seed();
    await reconcile(reconciled, { statement: statementFor(reconciled, manifestBytes(reconciled.snapshotId)) });
    const lateAttested = await seed();
    await reconcile(lateAttested);
    await agentResult(lateAttested, { statement: statementFor(lateAttested, manifestBytes(lateAttested.snapshotId)) });
    const direct = await seed();
    await agentResult(direct, { statement: statementFor(direct, manifestBytes(direct.snapshotId)) });
    const orgIds = [reconciled.orgId, lateAttested.orgId, direct.orgId];

    const [a, b] = await withSystemDbAccessContext(async () => {
      const qa = await db.execute(sql`
        SELECT a.id FROM backup_snapshot_attestations a
          JOIN backup_snapshots s ON s.id = a.snapshot_db_id
         WHERE s.org_id IN (${sql.join(orgIds.map((id) => sql`${id}::uuid`), sql`, `)})
           AND ((s.result_provenance = 'reconcile')
             OR (s.result_provenance = 'agent_result_after_reconcile' AND a.accepted_via <> 'late_agent_result')
             OR (s.result_provenance IS NULL))`);
      const qb = await db.execute(sql`
        SELECT a.id FROM backup_snapshot_attestations a
          JOIN backup_snapshots s ON s.id = a.snapshot_db_id
         WHERE s.org_id IN (${sql.join(orgIds.map((id) => sql`${id}::uuid`), sql`, `)})
           AND (s.job_id <> a.job_id OR s.device_id <> a.device_id OR s.snapshot_id <> a.provider_snapshot_id)`);
      return [qa, qb];
    });
    expect(Array.from(a as unknown as unknown[])).toHaveLength(0);
    expect(Array.from(b as unknown as unknown[])).toHaveLength(0);
    // And the scenario did produce attestations to check.
    const count = await withSystemDbAccessContext(() =>
      db.select({ id: backupSnapshotAttestations.id }).from(backupSnapshotAttestations).where(inArray(backupSnapshotAttestations.orgId, orgIds)),
    );
    expect(count).toHaveLength(2);
  });
});

describe('server-side verification', () => {
  function storage(objects: Record<string, Uint8Array>, fail = false) {
    return {
      ...defaultVerifyDeps,
      fetchObject: vi.fn(async ({ key }: { key: string }) => {
        if (fail) throw new Error('connect ETIMEDOUT');
        const bytes = objects[key];
        if (!bytes) throw new Error('NoSuchKey');
        return bytes;
      }),
    };
  }

  runDb('matching bytes verify the attestation and attest the snapshot', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    await agentResult(f, { statement: statementFor(f, manifest) });
    const snap = await snapshotRow(f);
    const result = await verifySnapshotAttestation(snap!.id, storage({ [`snapshots/${f.snapshotId}/manifest.json`]: manifest }));
    expect(result).toEqual({ outcome: 'verified' });
    expect((await attestationRows(snap!.id))[0]).toMatchObject({ status: 'verified', verifyError: null });
    expect((await snapshotRow(f))!.integrityStatus).toBe('attested');
    // Decided once.
    expect(await verifySnapshotAttestation(snap!.id, storage({}))).toEqual({ outcome: 'skipped', reason: 'already_decided' });
  });

  runDb('manifest bytes that differ from the attestation fail it', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    await agentResult(f, { statement: statementFor(f, manifest) });
    const snap = await snapshotRow(f);
    const altered = Buffer.from(manifest);
    altered[altered.length - 2] = altered[altered.length - 2]! ^ 1;
    const result = await verifySnapshotAttestation(snap!.id, storage({ [`snapshots/${f.snapshotId}/manifest.json`]: altered }));
    expect(result).toEqual({ outcome: 'mismatch', reason: 'manifest_digest_mismatch' });
    expect((await snapshotRow(f))!.integrityStatus).toBe('attestation_failed');
  });

  runDb('a mismatch settles the verifications waiting on the snapshot and withdraws their queued commands', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    await agentResult(f, { statement: statementFor(f, manifest) });
    const snap = await snapshotRow(f);
    const { verificationId, commandId, doneId } = await withSystemDbAccessContext(async () => {
      const [command] = await db.insert(deviceCommands).values({
        deviceId: f.deviceId, type: 'backup_verify', payload: { snapshotId: f.snapshotId }, status: 'pending',
      }).returning({ id: deviceCommands.id });
      const [waiting] = await db.insert(backupVerifications).values({
        orgId: f.orgId, deviceId: f.deviceId, backupJobId: f.jobId, snapshotId: snap!.id,
        verificationType: 'integrity', status: 'pending', startedAt: new Date(),
        details: { source: 'post-backup-integrity-check', commandId: command!.id },
      }).returning({ id: backupVerifications.id });
      const [done] = await db.insert(backupVerifications).values({
        orgId: f.orgId, deviceId: f.deviceId, backupJobId: f.jobId, snapshotId: snap!.id,
        verificationType: 'integrity', status: 'passed', startedAt: new Date(), completedAt: new Date(),
      }).returning({ id: backupVerifications.id });
      return { verificationId: waiting!.id, commandId: command!.id, doneId: done!.id };
    });

    const altered = Buffer.from(manifest);
    altered[altered.length - 2] = altered[altered.length - 2]! ^ 1;
    await verifySnapshotAttestation(snap!.id, storage({ [`snapshots/${f.snapshotId}/manifest.json`]: altered }));

    const [verification, done, command] = await withSystemDbAccessContext(async () => [
      (await db.select().from(backupVerifications).where(eq(backupVerifications.id, verificationId)))[0],
      (await db.select().from(backupVerifications).where(eq(backupVerifications.id, doneId)))[0],
      (await db.select().from(deviceCommands).where(eq(deviceCommands.id, commandId)))[0],
    ] as const);
    expect(verification).toMatchObject({ status: 'failed' });
    expect(verification!.completedAt).not.toBeNull();
    expect(verification!.details).toMatchObject({
      source: 'post-backup-integrity-check',
      commandId,
      reason: 'This backup did not match its integrity record and cannot be read from storage.',
    });
    expect(done).toMatchObject({ status: 'passed' });
    expect(command).toMatchObject({ status: 'cancelled' });
  });

  runDb('a storage failure leaves the row pending', async () => {
    const f = await seed();
    await agentResult(f, { statement: statementFor(f, manifestBytes(f.snapshotId)) });
    const snap = await snapshotRow(f);
    const result = await verifySnapshotAttestation(snap!.id, storage({}, true));
    expect(result.outcome).toBe('retry');
    expect((await attestationRows(snap!.id))[0]!.status).toBe('pending');
    expect((await snapshotRow(f))!.integrityStatus).toBe('pending');
  });

  runDb('a run that fell back to full from its dispatched base records and verifies (base kept, parent null)', async () => {
    const f = await seed();
    const base = `snapshot-base-${uid()}`;
    await withSystemDbAccessContext(() => db.update(backupJobs).set({ baseSnapshotId: base }).where(eq(backupJobs.id, f.jobId)));
    const manifest = manifestBytes(f.snapshotId);
    await agentResult(f, { statement: statementFor(f, manifest, { dispatched: base, parent: null }) }, { referencedFiles: 0 });
    const snap = await snapshotRow(f);
    const [row] = await attestationRows(snap!.id);
    expect(row).toMatchObject({ status: 'pending', dispatchedBaseProviderSnapshotId: base, parentProviderSnapshotId: null });
    const result = await verifySnapshotAttestation(snap!.id, storage({ [`snapshots/${f.snapshotId}/manifest.json`]: manifest }));
    expect(result).toEqual({ outcome: 'verified' });
  });

  runDb('a full-run statement over a manifest that references another snapshot fails', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId, [`snapshots/${f.snapshotId}/files/a`, 'snapshots/snapshot-older/files/b']);
    await agentResult(f, { statement: statementFor(f, manifest) });
    const snap = await snapshotRow(f);
    const result = await verifySnapshotAttestation(snap!.id, storage({ [`snapshots/${f.snapshotId}/manifest.json`]: manifest }));
    expect(result).toEqual({ outcome: 'mismatch', reason: 'unexpected_references' });
  });

  runDb('a device that moved organizations before verification still verifies; the row follows the device', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    await agentResult(f, { statement: statementFor(f, manifest) });
    const snap = await snapshotRow(f);

    const target = await createOrganization({ partnerId: f.partnerId });
    // Separate transactions: partner-export org locks are ordered per transaction.
    const [site] = await withSystemDbAccessContext(() =>
      db.insert(sites).values({ orgId: target.id, name: `move ${uid()}` }).returning({ id: sites.id }),
    );
    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE devices SET org_id = ${target.id}::uuid, site_id = ${site!.id}::uuid WHERE id = ${f.deviceId}::uuid`),
    );

    const result = await verifySnapshotAttestation(snap!.id, storage({ [`snapshots/${f.snapshotId}/manifest.json`]: manifest }));
    expect(result).toEqual({ outcome: 'verified' });
    const [row] = await attestationRows(snap!.id);
    expect(row).toMatchObject({ status: 'verified', orgId: target.id });
  });

  runDb('a snapshot row that no longer names the attested device fails with binding_changed', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    await agentResult(f, { statement: statementFor(f, manifest) });
    const snap = await snapshotRow(f);
    const [sibling] = await withSystemDbAccessContext(() =>
      db.insert(devices).values({
        orgId: f.orgId, siteId: f.siteId, agentId: `sib-${uid()}`, hostname: `sib-${uid()}`, osType: 'windows',
        osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
      }).returning({ id: devices.id }),
    );
    await withSystemDbAccessContext(() => db.update(backupSnapshots).set({ deviceId: sibling!.id }).where(eq(backupSnapshots.id, snap!.id)));
    const result = await verifySnapshotAttestation(snap!.id, storage({ [`snapshots/${f.snapshotId}/manifest.json`]: manifest }));
    expect(result).toEqual({ outcome: 'mismatch', reason: 'binding_changed' });
  });
});

describe('job reuse and verification retries', () => {
  function storage(objects: Record<string, Uint8Array>, error?: Error) {
    return {
      ...defaultVerifyDeps,
      fetchObject: vi.fn(async ({ key }: { key: string }) => {
        if (error) throw error;
        const bytes = objects[key];
        if (!bytes) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return bytes;
      }),
    };
  }

  runDb('a result from another job never rewrites an attested snapshot row', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    const statement = statementFor(f, manifest);
    await agentResult(f, { statement }, { filesBackedUp: 3 });
    const before = await snapshotRow(f);

    const [jobB] = await withSystemDbAccessContext(() =>
      db.insert(backupJobs).values({
        orgId: f.orgId, configId: f.configId, deviceId: f.deviceId, status: 'running', storageIdentity: f.storageIdentity,
        startedAt: new Date(),
      }).returning({ id: backupJobs.id }),
    );
    const reuse = { ...f, jobId: jobB!.id };
    const result = await agentResult(reuse, { statement: statementFor(reuse, manifest) }, { filesBackedUp: 99 });
    expect(result.snapshotDbId).toBeNull();

    const [after] = await withSystemDbAccessContext(() => db.select().from(backupSnapshots).where(eq(backupSnapshots.id, before!.id)));
    expect(after).toMatchObject({ jobId: f.jobId, fileCount: before!.fileCount, integrityStatus: 'pending' });
    const rows = await attestationRows(before!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: f.jobId, statement });
  });

  runDb('a snapshot row rewritten between reading and writing the verdict is not attested', async () => {
    const f = await seed();
    const manifest = manifestBytes(f.snapshotId);
    await agentResult(f, { statement: statementFor(f, manifest) });
    const snap = await snapshotRow(f);
    const [jobB] = await withSystemDbAccessContext(() =>
      db.insert(backupJobs).values({ orgId: f.orgId, configId: f.configId, deviceId: f.deviceId, status: 'completed' }).returning({ id: backupJobs.id }),
    );
    const deps = storage({ [`snapshots/${f.snapshotId}/manifest.json`]: manifest });
    const racing = {
      ...deps,
      load: async (id: string) => {
        const loaded = await defaultVerifyDeps.load(id);
        // Another writer re-points the row after the read phase.
        await withSystemDbAccessContext(() => db.update(backupSnapshots).set({ jobId: jobB!.id }).where(eq(backupSnapshots.id, id)));
        return loaded;
      },
    };
    expect(await verifySnapshotAttestation(snap!.id, racing)).toEqual({ outcome: 'mismatch', reason: 'binding_changed' });
    expect((await attestationRows(snap!.id))[0]).toMatchObject({ status: 'mismatch', verifyError: 'binding_changed' });
    expect((await snapshotRow({ ...f, jobId: jobB!.id }))!.integrityStatus).toBe('attestation_failed');
  });

  runDb('a retry deferred by the attempt a sweep triggered is swept at the next tick, not one period later', async () => {
    const { findStalePendingAttestations } = await vi.importActual<typeof import('../../jobs/backupSnapshotAttestationWorker')>(
      '../../jobs/backupSnapshotAttestationWorker',
    );
    const f = await seed();
    await agentResult(f, { statement: statementFor(f, manifestBytes(f.snapshotId)) });
    const snap = await snapshotRow(f);

    // The sweep runs on its tick; the attempt it queues defers a moment later
    // (next_attempt_at = the database's now() + 15 minutes). The tick is read
    // from the database clock so host/container clock skew cannot decide it.
    const [clock] = (await db.execute(sql`SELECT now() AS now`)) as unknown as Array<{ now: Date | string }>;
    const tick = new Date(clock!.now);
    expect(await verifySnapshotAttestation(snap!.id, storage({}, new Error('connect ETIMEDOUT'))))
      .toEqual({ outcome: 'retry', reason: 'fetch_failed:manifest' });
    const [row] = await attestationRows(snap!.id);
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(tick.getTime() + 15 * 60_000);

    const nextTick = new Date(tick.getTime() + 15 * 60_000);
    expect(await findStalePendingAttestations(nextTick)).toContain(snap!.id);
    // A lookahead, not a second period: well before the retry it is not due.
    expect(await findStalePendingAttestations(new Date(tick.getTime() + 10 * 60_000))).not.toContain(snap!.id);
  });

  runDb('storage failures stay pending, back off, and are swept earliest-due first until parked', async () => {
    const { findStalePendingAttestations } = await vi.importActual<typeof import('../../jobs/backupSnapshotAttestationWorker')>(
      '../../jobs/backupSnapshotAttestationWorker',
    );
    const { MAX_VERIFY_ATTEMPTS } = await import('../../services/backupAttestationVerify');

    const a = await seed();
    await agentResult(a, { statement: statementFor(a, manifestBytes(a.snapshotId)) });
    const snapA = await snapshotRow(a);

    const t0 = Date.now();
    expect(await verifySnapshotAttestation(snapA!.id, storage({}, new Error('connect ETIMEDOUT'))))
      .toEqual({ outcome: 'retry', reason: 'fetch_failed:manifest' });
    let [row] = await attestationRows(snapA!.id);
    expect(row).toMatchObject({ status: 'pending', attemptCount: 1, verifyError: 'fetch_failed:manifest' });
    const firstDelay = row!.nextAttemptAt!.getTime() - t0;
    expect(firstDelay).toBeGreaterThan(14 * 60_000);
    expect(firstDelay).toBeLessThan(16 * 60_000);

    expect(await verifySnapshotAttestation(snapA!.id, storage({})))
      .toEqual({ outcome: 'retry', reason: 'object_missing:manifest' });
    [row] = await attestationRows(snapA!.id);
    expect(row).toMatchObject({ status: 'pending', attemptCount: 2, verifyError: 'object_missing:manifest' });
    expect(row!.nextAttemptAt!.getTime() - t0).toBeGreaterThan(29 * 60_000);

    // Not due yet; due once its time passes.
    const now = new Date();
    expect(await findStalePendingAttestations(now)).not.toContain(snapA!.id);
    const later = new Date(row!.nextAttemptAt!.getTime() + 1000);
    expect(await findStalePendingAttestations(later)).toContain(snapA!.id);

    // An earlier-due row sorts ahead of it; a parked row is never swept.
    const b = await seed();
    await agentResult(b, { statement: statementFor(b, manifestBytes(b.snapshotId)) });
    const snapB = await snapshotRow(b);
    const c = await seed();
    await agentResult(c, { statement: statementFor(c, manifestBytes(c.snapshotId)) });
    const snapC = await snapshotRow(c);
    await withSystemDbAccessContext(async () => {
      await db.update(backupSnapshotAttestations)
        .set({ attemptCount: 1, nextAttemptAt: new Date(row!.nextAttemptAt!.getTime() - 60_000) })
        .where(eq(backupSnapshotAttestations.snapshotDbId, snapB!.id));
      await db.update(backupSnapshotAttestations)
        .set({ attemptCount: MAX_VERIFY_ATTEMPTS, nextAttemptAt: new Date(0) })
        .where(eq(backupSnapshotAttestations.snapshotDbId, snapC!.id));
    });
    const due = (await findStalePendingAttestations(later)).filter((id) => [snapA!.id, snapB!.id, snapC!.id].includes(id));
    expect(due).toEqual([snapB!.id, snapA!.id]);
    expect((await attestationRows(snapC!.id))[0]!.status).toBe('pending');
  });
});
