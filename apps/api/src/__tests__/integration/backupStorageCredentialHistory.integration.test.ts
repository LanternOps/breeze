/**
 * Storage key history against real Postgres, as the unprivileged app role:
 *
 *  - keys in use before enforcement are recorded once, idempotently, with
 *    broadcast_until = the time this release's migrations ran; keys
 *    configured afterwards are recorded with broadcast_until NULL;
 *  - replacing a key (or deleting the destination) supersedes its row and
 *    keeps the old connection settings sealed on it;
 *  - checking an old key: only a key id that no longer exists records
 *    probe_denied and erases the sealed settings; a key refused for listing
 *    (it may still upload), a key that still works, or a check that cannot
 *    tell records no evidence (the storage error code is kept); a key id that no longer exists is recorded for every
 *    other replaced destination of the same organization using it — never
 *    for another organization's, and never for a destination still using it;
 *  - the first-start recording re-reads each destination under a row lock, so
 *    a key replaced concurrently is never recorded as current;
 *  - operator confirmation is recorded as weaker evidence;
 *  - sealed settings are erased 30 days after the key was replaced;
 *  - RLS: an organization cannot see another's history; a row cannot name
 *    another organization's destination; org erasure removes the history.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/backupStorageCredentialHistory.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, hasDbAccessContext, withDbAccessContext } from '../../db';
import { runBackupWriteSessionJanitor } from '../../jobs/backupWriteSessionJanitor';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
import {
  CREDENTIAL_HISTORY_MIGRATION,
  __resetEnforcementMomentForTests,
  attestCredentialDisabled,
  baselineCredentialHistory,
  checkReplacedCredential,
  credentialFingerprint,
  eraseExpiredSealedSettings,
  listOutstandingCredentials,
  openSealedConnection,
  recordCredentialChange,
  type S3Connection,
} from '../../services/backupStorageCredentialHistory';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { WRITE_DESTINATION, expectSqlState, orgContext, seedWriteTenant } from './backupWriteFixtures';
import { createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const NEW_KEYS = { accessKey: 'AKIA-SYNTHETIC-REPLACEMENT', secretKey: 'synthetic-replacement-secret' };

type Row = Record<string, unknown> & {
  id: string;
  org_id: string;
  config_id: string | null;
  access_key_fingerprint: string;
  broadcast_until: Date | null;
  superseded_at: Date | null;
  sealed_previous_secret: string | null;
  revoked_at: Date | null;
  revocation_evidence: string | null;
  evidence_detail: string | null;
  verified_by_user_id: string | null;
  last_probe_outcome: string | null;
  last_probe_code: string | null;
};

async function historyFor(configId: string): Promise<Row[]> {
  return (await getTestDb().execute(sql`
    SELECT * FROM backup_storage_credential_history WHERE config_id = ${configId} ORDER BY superseded_at NULLS LAST, created_at
  `)) as unknown as Row[];
}

async function historyRow(id: string): Promise<Row> {
  const rows = (await getTestDb().execute(sql`SELECT * FROM backup_storage_credential_history WHERE id = ${id}`)) as unknown as Row[];
  return rows[0]!;
}

async function enforcementMoment(): Promise<Date> {
  const rows = (await getTestDb().execute(sql`
    SELECT applied_at FROM breeze_migrations WHERE filename = ${CREDENTIAL_HISTORY_MIGRATION}
  `)) as unknown as Array<{ applied_at: Date }>;
  return new Date(rows[0]!.applied_at);
}

function inOrg(orgId: string) {
  return <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn);
}

async function replaceKeys(t: { orgId: string; configId: string }, next: Record<string, unknown>, now?: Date) {
  const [cfg] = (await getTestDb().execute(sql`
    SELECT provider, provider_config FROM backup_configs WHERE id = ${t.configId}
  `)) as unknown as Array<{ provider: string; provider_config: Record<string, unknown> }>;
  await inOrg(t.orgId)(() => recordCredentialChange({
    orgId: t.orgId,
    configId: t.configId,
    previous: { provider: cfg!.provider, providerConfig: cfg!.provider_config },
    next: { provider: 's3', providerConfig: next },
    ...(now ? { now } : {}),
  }));
  await getTestDb().execute(sql`
    UPDATE backup_configs SET provider_config = ${JSON.stringify(next)}::jsonb WHERE id = ${t.configId}
  `);
}

const refused = (code = 'InvalidAccessKeyId') => async () => ({ outcome: 'denied' as const, code });

beforeEach(() => {
  __resetEnforcementMomentForTests();
});

describe('storage key history', () => {
  runDb('records every S3 destination\'s key in use at the first start as in use before enforcement, once', async () => {
    const t = await seedWriteTenant();
    const local = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
      VALUES (${local}, ${t.orgId}, 'Local', 'file', 'local', '{"path":"/backups"}'::jsonb)
    `);

    await baselineCredentialHistory();
    await baselineCredentialHistory();

    const rows = await historyFor(t.configId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.access_key_fingerprint).toBe(credentialFingerprint(
      WRITE_DESTINATION.accessKey, normalizeStorageIdentity('s3', WRITE_DESTINATION),
    ));
    expect(new Date(rows[0]!.broadcast_until as unknown as string).getTime()).toBe((await enforcementMoment()).getTime());
    expect(rows[0]!.superseded_at).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(WRITE_DESTINATION.accessKey);
    expect(JSON.stringify(rows[0])).not.toContain(WRITE_DESTINATION.secretKey);
    expect(await historyFor(local)).toEqual([]);
  });

  runDb('a destination created after enforcement records its key as never sent to a device', async () => {
    const t = await seedWriteTenant();
    await inOrg(t.orgId)(() => recordCredentialChange({
      orgId: t.orgId, configId: t.configId, previous: null, next: { provider: 's3', providerConfig: WRITE_DESTINATION },
    }));
    await baselineCredentialHistory();

    const rows = await historyFor(t.configId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.broadcast_until).toBeNull();
    expect(await inOrg(t.orgId)(() => listOutstandingCredentials(t.orgId))).toEqual([]);
  });

  runDb('replacing the key supersedes the old row with its settings sealed, and the new key is current', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });

    const rows = await historyFor(t.configId);
    expect(rows).toHaveLength(2);
    const [old, current] = rows as [Row, Row];
    expect(old.superseded_at).not.toBeNull();
    expect(old.broadcast_until).not.toBeNull();
    expect(old.sealed_previous_secret).toMatch(/^enc:/);
    expect(old.sealed_previous_secret).not.toContain(WRITE_DESTINATION.secretKey);
    expect(openSealedConnection(old.id, old.sealed_previous_secret!)).toMatchObject({
      accessKey: WRITE_DESTINATION.accessKey, secretKey: WRITE_DESTINATION.secretKey, bucket: WRITE_DESTINATION.bucket,
    });
    expect(current.superseded_at).toBeNull();
    expect(current.broadcast_until).toBeNull();

    const outstanding = await inOrg(t.orgId)(() => listOutstandingCredentials(t.orgId));
    expect(outstanding).toEqual([expect.objectContaining({ id: old.id, canCheck: true, configName: 'Primary' })]);
  });

  runDb('a key replaced before the first start was recorded is still recorded as in use before enforcement', async () => {
    const t = await seedWriteTenant();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [old, current] = (await historyFor(t.configId)) as [Row, Row];
    expect(old.broadcast_until).not.toBeNull();
    expect(old.superseded_at).not.toBeNull();
    expect(current.broadcast_until).toBeNull();
  });

  runDb('a change that keeps the same key pair and storage records nothing', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION });
    expect(await historyFor(t.configId)).toHaveLength(1);
  });

  runDb('an old key whose key id no longer exists is recorded as disabled and its sealed settings are erased', async () => {
    const t = await seedWriteTenant();
    const user = await createUser({ partnerId: t.partnerId, orgId: t.orgId });
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [old] = (await historyFor(t.configId)) as [Row];

    const seen: S3Connection[] = [];
    const res = await checkReplacedCredential({
      historyId: old.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: user.id,
      probe: async (c) => { seen.push(c); return { outcome: 'denied', code: 'InvalidAccessKeyId' }; },
    });

    expect(res).toEqual({ status: 'revoked', code: 'InvalidAccessKeyId' });
    expect(seen[0]).toMatchObject({ accessKey: WRITE_DESTINATION.accessKey });
    const after = await historyRow(old.id);
    expect(after).toMatchObject({
      revocation_evidence: 'probe_denied', evidence_detail: 'InvalidAccessKeyId', verified_by_user_id: user.id,
      sealed_previous_secret: null,
    });
    expect(after.revoked_at).not.toBeNull();
    expect(await inOrg(t.orgId)(() => listOutstandingCredentials(t.orgId))).toEqual([]);
  });

  runDb('a key that still works, or a check that cannot tell, records no evidence', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [old] = (await historyFor(t.configId)) as [Row];

    expect(await checkReplacedCredential({
      historyId: old.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: null, probe: async () => ({ outcome: 'live', code: null }),
    })).toEqual({ status: 'still_live' });
    expect(await historyRow(old.id)).toMatchObject({ revoked_at: null, last_probe_outcome: 'still_live' });

    expect(await checkReplacedCredential({
      historyId: old.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: null,
      probe: async () => ({ outcome: 'inconclusive', code: 'ECONNREFUSED' }),
    })).toEqual({ status: 'inconclusive', code: 'ECONNREFUSED' });
    const after = await historyRow(old.id);
    expect(after).toMatchObject({ revoked_at: null, last_probe_outcome: 'inconclusive', last_probe_code: 'ECONNREFUSED' });
    expect(after.sealed_previous_secret).not.toBeNull();
  });

  runDb('the key a destination still uses cannot be checked or confirmed as disabled', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    const [current] = (await historyFor(t.configId)) as [Row];
    expect(await checkReplacedCredential({ historyId: current.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: null, probe: refused() }))
      .toEqual({ status: 'not_checkable', reason: 'in_use' });
    expect(await attestCredentialDisabled({
      historyId: current.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: null, evidence: 'operator_attested', detail: null,
    })).toEqual({ status: 'not_checkable', reason: 'in_use' });
  });

  runDb('a key id that no longer exists is recorded for the organization\'s other replaced destinations using it — never another organization\'s, never one still in use', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant();
    const aSecond = randomUUID();
    const aThird = randomUUID();
    for (const id of [aSecond, aThird]) {
      await getTestDb().execute(sql`
        INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
        VALUES (${id}, ${a.orgId}, 'Second', 'file', 's3', ${JSON.stringify(WRITE_DESTINATION)}::jsonb)
      `);
    }
    await baselineCredentialHistory();
    await replaceKeys(a, { ...WRITE_DESTINATION, ...NEW_KEYS });
    await replaceKeys({ orgId: a.orgId, configId: aSecond }, { ...WRITE_DESTINATION, ...NEW_KEYS });
    await replaceKeys(b, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [aOld] = (await historyFor(a.configId)) as [Row];
    const [aSecondOld] = (await historyFor(aSecond)) as [Row];
    const [aThirdCurrent] = (await historyFor(aThird)) as [Row];
    const [bOld] = (await historyFor(b.configId)) as [Row];
    expect(new Set([aSecondOld.access_key_fingerprint, aThirdCurrent.access_key_fingerprint, bOld.access_key_fingerprint]))
      .toEqual(new Set([aOld.access_key_fingerprint]));

    await checkReplacedCredential({ historyId: aOld.id, orgId: a.orgId, inOrg: inOrg(a.orgId), userId: null, probe: refused('InvalidAccessKeyId') });

    expect(await historyRow(aSecondOld.id)).toMatchObject({ revocation_evidence: 'probe_denied', sealed_previous_secret: null });
    expect((await historyRow(aSecondOld.id)).evidence_detail).toMatch(/another destination/);
    expect(await historyRow(aThirdCurrent.id)).toMatchObject({ revoked_at: null });
    const bAfter = await historyRow(bOld.id);
    expect(bAfter.revoked_at).toBeNull();
    expect(bAfter.sealed_previous_secret).not.toBeNull();
  });

  runDb('the first-start recording never records a key replaced concurrently as current', async () => {
    const t = await seedWriteTenant();
    // The destination changes after the recording read it but before it locks it.
    let changed = false;
    await baselineCredentialHistory({
      beforeRecord: async (configId) => {
        if (changed || configId !== t.configId) return;
        changed = true;
        await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
      },
    });
    const rows = await historyFor(t.configId);
    expect(rows).toHaveLength(2);
    const [old, current] = rows as [Row, Row];
    expect(old.superseded_at).not.toBeNull();
    expect(old.sealed_previous_secret).not.toBeNull();
    expect(current.superseded_at).toBeNull();
    expect(current.access_key_fingerprint).toBe(credentialFingerprint(
      NEW_KEYS.accessKey, normalizeStorageIdentity('s3', WRITE_DESTINATION),
    ));
  });

  it.each(['AccessDenied', 'SignatureDoesNotMatch'])(
    'a key refused with %s is not recorded as disabled: it may still upload (the code is kept)',
    async (code) => {
      if (!process.env.DATABASE_URL) return;
      const t = await seedWriteTenant();
      await baselineCredentialHistory();
      await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
      const [old] = (await historyFor(t.configId)) as [Row];

      // Even a probe that calls it a refusal is not taken as evidence.
      const res = await checkReplacedCredential({
        historyId: old.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: null, probe: refused(code),
      });

      expect(res).toEqual({ status: 'inconclusive', code });
      const after = await historyRow(old.id);
      expect(after).toMatchObject({
        revoked_at: null, revocation_evidence: null, last_probe_outcome: 'inconclusive', last_probe_code: code,
      });
      expect(after.sealed_previous_secret).not.toBeNull();
    },
  );

  runDb('a bucket or endpoint change that keeps the access key id keeps the key listed as used before the change', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, bucket: 'other-bucket' });
    const [old, current] = (await historyFor(t.configId)) as [Row, Row];
    expect(old.superseded_at).not.toBeNull();
    expect(current.superseded_at).toBeNull();
    expect(current.broadcast_until).not.toBeNull();
    expect(new Date(current.broadcast_until as unknown as string).getTime())
      .toBe(new Date(old.broadcast_until as unknown as string).getTime());
    expect(JSON.stringify(current)).not.toContain(WRITE_DESTINATION.accessKey);
  });

  runDb('a key never sent to a device keeps nothing sealed when it is replaced', async () => {
    const t = await seedWriteTenant();
    await inOrg(t.orgId)(() => recordCredentialChange({
      orgId: t.orgId, configId: t.configId, previous: null, next: { provider: 's3', providerConfig: WRITE_DESTINATION },
    }));
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [old, current] = (await historyFor(t.configId)) as [Row, Row];
    expect(old.broadcast_until).toBeNull();
    expect(old.superseded_at).not.toBeNull();
    expect(old.sealed_previous_secret).toBeNull();
    expect(current.broadcast_until).toBeNull();
  });

  runDb('sealed settings that cannot be opened are reported as not checkable, before any admission is taken', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [old] = (await historyFor(t.configId)) as [Row];
    await getTestDb().execute(sql`
      UPDATE backup_storage_credential_history SET sealed_previous_secret = 'enc:v1:not-a-valid-payload' WHERE id = ${old.id}
    `);
    let admitted = 0;
    let probed = 0;
    const res = await checkReplacedCredential({
      historyId: old.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: null,
      admit: async () => { admitted += 1; return { allowed: true }; },
      probe: async () => { probed += 1; return { outcome: 'live', code: null }; },
    });
    expect(res).toEqual({ status: 'not_checkable', reason: 'no_sealed_settings' });
    expect(admitted).toBe(0);
    expect(probed).toBe(0);
  });

  runDb('a check is admitted only for a replaced, checkable key, and a refused admission probes nothing', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    const [current] = (await historyFor(t.configId)) as [Row];
    let admitted = 0;
    await checkReplacedCredential({
      historyId: current.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: null,
      admit: async () => { admitted += 1; return { allowed: true }; }, probe: refused(),
    });
    expect(admitted).toBe(0);

    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [old] = (await historyFor(t.configId)) as [Row];
    let probed = 0;
    const res = await checkReplacedCredential({
      historyId: old.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: null,
      admit: async () => ({ allowed: false, retryAfterSeconds: 42 }),
      probe: async () => { probed += 1; return { outcome: 'live', code: null }; },
    });
    expect(res).toEqual({ status: 'rate_limited', retryAfterSeconds: 42 });
    expect(probed).toBe(0);
  });

  runDb('the old key is tried with no DB context held, and a refusal is recorded in one transaction', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [old] = (await historyFor(t.configId)) as [Row];
    let contexts = 0;
    let heldDuringProbe: boolean | null = null;
    await checkReplacedCredential({
      historyId: old.id, orgId: t.orgId, userId: null,
      inOrg: (fn) => { contexts += 1; return inOrg(t.orgId)(fn); },
      probe: async () => { heldDuringProbe = hasDbAccessContext(); return { outcome: 'denied', code: 'InvalidAccessKeyId' }; },
    });
    expect(heldDuringProbe).toBe(false);
    // One context to read the row, one to record the outcome (row + same-org fan-out together).
    expect(contexts).toBe(2);
  });

  runDb('the cleanup job erases sealed settings of keys replaced more than 30 days ago', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS }, new Date(Date.now() - 31 * 24 * 3600_000));
    const summary = await runBackupWriteSessionJanitor({
      now: () => new Date(),
      storage: { abortMultipart: async () => undefined, listMultipart: async () => [] },
      eraseExpiredSealedSettings: async (now) => eraseExpiredSealedSettings(now),
    });
    expect(summary.erasedSealedSettings).toBeGreaterThanOrEqual(1);
    const [old] = (await historyFor(t.configId)) as [Row];
    expect(old.sealed_previous_secret).toBeNull();
  });

  runDb('the first-start recording pages through every destination', async () => {
    const t = await seedWriteTenant();
    const extra = [randomUUID(), randomUUID()];
    for (const id of extra) {
      await getTestDb().execute(sql`
        INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
        VALUES (${id}, ${t.orgId}, 'More', 'file', 's3', ${JSON.stringify(WRITE_DESTINATION)}::jsonb)
      `);
    }
    await baselineCredentialHistory({ batchSize: 1 });
    for (const id of [t.configId, ...extra]) {
      expect(await historyFor(id)).toHaveLength(1);
    }
  });

  runDb('an operator confirmation is recorded as weaker evidence', async () => {
    const t = await seedWriteTenant();
    const user = await createUser({ partnerId: t.partnerId, orgId: t.orgId });
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const [old] = (await historyFor(t.configId)) as [Row];

    expect(await attestCredentialDisabled({
      historyId: old.id, orgId: t.orgId, inOrg: inOrg(t.orgId), userId: user.id, evidence: 'operator_attested', detail: 'Deleted in the storage console',
    })).toEqual({ status: 'revoked' });
    expect(await historyRow(old.id)).toMatchObject({
      revocation_evidence: 'operator_attested', verified_by_user_id: user.id, sealed_previous_secret: null,
      evidence_detail: 'Deleted in the storage console',
    });
  });

  runDb('sealed settings are erased 30 days after the key was replaced, and not before', async () => {
    const t = await seedWriteTenant();
    const u = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS }, new Date(Date.now() - 31 * 24 * 3600_000));
    await replaceKeys(u, { ...WRITE_DESTINATION, ...NEW_KEYS }, new Date(Date.now() - 29 * 24 * 3600_000));

    await eraseExpiredSealedSettings();

    const [tOld] = (await historyFor(t.configId)) as [Row];
    const [uOld] = (await historyFor(u.configId)) as [Row];
    expect(tOld.sealed_previous_secret).toBeNull();
    expect(tOld.revoked_at).toBeNull();
    expect(uOld.sealed_previous_secret).not.toBeNull();
    const outstanding = await inOrg(t.orgId)(() => listOutstandingCredentials(t.orgId));
    expect(outstanding).toEqual([expect.objectContaining({ id: tOld.id, canCheck: false })]);
  });

  runDb('deleting a destination supersedes its key and keeps the history after the destination is gone', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await inOrg(t.orgId)(() => recordCredentialChange({
      orgId: t.orgId, configId: t.configId, previous: { provider: 's3', providerConfig: WRITE_DESTINATION }, next: null,
    }));
    const [row] = (await historyFor(t.configId)) as [Row];
    await getTestDb().execute(sql`DELETE FROM backup_jobs WHERE config_id = ${t.configId}`);
    await getTestDb().execute(sql`DELETE FROM backup_configs WHERE id = ${t.configId}`);

    const after = await historyRow(row.id);
    expect(after.config_id).toBeNull();
    expect(after.superseded_at).not.toBeNull();
    expect(after.sealed_previous_secret).not.toBeNull();
  });

  runDb('an organization cannot see another\'s history, and a row cannot name another organization\'s destination', async () => {
    const a = await seedWriteTenant();
    const b = await seedWriteTenant();
    await baselineCredentialHistory();

    const visible = (await inOrg(b.orgId)(() => db.execute(sql`
      SELECT id FROM backup_storage_credential_history WHERE org_id = ${a.orgId}
    `))) as unknown as unknown[];
    expect(visible).toEqual([]);
    expect(await inOrg(b.orgId)(() => listOutstandingCredentials(a.orgId))).toEqual([]);

    const code = await expectSqlState(() => inOrg(b.orgId)(() => db.execute(sql`
      INSERT INTO backup_storage_credential_history (org_id, config_id, storage_identity, access_key_fingerprint)
      VALUES (${b.orgId}, ${a.configId}, 'x', ${'0'.repeat(64)})
    `)));
    expect(code).toBe('42501');

    const [aRow] = (await historyFor(a.configId)) as [Row];
    expect(await checkReplacedCredential({ historyId: aRow.id, orgId: b.orgId, inOrg: inOrg(b.orgId), userId: null, probe: refused() }))
      .toEqual({ status: 'not_found' });
  });

  runDb('org erasure removes the history', async () => {
    const t = await seedWriteTenant();
    await baselineCredentialHistory();
    await replaceKeys(t, { ...WRITE_DESTINATION, ...NEW_KEYS });
    const operator = await createUser({ partnerId: t.partnerId });
    await cascadeDeleteOrg(t.orgId, operator.id);
    const rows = (await getTestDb().execute(sql`
      SELECT 1 FROM backup_storage_credential_history WHERE org_id = ${t.orgId}
    `)) as unknown as unknown[];
    expect(rows).toEqual([]);
  });
});
