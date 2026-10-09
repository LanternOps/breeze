/**
 * Brokered storage sessions against real Postgres, as the unprivileged app
 * role for everything the delivery path and the agent endpoints run:
 *
 *  - delivery mints a session row (token stored only as a hash) under the
 *    command's organization context;
 *  - a session is usable only by its executing device, in its organization:
 *    a device of another organization cannot see it (RLS), another device of
 *    the same organization is refused, a wrong token is refused;
 *  - only the exact authorized keys resolve: control objects, exact file-index
 *    rows, and external rows with a verified origin; everything else is
 *    denied;
 *  - the session ends with its command (device_commands status trigger) and
 *    at its lease expiry;
 *  - a cross-organization insert is rejected by RLS;
 *  - a snapshot deleted while a session is being minted inside the held
 *    delivery transaction withholds that command only (savepoint): the
 *    transaction stays usable and sibling commands are delivered;
 *  - a file-index hydration request is made only after the delivery
 *    transaction has closed, never while it holds its connection.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupStorageSessions.integration.test.ts
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, hasDbAccessContext, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { backupStorageSessions } from '../../db/schema';
import {
  authenticateStorageSession,
  deliverBrokeredReadCommand,
  renewStorageSession,
  resolveStorageSessionObjects,
} from '../../services/backupStorageSessions';
import { backupReadCredentialPayload } from '../../services/backupCommandCredentials';
import { CommandDeliveryRefusedError } from '../../services/commandDeliveryRefusal';
import { drizzleBrokeredReadStore } from '../../services/backupStorageSessionStore';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import { attestSnapshotForTest } from './restoreIntegrityFixture';

const hydration = vi.hoisted(() => ({
  calls: [] as Array<{ snapshotDbId: string; reason: string; inContext: boolean; insideDelivery: boolean }>,
  insideDelivery: false,
}));

vi.mock('../../jobs/backupSnapshotFileIndexWorker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/backupSnapshotFileIndexWorker')>()),
  enqueueSnapshotFileIndexHydration: vi.fn(async (snapshotDbId: string, reason: string) => {
    hydration.calls.push({ snapshotDbId, reason, inContext: hasDbAccessContext(), insideDelivery: hydration.insideDelivery });
    return `hydrate-${snapshotDbId}`;
  }),
}));

type SessionDescriptor = { sessionId: string; token: string; baseUrl: string; expiresAt: string; deadline: string };

const runDb = it.runIf(!!process.env.DATABASE_URL);

const DESTINATION = {
  bucket: 'tenant-bucket',
  region: 'us-east-1',
  endpoint: 'https://storage.example',
  accessKey: 'AKIA-SYNTHETIC-ACCESS',
  secretKey: 'synthetic-secret-value',
};
const IDENTITY = normalizeStorageIdentity('s3', DESTINATION);
const SNAP = 'snap-2026-09-26-full';
const OLDER = 'snap-2026-09-25-base';

const previousPublicUrl = process.env.PUBLIC_API_URL;
beforeAll(() => {
  process.env.PUBLIC_API_URL = 'https://api.breeze.example';
});
afterAll(() => {
  if (previousPublicUrl === undefined) delete process.env.PUBLIC_API_URL;
  else process.env.PUBLIC_API_URL = previousPublicUrl;
});

// A helper that checks restores against snapshot attestations (integrity
// protocol 2), as every current helper does.
async function seedDevice(orgId: string, siteId: string, protocol: number) {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version,
      backup_read_protocol_version, backup_integrity_protocol_version)
    VALUES (${id}, ${orgId}, ${siteId}, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`}, 'windows', '11', 'amd64', '2.0.0', ${protocol}, 2)
  `);
  return id;
}

// backup_snapshots is unique on (storage_identity, snapshot_id) across orgs, so a
// second org seeded against the same destination needs its own snapshot id.
async function seedOrg(opts: { snapshotId?: string } = {}) {
  const snapshotId = opts.snapshotId ?? SNAP;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteId = randomUUID();
  await getTestDb().execute(sql`INSERT INTO sites (id, org_id, name) VALUES (${siteId}, ${org.id}, 'Primary')`);
  const executing = await seedDevice(org.id, siteId, 1);
  const source = await seedDevice(org.id, siteId, 1);
  const configId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
    VALUES (${configId}, ${org.id}, 'Primary', 'file', 's3', ${JSON.stringify(DESTINATION)}::jsonb)
  `);
  const jobId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type)
    VALUES (${jobId}, ${org.id}, ${configId}, ${source}, 'completed', 'manual')
  `);
  const snapshotDbId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshots (id, org_id, job_id, device_id, config_id, snapshot_id, storage_identity, file_index_status,
      file_index_manifest_sha256)
    VALUES (${snapshotDbId}, ${org.id}, ${jobId}, ${source}, ${configId}, ${snapshotId}, ${IDENTITY}, 'complete', ${'a'.repeat(64)})
  `);
  // Attested by its producing helper and verified by the server, as every
  // snapshot from a current helper is; the index above was built from the
  // attested manifest bytes.
  await attestSnapshotForTest(snapshotDbId);
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_files (snapshot_db_id, source_path, backup_path) VALUES
      (${snapshotDbId}, '/a.txt', ${`snapshots/${snapshotId}/files/a.txt`}),
      (${snapshotDbId}, '/c.txt', ${`snapshots/${OLDER}/files/c.txt`}),
      (${snapshotDbId}, '/d.txt', ${'snapshots/snap-unverified/files/d.txt'})
  `);
  await getTestDb().execute(sql`
    INSERT INTO backup_snapshot_origins (snapshot_db_id, origin_snapshot_id, origin_org_id, origin_device_id, origin_storage_identity, provenance, object_count)
    VALUES (${snapshotDbId}, ${OLDER}, ${org.id}, ${source}, ${IDENTITY}, 'live', 1)
  `);
  return { orgId: org.id, siteId, executing, source, configId, snapshotDbId };
}

async function queueRestore(deviceId: string, payload: Record<string, unknown>, claimedAt?: Date) {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO device_commands (id, device_id, type, status, payload, executed_at)
    VALUES (${id}, ${deviceId}, 'backup_restore', 'sent', ${JSON.stringify(payload)}::jsonb,
            ${claimedAt ? sql`${claimedAt.toISOString()}::timestamp` : sql`now()`})
  `);
  return id;
}

function orgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() =>
    withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, fn),
  );
}

async function mint(org: Awaited<ReturnType<typeof seedOrg>>) {
  const payload = { snapshotId: SNAP, targetPath: '/restore', ...backupReadCredentialPayload(org.configId, org.orgId, 's3') };
  const commandId = await queueRestore(org.executing, payload);
  const delivered = await runOutsideDbContext(() =>
    deliverBrokeredReadCommand(payload, {
      commandId,
      deviceId: org.executing,
      type: 'backup_restore',
      claimedAt: new Date(),
    }),
  );
  return { commandId, delivered, session: delivered.storageSession as SessionDescriptor };
}

describe('brokered storage sessions (real database)', () => {
  runDb('delivery mints a session bound to the command and stores only a token hash', async () => {
    const org = await seedOrg();
    const { commandId, delivered, session } = await mint(org);

    expect(delivered).not.toHaveProperty('providerConfig');
    expect(delivered).not.toHaveProperty('providerConfigRef');
    expect(session.baseUrl).toBe('https://api.breeze.example');

    const rows = (await getTestDb().execute(sql`
      SELECT org_id, command_id, device_id, source_device_id, snapshot_id, config_id, storage_identity, token_hash, generation, revoked_at
      FROM backup_storage_sessions WHERE id = ${session.sessionId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: org.orgId,
      command_id: commandId,
      device_id: org.executing,
      source_device_id: org.source,
      snapshot_id: org.snapshotDbId,
      config_id: org.configId,
      storage_identity: IDENTITY,
      token_hash: createHash('sha256').update(session.token).digest('hex'),
      generation: 1,
      revoked_at: null,
    });
    const dump = JSON.stringify(await getTestDb().execute(sql`SELECT * FROM backup_storage_sessions WHERE id = ${session.sessionId}`));
    expect(dump).not.toContain(session.token);
    expect(dump).not.toContain(DESTINATION.secretKey);
  });

  runDb('refuses the token from another organization, another device, or with a wrong value', async () => {
    const org = await seedOrg();
    const foreign = await seedOrg({ snapshotId: 'snap-2026-09-26-foreign' });
    const { session } = await mint(org);

    const ok = await orgContext(org.orgId, () =>
      authenticateStorageSession({ sessionId: session.sessionId, token: session.token, agent: { deviceId: org.executing, orgId: org.orgId } }),
    );
    expect(ok.ok).toBe(true);

    // A device of another organization: the session is invisible under its RLS context.
    const crossOrg = await orgContext(foreign.orgId, () =>
      authenticateStorageSession({ sessionId: session.sessionId, token: session.token, agent: { deviceId: foreign.executing, orgId: foreign.orgId } }),
    );
    expect(crossOrg).toMatchObject({ ok: false, status: 404 });

    // Another device of the same organization (the snapshot's own source device).
    const crossDevice = await orgContext(org.orgId, () =>
      authenticateStorageSession({ sessionId: session.sessionId, token: session.token, agent: { deviceId: org.source, orgId: org.orgId } }),
    );
    expect(crossDevice).toMatchObject({ ok: false, status: 403 });

    const wrongToken = await orgContext(org.orgId, () =>
      authenticateStorageSession({ sessionId: session.sessionId, token: 'x'.repeat(43), agent: { deviceId: org.executing, orgId: org.orgId } }),
    );
    expect(wrongToken).toMatchObject({ ok: false, status: 401 });
  });

  runDb('resolves only exact authorized keys and denies non-members', async () => {
    const org = await seedOrg();
    const { session } = await mint(org);
    const keys = [
      `snapshots/${SNAP}/manifest.json`,
      `snapshots/${SNAP}/files/a.txt`,
      `snapshots/${OLDER}/files/c.txt`,
      'snapshots/snap-unverified/files/d.txt',
      `snapshots/${SNAP}/files/other.txt`,
      `snapshots/${SNAP}/files/`,
      `snapshots/${SNAP}/files/A.txt`,
      '',
    ];
    const result = await orgContext(org.orgId, async () => {
      const auth = await authenticateStorageSession({ sessionId: session.sessionId, token: session.token, agent: { deviceId: org.executing, orgId: org.orgId } });
      if (!auth.ok) throw new Error(`auth failed: ${auth.status}`);
      return resolveStorageSessionObjects(auth.session, keys);
    });
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.objects.map((o) => o.key)).toEqual([
      `snapshots/${SNAP}/manifest.json`,
      `snapshots/${SNAP}/files/a.txt`,
      `snapshots/${OLDER}/files/c.txt`,
    ]);
    expect(result.body.denied).toEqual([
      'snapshots/snap-unverified/files/d.txt',
      `snapshots/${SNAP}/files/other.txt`,
      `snapshots/${SNAP}/files/`,
      `snapshots/${SNAP}/files/A.txt`,
      '',
    ]);
    for (const o of result.body.objects) {
      const url = new URL(o.url);
      expect(url.protocol).toBe('https:');
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
      expect(o.headers).toEqual({});
    }
    const counts = (await getTestDb().execute(sql`
      SELECT call_count, resolved_object_count FROM backup_storage_sessions WHERE id = ${session.sessionId}
    `)) as unknown as Array<{ call_count: number; resolved_object_count: number }>;
    expect(counts[0]).toEqual({ call_count: 1, resolved_object_count: 3 });
  });

  runDb('ends when the command reaches a terminal state', async () => {
    const org = await seedOrg();
    const { commandId, session } = await mint(org);
    await getTestDb().execute(sql`UPDATE device_commands SET status = 'completed', completed_at = now() WHERE id = ${commandId}`);

    const revoked = (await getTestDb().execute(sql`
      SELECT revoked_at, revoked_reason FROM backup_storage_sessions WHERE id = ${session.sessionId}
    `)) as unknown as Array<{ revoked_at: Date | null; revoked_reason: string | null }>;
    expect(revoked[0]!.revoked_at).not.toBeNull();
    expect(revoked[0]!.revoked_reason).toBe('command_completed');

    const result = await orgContext(org.orgId, () =>
      authenticateStorageSession({ sessionId: session.sessionId, token: session.token, agent: { deviceId: org.executing, orgId: org.orgId } }),
    );
    expect(result).toMatchObject({ ok: false, status: 410 });
  });

  runDb('ends at lease expiry, and a renew never passes the deadline', async () => {
    const org = await seedOrg();
    const { session } = await mint(org);

    const renewed = await orgContext(org.orgId, async () => {
      const auth = await authenticateStorageSession({ sessionId: session.sessionId, token: session.token, agent: { deviceId: org.executing, orgId: org.orgId } });
      if (!auth.ok) throw new Error('auth failed');
      return renewStorageSession(auth.session);
    });
    expect(renewed.status).toBe(200);
    if (renewed.status === 200) {
      expect(Date.parse(renewed.body.expiresAt)).toBeLessThanOrEqual(Date.parse(session.deadline));
    }

    await getTestDb().execute(sql`
      UPDATE backup_storage_sessions SET expires_at = now() - interval '1 second' WHERE id = ${session.sessionId}
    `);
    const expired = await orgContext(org.orgId, () =>
      authenticateStorageSession({ sessionId: session.sessionId, token: session.token, agent: { deviceId: org.executing, orgId: org.orgId } }),
    );
    expect(expired).toMatchObject({ ok: false, status: 410 });
  });

  runDb('redelivery mints a new generation while the earlier one stays usable', async () => {
    const org = await seedOrg();
    const first = await mint(org);
    const payload = { snapshotId: SNAP, ...backupReadCredentialPayload(org.configId, org.orgId, 's3') };
    const second = await runOutsideDbContext(() =>
      deliverBrokeredReadCommand(payload, { commandId: first.commandId, deviceId: org.executing, type: 'backup_restore', claimedAt: new Date() }),
    );
    const s2 = second.storageSession as SessionDescriptor;
    const gens = (await getTestDb().execute(sql`
      SELECT generation FROM backup_storage_sessions WHERE command_id = ${first.commandId} ORDER BY generation
    `)) as unknown as Array<{ generation: number }>;
    expect(gens.map((g) => g.generation)).toEqual([1, 2]);
    for (const s of [first.session, s2]) {
      const auth = await orgContext(org.orgId, () =>
        authenticateStorageSession({ sessionId: s.sessionId, token: s.token, agent: { deviceId: org.executing, orgId: org.orgId } }),
      );
      expect(auth.ok).toBe(true);
    }
  });

  runDb('rejects a session row inserted under another organization', async () => {
    const org = await seedOrg();
    const foreign = await seedOrg({ snapshotId: 'snap-2026-09-26-foreign' });
    const commandId = await queueRestore(org.executing, { snapshotId: SNAP });
    const insert = () =>
      db.insert(backupStorageSessions).values({
        orgId: org.orgId,
        commandId,
        deviceId: org.executing,
        sourceDeviceId: org.source,
        snapshotId: org.snapshotDbId,
        configId: org.configId,
        storageIdentity: IDENTITY,
        useFileIndex: true,
        tokenHash: 'a'.repeat(64),
        generation: 1,
        maxCalls: 10,
        maxResolvedObjects: 10,
        expiresAt: new Date(Date.now() + 60_000),
        deadline: new Date(Date.now() + 120_000),
        rateCallsAvailable: 10,
        rateObjectsAvailable: 10,
        rateRefilledAt: new Date(),
      });
    let code: string | undefined;
    try {
      await orgContext(foreign.orgId, insert);
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe('42501');
  });

  runDb('an on-demand database backup whose job carries the storage identity is brokered on its first restore', async () => {
    const org = await seedOrg();
    // The job as the on-demand MSSQL route now creates it: identity stamped at creation.
    const jobId = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type, backup_type, storage_identity, started_at)
      VALUES (${jobId}, ${org.orgId}, ${org.configId}, ${org.source}, 'running', 'manual', 'database', ${IDENTITY}, now())
    `);
    const providerSnapshotId = `mssql-sqlexpress-appdb-${Date.now()}`;
    const applied = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      applyBackupCommandResultToJob({
        jobId,
        orgId: org.orgId,
        deviceId: org.source,
        resultStatus: 'completed',
        result: {
          snapshotId: providerSnapshotId,
          filesBackedUp: 1,
          bytesBackedUp: 1024,
          backupType: 'database',
          metadata: { backupKind: 'mssql_database', instance: 'SQLEXPRESS', database: 'AppDb', backupFileName: 'AppDb_full.bak' },
        },
      }),
    ));
    expect(applied.snapshotDbId).not.toBeNull();
    const stamped = (await getTestDb().execute(
      sql`SELECT storage_identity FROM backup_snapshots WHERE id = ${applied.snapshotDbId}`,
    )) as unknown as Array<{ storage_identity: string | null }>;
    expect(stamped[0]!.storage_identity).toBe(IDENTITY);
    // The helper's attestation for it (recorded with a current helper's result).
    await attestSnapshotForTest(applied.snapshotDbId!);

    const payload = {
      instance: 'SQLEXPRESS',
      snapshotId: providerSnapshotId,
      backupFileName: 'AppDb_full.bak',
      targetDatabase: 'AppDb_copy',
      ...backupReadCredentialPayload(org.configId, org.orgId, 's3'),
    };
    const commandId = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO device_commands (id, device_id, type, status, payload, executed_at)
      VALUES (${commandId}, ${org.executing}, 'mssql_restore', 'sent', ${JSON.stringify(payload)}::jsonb, now())
    `);
    const delivered = await runOutsideDbContext(() =>
      deliverBrokeredReadCommand(payload, { commandId, deviceId: org.executing, type: 'mssql_restore', claimedAt: new Date() }),
    );
    expect(delivered).toHaveProperty('storageSession');
    expect(delivered).not.toHaveProperty('providerConfig');
  });

  runDb('an older helper is refused, and is never sent the storage destination', async () => {
    const org = await seedOrg();
    await getTestDb().execute(sql`UPDATE devices SET backup_read_protocol_version = 0 WHERE id = ${org.executing}`);
    const payload = { snapshotId: SNAP, ...backupReadCredentialPayload(org.configId, org.orgId, 's3') };
    const commandId = await queueRestore(org.executing, payload);
    await expect(runOutsideDbContext(() =>
      deliverBrokeredReadCommand(payload, { commandId, deviceId: org.executing, type: 'backup_restore', claimedAt: new Date() }),
    )).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    const n = (await getTestDb().execute(sql`SELECT count(*)::int AS n FROM backup_storage_sessions WHERE command_id = ${commandId}`)) as unknown as Array<{ n: number }>;
    expect(n[0]!.n).toBe(0);
  });
  runDb('rate limits resolution with a real Retry-After and ends a session whose ceiling is spent', async () => {
    const org = await seedOrg();
    const { session } = await mint(org);
    const agent = { deviceId: org.executing, orgId: org.orgId };
    const resolveOnce = () =>
      orgContext(org.orgId, async () => {
        const auth = await authenticateStorageSession({ sessionId: session.sessionId, token: session.token, agent });
        if (!auth.ok) return { status: auth.status } as const;
        return resolveStorageSessionObjects(auth.session, [`snapshots/${SNAP}/manifest.json`]);
      });

    // An empty object bucket with no refill time elapsed (a refill stamp at or
    // after the API's clock counts as no time): throttled, nothing consumed.
    await getTestDb().execute(sql`
      UPDATE backup_storage_sessions SET rate_objects_available = 0, rate_refilled_at = now() + interval '1 hour' WHERE id = ${session.sessionId}
    `);
    const throttled = await resolveOnce();
    expect(throttled).toMatchObject({ status: 429 });
    if (throttled.status === 429) expect(throttled.retryAfterSeconds).toBe(1);
    const [afterThrottle] = (await getTestDb().execute(sql`
      SELECT call_count, resolved_object_count FROM backup_storage_sessions WHERE id = ${session.sessionId}
    `)) as unknown as Array<{ call_count: number; resolved_object_count: number }>;
    expect(afterThrottle).toEqual({ call_count: 0, resolved_object_count: 0 });

    // Once the bucket has refilled, the same call is served and consumed.
    await getTestDb().execute(sql`
      UPDATE backup_storage_sessions SET rate_refilled_at = now() - interval '2 seconds' WHERE id = ${session.sessionId}
    `);
    expect(await resolveOnce()).toMatchObject({ status: 200 });
    const [afterGrant] = (await getTestDb().execute(sql`
      SELECT call_count, resolved_object_count FROM backup_storage_sessions WHERE id = ${session.sessionId}
    `)) as unknown as Array<{ call_count: number; resolved_object_count: number }>;
    expect(afterGrant).toEqual({ call_count: 1, resolved_object_count: 1 });

    // The lifetime ceiling spent: a terminal answer, and the session is revoked.
    await getTestDb().execute(sql`
      UPDATE backup_storage_sessions SET resolved_object_count = max_resolved_objects WHERE id = ${session.sessionId}
    `);
    expect(await resolveOnce()).toMatchObject({ status: 410 });
    const [ended] = (await getTestDb().execute(sql`
      SELECT revoked_at IS NOT NULL AS revoked, revoked_reason FROM backup_storage_sessions WHERE id = ${session.sessionId}
    `)) as unknown as Array<{ revoked: boolean; revoked_reason: string | null }>;
    expect(ended).toEqual({ revoked: true, revoked_reason: 'budget_exhausted' });
  });

  runDb('a snapshot deleted while its session is minted never falls back to the destination', async () => {
    const org = await seedOrg();
    const payloadA = { snapshotId: SNAP, ...backupReadCredentialPayload(org.configId, org.orgId, 's3') };
    const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
    const doomed = await queueRestore(org.executing, payloadA, claimedAt);
    const healthy = await queueRestore(org.executing, payloadA, claimedAt);

    // The snapshot disappears (retention, an operator delete) between the
    // mint's reads and its insert: the insert then fails its foreign key.
    const realInsert = drizzleBrokeredReadStore.insertSession;
    let deleted = false;
    const spy = vi.spyOn(drizzleBrokeredReadStore, 'insertSession').mockImplementation(async (row) => {
      if (row.commandId === doomed && !deleted) {
        deleted = true;
        // Committed on another connection, as a concurrent delete would be.
        await getTestDb().execute(sql`DELETE FROM backup_snapshots WHERE id = ${org.snapshotDbId}`);
      }
      return realInsert.call(drizzleBrokeredReadStore, row);
    });
    try {
      const delivered = await runOutsideDbContext(() =>
        withDbAccessContext({ scope: 'organization', orgId: org.orgId, accessibleOrgIds: [org.orgId] }, async () => {
          const out = await prepareClaimedCommandsForDelivery(
            [
              { id: doomed, type: 'backup_restore', deviceId: org.executing, payload: payloadA, executedAt: claimedAt },
              { id: healthy, type: 'backup_restore', deviceId: org.executing, payload: payloadA, executedAt: claimedAt },
            ],
            { reportedBackupReadProtocolVersion: 1 },
          );
          // The held transaction is still usable after the failed insert.
          await db.execute(sql`SELECT 1`);
          return out;
        }),
      );
      expect(deleted).toBe(true);
      // The sibling was prepared after the snapshot vanished: it is refused
      // (snapshot not found) and left for the reaper to expire, never sent the
      // destination.
      expect(delivered).toEqual([]);
      const rows = (await getTestDb().execute(sql`
        SELECT id, status, result->>'deliveryRefusal' AS refusal FROM device_commands WHERE id IN (${doomed}, ${healthy})
      `)) as unknown as Array<{ id: string; status: string; refusal: string | null }>;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[doomed]).toMatchObject({ status: 'pending', refusal: null }); // released for a later attempt, committed with the transaction
      expect(byId[healthy]!.status).toBe('pending');
      expect(byId[healthy]!.refusal).toMatch(/could not be found/);
      const n = (await getTestDb().execute(sql`
        SELECT count(*)::int AS n FROM backup_storage_sessions WHERE command_id IN (${doomed}, ${healthy})
      `)) as unknown as Array<{ n: number }>;
      expect(n[0]!.n).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  runDb('requests file-index hydration only after the delivery transaction has closed', async () => {
    const org = await seedOrg();
    await getTestDb().execute(sql`UPDATE backup_snapshots SET file_index_status = 'none' WHERE id = ${org.snapshotDbId}`);
    const payload = { snapshotId: SNAP, ...backupReadCredentialPayload(org.configId, org.orgId, 's3') };
    const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
    const commandId = await queueRestore(org.executing, payload, claimedAt);
    hydration.calls.length = 0;

    const delivered = await runOutsideDbContext(() =>
      withDbAccessContext({ scope: 'organization', orgId: org.orgId, accessibleOrgIds: [org.orgId] }, async () => {
        hydration.insideDelivery = true;
        try {
          const out = await prepareClaimedCommandsForDelivery(
            [{ id: commandId, type: 'backup_restore', deviceId: org.executing, payload, executedAt: claimedAt }],
            { reportedBackupReadProtocolVersion: 1 },
          );
          // Let any fire-and-forget work scheduled from inside the transaction run now.
          for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
          return out;
        } finally {
          hydration.insideDelivery = false;
        }
      }),
    );

    // Deferred, never sent the destination: the row is released for the next
    // claim with the reason recorded.
    expect(delivered).toHaveLength(0);
    const [row] = (await getTestDb().execute(
      sql`SELECT status, result FROM device_commands WHERE id = ${commandId}`,
    )) as unknown as Array<{ status: string; result: Record<string, unknown> | null }>;
    expect(row!.status).toBe('pending');
    expect(row!.result).toHaveProperty('deliveryDeferred');
    await vi.waitFor(() => expect(hydration.calls).toHaveLength(1));
    expect(hydration.calls[0]).toEqual({
      snapshotDbId: org.snapshotDbId,
      reason: 'brokered_read',
      inContext: false,
      insideDelivery: false,
    });
  });
});
