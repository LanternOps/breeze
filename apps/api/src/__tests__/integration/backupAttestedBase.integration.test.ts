/**
 * Incremental base selection for helpers that verify their base: a device
 * reporting snapshot integrity protocol >= 1 is only ever handed a base whose
 * attestation the server verified, together with that base manifest's
 * attested digest. Older helpers keep the existing selection. Real Postgres:
 * the selection is one SQL statement joined to the attestation table.
 */
import './setup';

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotAttestations,
  backupSnapshots,
  devices,
  sites,
} from '../../db/schema';
import { __testOnly } from '../../jobs/backupWorker';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function seed(integrity: number) {
  const unique = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const org = await createOrganization({ partnerId: (await createPartner()).id });
  const providerConfig = { path: `/tmp/attested-base-${unique}` };
  const identity = normalizeStorageIdentity('local', providerConfig);
  return withSystemDbAccessContext(async () => {
    const [site] = await db.insert(sites).values({ orgId: org.id, name: `AB ${unique}` }).returning({ id: sites.id });
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site!.id, agentId: `ab-${unique}`, hostname: `ab-${unique}`, osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', backupIntegrityProtocolVersion: integrity,
    }).returning({ id: devices.id });
    const [config] = await db.insert(backupConfigs).values({
      orgId: org.id, name: `AB ${unique}`, type: 'file', provider: 'local', providerConfig,
    }).returning({ id: backupConfigs.id });

    /** A completed snapshot `minutesAgo` old, optionally with an attestation in `status`. */
    const snapshot = async (name: string, minutesAgo: number, status?: 'verified' | 'mismatch' | 'pending') => {
      const [job] = await db.insert(backupJobs).values({
        orgId: org.id, configId: config!.id, deviceId: device!.id, status: 'completed', startedAt: new Date(), completedAt: new Date(),
      }).returning({ id: backupJobs.id });
      const snapshotId = `${name}-${unique}`;
      const [snap] = await db.insert(backupSnapshots).values({
        orgId: org.id, jobId: job!.id, deviceId: device!.id, configId: config!.id, snapshotId, backupType: 'file',
        storageIdentity: identity, timestamp: new Date(Date.now() - minutesAgo * 60_000),
      }).returning({ id: backupSnapshots.id });
      if (status) {
        const statement = `{"v":1,"snapshotId":"${snapshotId}"}`;
        const [row] = await db.insert(backupSnapshotAttestations).values({
          orgId: org.id, snapshotDbId: snap!.id, jobId: job!.id, deviceId: device!.id, providerSnapshotId: snapshotId,
          storageIdentity: identity, keyLayout: 'legacy_flat', verificationMode: 'server_fetched', acceptedVia: 'agent_result',
          resultReceivedAt: new Date(), formatVersion: 1, statement, statementSha256: sha(statement),
          manifestKey: `snapshots/${snapshotId}/manifest.json`, manifestSha256: sha(`manifest ${snapshotId}`), manifestSize: 321,
        }).returning({ id: backupSnapshotAttestations.id });
        if (status !== 'pending') {
          await db.update(backupSnapshotAttestations).set({ status, verifiedAt: new Date() }).where(eq(backupSnapshotAttestations.id, row!.id));
        }
      }
      return snapshotId;
    };

    const [dispatchJob] = await db.insert(backupJobs).values({
      orgId: org.id, configId: config!.id, deviceId: device!.id, status: 'pending',
      backupMode: 'file', modeTargets: { paths: ['C:\\Data'] },
    }).returning({ id: backupJobs.id });
    return { orgId: org.id, deviceId: device!.id, configId: config!.id, providerConfig, dispatchJobId: dispatchJob!.id, snapshot };
  });
}

function stamp(f: Awaited<ReturnType<typeof seed>>) {
  return withSystemDbAccessContext(() => __testOnly.stampDispatchPinAndIdentity({
    deviceId: f.deviceId, configId: f.configId, jobId: f.dispatchJobId,
    mode: 'file', provider: 'local', providerConfig: f.providerConfig,
  }));
}

runDb('a capable helper gets the newest VERIFIED base and its attested manifest digest', async () => {
  const f = await seed(1);
  const older = await withSystemDbAccessContext(() => f.snapshot('older', 120, 'verified'));
  await withSystemDbAccessContext(() => f.snapshot('newest-unattested', 10));
  await withSystemDbAccessContext(() => f.snapshot('newer-pending', 30, 'pending'));
  await withSystemDbAccessContext(() => f.snapshot('newer-mismatch', 60, 'mismatch'));

  const outcome = await stamp(f);
  expect(outcome.baseSnapshotId).toBe(older);
  expect(outcome.baseAttestation).toEqual({
    manifestKey: `snapshots/${older}/manifest.json`,
    manifestSha256: sha(`manifest ${older}`),
    manifestSize: 321,
  });
  const [job] = await withSystemDbAccessContext(() => db.select().from(backupJobs).where(eq(backupJobs.id, f.dispatchJobId)));
  expect(job!.baseSnapshotId).toBe(older);
});

runDb('a capable helper with no verified base gets a full run and no base attestation', async () => {
  const f = await seed(1);
  await withSystemDbAccessContext(() => f.snapshot('unattested', 10));
  await withSystemDbAccessContext(() => f.snapshot('mismatch', 20, 'mismatch'));

  const outcome = await stamp(f);
  expect(outcome.baseSnapshotId).toBe('');
  expect(outcome.baseAttestation).toBeNull();
  const [job] = await withSystemDbAccessContext(() => db.select().from(backupJobs).where(eq(backupJobs.id, f.dispatchJobId)));
  expect(job!.baseSnapshotId).toBeNull();
});

runDb('an older helper keeps the newest eligible base and gets no base attestation', async () => {
  const f = await seed(0);
  await withSystemDbAccessContext(() => f.snapshot('older-verified', 120, 'verified'));
  const newest = await withSystemDbAccessContext(() => f.snapshot('newest-unattested', 10));

  const outcome = await stamp(f);
  expect(outcome.baseSnapshotId).toBe(newest);
  expect(outcome.baseAttestation).toBeNull();
});

async function dispatchPayload(f: Awaited<ReturnType<typeof seed>>) {
  const [config] = await withSystemDbAccessContext(() => db.select().from(backupConfigs).where(eq(backupConfigs.id, f.configId)));
  const prepared = await withSystemDbAccessContext(() =>
    __testOnly.prepareBackupDispatchTargets(
      { type: 'dispatch-backup', jobId: f.dispatchJobId, configId: f.configId, orgId: f.orgId, deviceId: f.deviceId },
      config!,
    ),
  );
  expect(prepared.status).toBe('ok');
  return (prepared.status === 'ok' ? prepared.prepared[0]!.command.payload : {}) as Record<string, unknown>;
}

runDb('the backup_run payload carries the base attestation for a capable helper only', async () => {
  const capable = await seed(1);
  const base = await withSystemDbAccessContext(() => capable.snapshot('verified', 60, 'verified'));
  const payload = await dispatchPayload(capable);
  expect(payload.baseSnapshotId).toBe(base);
  expect(payload.baseAttestation).toEqual({
    manifestKey: `snapshots/${base}/manifest.json`, manifestSha256: sha(`manifest ${base}`), manifestSize: 321,
  });

  const older = await seed(0);
  const legacyBase = await withSystemDbAccessContext(() => older.snapshot('verified', 60, 'verified'));
  const legacyPayload = await dispatchPayload(older);
  expect(legacyPayload.baseSnapshotId).toBe(legacyBase);
  expect(legacyPayload).not.toHaveProperty('baseAttestation');
});
