/**
 * TPM key evidence for a reattach, against real PostgreSQL and Redis (#8318
 * wave T2, spec §12.2 "Decided in wave T2").
 *
 *  - detection by the proven endorsement key: partner-wide, never across
 *    partners, never for a key two other records carry;
 *  - the request computes the level under the row locks: `tpm_continuity`
 *    without the typed name, `evidence_changed` when the requester was shown
 *    more than holds, `hint` when shown less;
 *  - the stage/confirm re-check (revalidateLockedIntent) cancels a
 *    `tpm_continuity` intent whose evidence no longer holds;
 *  - reviewing a held key change: accept, dismiss, the access rule, the
 *    version, an open reattach, the audit row in the same transaction.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/tpmEvidence.integration.test.ts
 */
import './setup';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { auditLogs, deviceHardware } from '../../db/schema';
import { installStartedAt, lockTpmKey, readTpmEvidence } from '../../services/deviceReattach/evidence';
import { lockReattachDevices } from '../../services/deviceReattach/intentStore';
import { requestDeviceReattach } from '../../services/deviceReattach/requestIntent';
import { revalidateLockedIntent } from '../../services/deviceReattach/revalidation';
import { detectAfterKeyBaseline, detectReinstallCandidates } from '../../services/reinstallCandidates';
import { readReinstallCandidatesForViewer } from '../../services/reinstallCandidates/viewer';
import { readTpmBaselineView, reviewTpmKeyMismatch, type TpmMismatchAction } from '../../services/tpmBaseline';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  parkedSource,
  readDevice,
  readIntent,
  seedAgentDevice,
  seedReattachTenant,
  silentTarget,
  targetVersionOf,
  type ReattachTenant,
} from './deviceReattachFixtures';
import { getTestDb } from './setup';

const K1 = '1'.repeat(64);
const K2 = '2'.repeat(64);
const K3 = '3'.repeat(64);
type Place = { orgId: string; siteId: string };

interface KeyState { ek: string; attestedAt?: Date; mismatch?: string | null }

async function setKey(device: { id: string; orgId: string }, key: KeyState): Promise<void> {
  const attestedAt = key.attestedAt ?? new Date();
  const values = {
    tpmEkPubSha256: key.ek,
    tpmAttestedAt: attestedAt,
    tpmAvailable: true,
    tpmEkMismatchSha256: key.mismatch ?? null,
    // Held after the install enrolled (a held key accepted later is this install's proof).
    tpmEkMismatchAt: key.mismatch ? new Date(Date.now() + 2000) : null,
  };
  await getTestDb().insert(deviceHardware).values({ deviceId: device.id, orgId: device.orgId, ...values })
    .onConflictDoUpdate({ target: deviceHardware.deviceId, set: values });
}

/** An older record that proved `ek` a month ago and has been silent for two hours. */
async function oldKeyedTarget(place: Place, ek: string, options: { mismatch?: string } = {}) {
  const device = await silentTarget(place);
  await getTestDb().execute(sql`UPDATE devices SET created_at = now() - interval '30 days' WHERE id = ${device.id}::uuid`);
  await setKey(device, { ek, attestedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), mismatch: options.mismatch });
  return device;
}

/** A new install that has just proven `ek` (after it enrolled). */
async function newKeyedSource(place: Place, ek: string, options: { parked?: boolean; mismatch?: string } = {}) {
  const device = await seedAgentDevice(place, { status: 'pending', rebindProtocolVersion: 1, parked: options.parked });
  await setKey(device, { ek, attestedAt: new Date(Date.now() + 1000), mismatch: options.mismatch });
  return device;
}

async function flagOf(deviceId: string) {
  const row = await readDevice(deviceId);
  return { target: row?.possibleReplacementOfDeviceId ?? null, reason: row?.possibleReplacementReason ?? null };
}

function evidenceOf(tenant: ReattachTenant, sourceId: string, targetId: string) {
  return withSystemDbAccessContext(async () => {
    const source = await readDevice(sourceId);
    return readTpmEvidence(db, {
      partnerId: tenant.partnerId,
      sourceDeviceId: sourceId,
      sourceInstallStartedAt: installStartedAt(source!),
      targetDeviceId: targetId,
    });
  });
}

async function request(tenant: ReattachTenant, sourceId: string, targetId: string, over: Partial<Parameters<typeof requestDeviceReattach>[0]> = {}) {
  const target = await readDevice(targetId);
  return requestDeviceReattach({
    actor: { userId: tenant.admin.id },
    sourceDeviceId: sourceId,
    targetDeviceId: targetId,
    targetVersion: await targetVersionOf(targetId),
    expectedEvidenceLevel: 'tpm_continuity',
    restoreDecommissioned: false,
    confirmTargetName: null,
    stepUp: { kind: 'not_required' },
    ...over,
    ...(over.expectedEvidenceLevel === 'hint' && over.confirmTargetName === undefined ? { confirmTargetName: target?.hostname ?? null } : {}),
  });
}

describe('TPM key evidence (#8318 wave T2)', () => {
  it('is tpm_continuity for the same key across two orgs of the partner, hint once a third record carries it', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgB, K1);
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'tpm_continuity' });

    const clone = await silentTarget(tenant.orgB);
    await setKey(clone, { ek: K1 });
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'hint', gap: 'key_shared' });
  });

  it('a third record holding the key only as an unreviewed key change also makes it shared', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    const clone = await silentTarget(tenant.orgB);
    await setKey(clone, { ek: K3, mismatch: K1 });
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'hint', gap: 'key_shared' });
  });

  it('a key held in ANOTHER partner neither counts as shared nor matches', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const stranger = await silentTarget({ orgId: otherOrg.id, siteId: (await createSite({ orgId: otherOrg.id })).id });
    await setKey(stranger, { ek: K1 });
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'tpm_continuity' });
  });

  it.each<[string, { sourceMismatch?: string; targetMismatch?: string; targetKey?: string }, string]>([
    ['a key change held on the target', { targetMismatch: K2 }, 'target_key_changed'],
    ['a key change held on the source', { sourceMismatch: K2 }, 'source_key_changed'],
    ['different keys', { targetKey: K2 }, 'keys_differ'],
  ])('is hint with %s', async (_name, opts, gap) => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, opts.targetKey ?? K1, { mismatch: opts.targetMismatch });
    const source = await newKeyedSource(tenant.orgA, K1, { mismatch: opts.sourceMismatch });
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'hint', gap });
  });

  it('a source key proven before this install enrolled is not this install\'s proof', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    await setKey(source, { ek: K1, attestedAt: new Date(Date.now() - 60 * 60 * 1000) });
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'hint', gap: 'source_key_not_proven_by_install' });
  });
});

describe('a re-enroll onto the source row (#8318 wave T2 review)', () => {
  it('a key the previous install proved is not this install\'s proof: hint, and a tpm request is evidence_changed', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'tpm_continuity' });
    // What the in-place re-enroll writes (reattachStaleCallers pins the route doing it).
    await getTestDb().execute(sql`UPDATE devices SET install_enrolled_at = now() + interval '1 minute' WHERE id = ${source.id}::uuid`);
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'hint', gap: 'source_key_not_proven_by_install' });
    expect(await request(tenant, source.id, target.id)).toMatchObject({ ok: false, code: 'evidence_changed' });
    expect(await detectAfterKeyBaseline(source.id)).toMatchObject({ written: false });
  });
});

describe('detection by the proven key (#8318 wave T2)', () => {
  it('flags the one record of the partner holding the key, reason tpm, across orgs and from the holding area', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.pool, K1, { parked: true });
    expect(await detectAfterKeyBaseline(source.id)).toMatchObject({ written: true, kind: 'new', targetDeviceId: target.id, reason: 'tpm' });
    expect(await flagOf(source.id)).toEqual({ target: target.id, reason: 'tpm' });
  });

  it('upgrades a hostname flag to tpm when the key is proven later', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await seedAgentDevice(tenant.orgA, { status: 'pending', rebindProtocolVersion: 1, hostname: (await readDevice(target.id))!.hostname });
    expect(await detectReinstallCandidates({ sourceDeviceId: source.id, trigger: 'enroll' })).toMatchObject({ written: true, reason: 'hostname' });
    await setKey(source, { ek: K1, attestedAt: new Date(Date.now() + 1000) });
    expect(await detectAfterKeyBaseline(source.id)).toMatchObject({ written: true, kind: 'upgrade', reason: 'tpm' });
  });

  it('runs no search when no other device carries the key (enabling attestation fleet-wide is not a sweep)', async () => {
    const tenant = await seedReattachTenant();
    await oldKeyedTarget(tenant.orgA, K2);
    const source = await newKeyedSource(tenant.orgA, K1);
    expect(await detectAfterKeyBaseline(source.id)).toEqual({ written: false, why: 'key_not_shared' });
  });

  it('a key two other records carry is no evidence', async () => {
    const tenant = await seedReattachTenant();
    await oldKeyedTarget(tenant.orgA, K1);
    await oldKeyedTarget(tenant.orgB, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    expect(await detectAfterKeyBaseline(source.id)).toMatchObject({ written: false });
    expect(await flagOf(source.id)).toEqual({ target: null, reason: null });
  });

  it('never matches across partners', async () => {
    const tenant = await seedReattachTenant();
    const other = await seedReattachTenant();
    await oldKeyedTarget(other.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    expect(await detectAfterKeyBaseline(source.id)).toEqual({ written: false, why: 'key_not_shared' });
  });

  it('a holder with its own key change held is not flagged on the key', async () => {
    const tenant = await seedReattachTenant();
    await oldKeyedTarget(tenant.orgA, K1, { mismatch: K3 });
    const source = await newKeyedSource(tenant.orgA, K1);
    expect(await detectAfterKeyBaseline(source.id)).toMatchObject({ written: false });
  });

  it('the candidates read reports the level per candidate, and never a key', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    await detectAfterKeyBaseline(source.id);
    const view = await readReinstallCandidatesForViewer({
      sourceDeviceId: source.id,
      viewer: {
        scope: 'partner',
        partnerId: tenant.partnerId,
        partnerOrgAccess: 'all',
        canAccessOrg: () => true,
        allowedSiteIds: undefined,
        canAccessSite: () => true,
        allowedDeviceIds: undefined,
      } as never,
    });
    expect(view?.candidates).toEqual([expect.objectContaining({ deviceId: target.id, evidence: 'tpm_ek', reason: 'tpm', evidenceLevel: 'tpm_continuity' })]);
    expect(view?.candidates[0]).not.toHaveProperty('evidenceGap');
    expect(JSON.stringify(view)).not.toContain(K1);
  });
});

describe('requesting a reattach with TPM evidence (#8318 wave T2)', () => {
  it('records tpm_continuity without the typed name', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    const result = await request(tenant, source.id, target.id);
    expect(result).toMatchObject({ ok: true, intent: { evidenceLevel: 'tpm_continuity' } });
  });

  it('a requester shown tpm_continuity whose pair lost it answers evidence_changed', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1, { mismatch: K2 });
    const source = await newKeyedSource(tenant.orgA, K1);
    expect(await request(tenant, source.id, target.id)).toMatchObject({ ok: false, status: 409, code: 'evidence_changed' });
  });

  it('a requester shown hint proceeds as hint even with TPM evidence', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    expect(await request(tenant, source.id, target.id, { expectedEvidenceLevel: 'hint' })).toMatchObject({ ok: true, intent: { evidenceLevel: 'hint' } });
  });

  it('the stage/confirm re-check cancels with evidence_changed once a key change is held', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    const result = await request(tenant, source.id, target.id);
    if (!result.ok) throw new Error(`request refused: ${result.code}`);
    const recheck = () => withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const intent = (await readIntent(result.intent.id))!;
      const locked = await lockReattachDevices(tx, [source.id, target.id], 'update');
      return revalidateLockedIntent(tx, intent, locked.get(source.id)!, locked.get(target.id)!);
    }));
    expect(await recheck()).toBeNull();
    await setKey(target, { ek: K1, mismatch: K3 });
    expect(await recheck()).toBe('evidence_changed');
  });
});

describe('reviewing a held key change (#8318 wave T2)', () => {
  async function held(tenant: ReattachTenant, place: Place = tenant.orgA, parked = false) {
    const device = parked
      ? await parkedSource(tenant)
      : await seedAgentDevice(place, { status: 'online' });
    await setKey(device, { ek: K1, mismatch: K2 });
    const view = await withSystemDbAccessContext(() => readTpmBaselineView(device.id));
    return { device, version: view.mismatch!.version };
  }

  function review(userId: string, deviceId: string, action: TpmMismatchAction, version: string) {
    return reviewTpmKeyMismatch({
      actor: { userId },
      deviceId,
      action,
      version,
      canAccessSite: () => true,
      stepUp: { kind: 'not_required' },
      audit: (auditAction, orgId) => ({ orgId, action: auditAction, resourceType: 'device', resourceId: deviceId, actorType: 'user', actorId: userId, result: 'success', details: {} }),
    });
  }

  async function keyRow(deviceId: string) {
    const [row] = await getTestDb().select().from(deviceHardware).where(eq(deviceHardware.deviceId, deviceId));
    return row!;
  }

  async function audits(deviceId: string) {
    return getTestDb().select({ action: auditLogs.action, details: auditLogs.details }).from(auditLogs)
      .where(and(eq(auditLogs.resourceId, deviceId), sql`${auditLogs.action} LIKE 'device.tpm_baseline.mismatch_%'`));
  }

  it('accept makes the held key the baseline, as of when it was proven, audited with no hash', async () => {
    const tenant = await seedReattachTenant();
    const { device, version } = await held(tenant);
    const heldAt = (await keyRow(device.id)).tpmEkMismatchAt!;
    expect(await review(tenant.admin.id, device.id, 'accept', version)).toMatchObject({ ok: true, action: 'accept' });
    expect(await keyRow(device.id)).toMatchObject({ tpmEkPubSha256: K2, tpmAttestedAt: heldAt, tpmEkMismatchSha256: null, tpmEkMismatchAt: null });
    const rows = await audits(device.id);
    expect(rows.map((r) => r.action)).toEqual(['device.tpm_baseline.mismatch_accepted']);
    expect(JSON.stringify(rows)).not.toContain(K2);
  });

  it('dismiss keeps the baseline and clears the hold', async () => {
    const tenant = await seedReattachTenant();
    const { device, version } = await held(tenant);
    expect(await review(tenant.admin.id, device.id, 'dismiss', version)).toMatchObject({ ok: true });
    expect(await keyRow(device.id)).toMatchObject({ tpmEkPubSha256: K1, tpmEkMismatchSha256: null });
    expect((await audits(device.id)).map((r) => r.action)).toEqual(['device.tpm_baseline.mismatch_dismissed']);
  });

  it('a version for another hold, or a second decision, is mismatch_changed and writes nothing', async () => {
    const tenant = await seedReattachTenant();
    const { device, version } = await held(tenant);
    await setKey(device, { ek: K1, mismatch: K3 });
    expect(await review(tenant.admin.id, device.id, 'accept', version)).toMatchObject({ ok: false, status: 409, code: 'mismatch_changed' });
    expect(await keyRow(device.id)).toMatchObject({ tpmEkPubSha256: K1, tpmEkMismatchSha256: K3 });

    const fresh = (await withSystemDbAccessContext(() => readTpmBaselineView(device.id))).mismatch!.version;
    expect((await review(tenant.admin.id, device.id, 'dismiss', fresh)).ok).toBe(true);
    expect(await review(tenant.admin.id, device.id, 'dismiss', fresh)).toMatchObject({ code: 'mismatch_changed' });
    expect(await audits(device.id)).toHaveLength(1);
  });

  it('a technician reviews in their org; outside it the device is not found; a parked one needs a full admin', async () => {
    const tenant = await seedReattachTenant();
    const inA = await held(tenant, tenant.orgA);
    const inB = await held(tenant, tenant.orgB);
    const parked = await held(tenant, tenant.pool, true);
    expect((await review(tenant.techA.id, inA.device.id, 'dismiss', inA.version)).ok).toBe(true);
    expect(await review(tenant.techA.id, inB.device.id, 'dismiss', inB.version)).toMatchObject({ status: 404, code: 'device_not_found' });
    // A parked device is a 404 to a technician: not even its existence leaks.
    expect(await review(tenant.techA.id, parked.device.id, 'dismiss', parked.version)).toMatchObject({ status: 404, code: 'device_not_found' });
    expect((await review(tenant.admin.id, parked.device.id, 'accept', parked.version)).ok).toBe(true);
  });

  it('an out-of-reach id is not found without its row being locked', async () => {
    const tenant = await seedReattachTenant();
    const other = await seedReattachTenant();
    const inB = await held(tenant, tenant.orgB);
    const elsewhere = await held(other, other.orgA);

    // Another transaction holds both rows FOR UPDATE. A review that locked
    // before judging reach would wait on it; one that judges first answers.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const holding = new Promise<void>((resolve) => { ready = resolve; });
    const holder = getTestDb().transaction(async (tx: any) => {
      await tx.execute(sql`SELECT id FROM devices WHERE id IN (${inB.device.id}, ${elsewhere.device.id}) FOR UPDATE`);
      ready();
      await released;
    });
    await Promise.race([holding, holder]);
    try {
      const timeout = <T>(p: Promise<T>) => Promise.race([
        p,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the review waited on the row lock')), 5_000)),
      ]);
      expect(await timeout(review(tenant.techA.id, inB.device.id, 'dismiss', inB.version)))
        .toMatchObject({ status: 404, code: 'device_not_found' });
      expect(await timeout(review(tenant.admin.id, elsewhere.device.id, 'dismiss', elsewhere.version)))
        .toMatchObject({ status: 404, code: 'device_not_found' });
    } finally {
      release();
      await holder;
    }
    expect(await keyRow(inB.device.id)).toMatchObject({ tpmEkMismatchSha256: K2 });
  });

  it('refuses while the device is in an open reattach', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    expect((await request(tenant, source.id, target.id)).ok).toBe(true);
    await setKey(target, { ek: K1, mismatch: K2 });
    const version = (await withSystemDbAccessContext(() => readTpmBaselineView(target.id))).mismatch!.version;
    expect(await review(tenant.admin.id, target.id, 'accept', version)).toMatchObject({ status: 409, code: 'reattach_in_progress' });
  });

  it('an accepted key that another record carries runs the search for it', async () => {
    const tenant = await seedReattachTenant();
    const old = await oldKeyedTarget(tenant.orgA, K2);
    const source = await newKeyedSource(tenant.orgA, K1, { mismatch: K2 });
    const version = (await withSystemDbAccessContext(() => readTpmBaselineView(source.id))).mismatch!.version;
    expect((await review(tenant.admin.id, source.id, 'accept', version)).ok).toBe(true);
    expect(await detectAfterKeyBaseline(source.id)).toMatchObject({ written: true, targetDeviceId: old.id, reason: 'tpm' });
  });
});

describe('the holder count and a new holder of the key serialize (#8318 wave T2 review)', () => {
  it('accepting a key on a third device waits for a transaction holding that key\'s lock, then counts as shared', async () => {
    const tenant = await seedReattachTenant();
    const target = await oldKeyedTarget(tenant.orgA, K1);
    const source = await newKeyedSource(tenant.orgA, K1);
    const third = await seedAgentDevice(tenant.orgB, { status: 'online' });
    await setKey(third, { ek: K3, mismatch: K1 });
    const version = (await withSystemDbAccessContext(() => readTpmBaselineView(third.id))).mismatch!.version;

    // A counting transaction (as the request or confirm) holds K1's lock.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let holderPid!: number;
    let ready!: () => void;
    const holding = new Promise<void>((resolve) => { ready = resolve; });
    const holder = getTestDb().transaction(async (tx: any) => {
      const [row] = (await tx.execute(sql`SELECT pg_backend_pid()::int AS pid`)) as unknown as Array<{ pid: number }>;
      holderPid = row!.pid;
      await lockTpmKey(tx, K1);
      ready();
      await released;
    });
    await Promise.race([holding, holder]);
    const accepting = reviewTpmKeyMismatch({
      actor: { userId: tenant.admin.id },
      deviceId: third.id,
      action: 'accept',
      version,
      canAccessSite: () => true,
      stepUp: { kind: 'not_required' },
      audit: (action, orgId) => ({ orgId, action, resourceType: 'device', resourceId: third.id, actorType: 'user', actorId: tenant.admin.id, result: 'success', details: {} }),
    });
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const rows = (await getTestDb().execute(
          sql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND ${holderPid} = ANY(pg_blocking_pids(pid))`,
        )) as unknown as unknown[];
        if (rows.length > 0) break;
        if (Date.now() > deadline) throw new Error('the accept never waited on the key lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      release();
      await Promise.allSettled([holder, accepting]);
    }
    expect((await accepting).ok).toBe(true);
    expect(await evidenceOf(tenant, source.id, target.id)).toEqual({ level: 'hint', gap: 'key_shared' });
  });
});
