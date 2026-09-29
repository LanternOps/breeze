/**
 * Holding-area controls against real Postgres + Redis.
 *
 * Proven here:
 *   - parked devices never consume licensed partner capacity or bill, and
 *     two concurrent assignments racing for the last licensed slot admit
 *     exactly one;
 *   plus the parked cap under concurrency, the expiry/assignment race, the
 *   purge, and the incident actions.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/parkedControls.integration.test.ts
 */
import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createIntegrationTestClient, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { Hono } from 'hono';
import { statsRoutes } from '../../routes/devices/stats';
import { unifiRoutes } from '../../routes/unifi';
import { insertDevice, parkedDeviceValues, seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';
import { admitParkedEnrollment, ParkedCapReachedError } from '../../services/unassignedPool/admission';
import { PARKED_DEVICES_PER_PARTNER_MAX } from '../../services/unassignedPool/limits';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devicePoolAssignmentEvents, devices, partners, refreshTokenFamilies, unifiIntegrations, unifiSiteMappings, users } from '../../db/schema';
import { mintStepUpGrant, preAssignmentEnableResourceDigest, type StepUpGrantBinding } from '../../services/mfaStepUpGrant';
import { expireParkedDevice } from '../../services/unassignedPool/parkedExpiry';
import { expireDevicesParkedByDeployKey, setDeployKeyEnrollmentSwitch } from '../../services/unassignedPool/incidentActions';
import { isDeployKeyEnrollmentEnabled } from '../../services/unassignedPool/switches';
import { resolveAuditOrgIdForPartner } from '../../services/auditOrgResolver';
import { resolveDefaultOrgId } from '../../routes/mcpServer';
import { createAccessToken } from '../../services/jwt';
import { isHoldingOrg } from '../../services/unassignedPool/protectedOrg';
import { organizations } from '../../db/schema';
import { runParkedDeviceExpiryOnce } from '../../jobs/parkedDeviceExpiry';
import { runParkedDevicePurgeOnce } from '../../jobs/parkedDevicePurge';
import { isDeviceUninstallDraining } from '../../services/deviceUninstallDrain';
import { PARKED_DEVICE_TTL_DAYS, PARKED_PURGE_AFTER_EXPIRY_DAYS } from '../../services/unassignedPool/limits';
import { admitPartnerDeviceCapacity } from '../../services/partnerDeviceCapacity';
import { countContractDevices, snapshotContractDevices } from '../../services/contractQuantities';
import {
  assignParkedDevice,
  type ParkedAssignmentActor,
} from '../../services/unassignedPool/assignParkedDevice';

const request = { req: { header: () => undefined } };

let partnerId: string;
let pool: { orgId: string; siteId: string };
let customerOrgId: string;
let customerSiteId: string;
let actor: ParkedAssignmentActor;

beforeEach(async () => {
  const partner = await createPartner({ status: 'active' });
  partnerId = partner.id;
  pool = await seedHoldingOrg(partnerId);
  const org = await createOrganization({ partnerId, status: 'active' });
  const site = await createSite({ orgId: org.id });
  customerOrgId = org.id;
  customerSiteId = site.id;
  const user = await createUser({ partnerId, email: `controls-${randomUUID()}@example.com` });
  actor = {
    partnerId,
    allowedSiteIds: undefined,
    auth: {
      scope: 'partner',
      partnerId,
      partnerOrgAccess: 'all',
      user: { id: user.id, email: user.email, name: 'Admin' },
      token: { aep: user.authEpoch, mep: user.mfaEpoch, sid: randomUUID() },
    } as any,
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until some backend is blocked on a lock while running `queryPrefix`. */
async function waitForBlocked(queryPrefix: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await getTestDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE ${`${queryPrefix}%`}`) as unknown as Array<{ n: number }>;
    if (Number(row?.n ?? 0) > 0) return;
    await sleep(25);
  }
  const waiting = await getTestDb().execute(sql`SELECT wait_event_type, wait_event, state, left(query, 120) AS q FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle'`);
  throw new Error(`no statement starting with ${queryPrefix} became blocked on a lock: ${JSON.stringify(waiting)}`);
}

async function assignedLedgerRows(deviceIds: string[]) {
  const rows = await getTestDb().select().from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.eventType, 'assigned'));
  return rows.filter((r: { deviceId: string }) => deviceIds.includes(r.deviceId));
}

describe('billing and licensed capacity leave parked devices out', () => {
  it('a new customer enrollment is admitted while parked devices fill what would otherwise be the cap', async () => {
    await getTestDb().update(partners).set({ maxDevices: 2 }).where(eq(partners.id, partnerId));
    await insertDevice(customerOrgId, customerSiteId);
    for (let i = 0; i < 3; i += 1) await seedParkedDevice(pool.orgId, pool.siteId);

    const admission = await withSystemDbAccessContext(() => db.transaction((tx) =>
      admitPartnerDeviceCapacity(tx, { orgId: customerOrgId, expectedPartnerId: partnerId })));
    expect(admission).toEqual({ allowed: true, partnerId, maxDevices: 2, activeCount: 1 });
  });

  it('parked devices are never billable', async () => {
    await seedParkedDevice(pool.orgId, pool.siteId);
    await seedParkedDevice(pool.orgId, pool.siteId);
    const customer = await insertDevice(customerOrgId, customerSiteId);
    await withSystemDbAccessContext(async () => {
      expect(await countContractDevices(pool.orgId, null)).toBe(0);
      expect(await snapshotContractDevices(pool.orgId)).toEqual([]);
      expect((await snapshotContractDevices(customerOrgId)).map((d) => d.id)).toEqual([customer!.id]);
    });
  });

  it('two concurrent assignments racing for the last licensed slot admit exactly one', async () => {
    await getTestDb().update(partners).set({ maxDevices: 2 }).where(eq(partners.id, partnerId));
    await insertDevice(customerOrgId, customerSiteId);
    const a = await seedParkedDevice(pool.orgId, pool.siteId);
    const b = await seedParkedDevice(pool.orgId, pool.siteId);
    await seedParkedDevice(pool.orgId, pool.siteId);

    const results = await Promise.all([a, b].map((d) => assignParkedDevice({
      actor,
      item: { deviceId: d.id, targetOrgId: customerOrgId, targetSiteId: customerSiteId },
      stepUp: null,
      audit: request,
    })));
    const codes = results.map((r) => (r.ok ? 'ok' : r.code)).sort();
    expect(codes).toEqual(['PARTNER_DEVICE_LIMIT_REACHED', 'ok']);
    expect(await assignedLedgerRows([a.id, b.id])).toHaveLength(1);
    const inCustomer = await getTestDb().select({ id: devices.id }).from(devices)
      .where(and(eq(devices.orgId, customerOrgId)));
    expect(inCustomer).toHaveLength(2);
  });

  it('an enrollment holding the partner row lock for the last slot makes a concurrent assignment refuse at its locked admission', async () => {
    // The assignment's unlocked preview still sees a free slot; its locked
    // admission (after the move) waits for the enrollment, then counts it.
    await getTestDb().update(partners).set({ maxDevices: 2 }).where(eq(partners.id, partnerId));
    await insertDevice(customerOrgId, customerSiteId);
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    // Capacity is partner-wide: the enrollment lands in a DIFFERENT customer
    // org, so the only thing the two transactions share is the partner row.
    const otherOrg = await createOrganization({ partnerId, status: 'active' });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const admitted = deferred();
    const release = deferred();
    const enrollment = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      const admission = await admitPartnerDeviceCapacity(tx, { orgId: otherOrg.id, expectedPartnerId: partnerId });
      expect(admission.allowed).toBe(true);
      await tx.insert(devices).values({
        orgId: otherOrg.id, siteId: otherSite.id, agentId: `enrolled-${randomUUID()}`.slice(0, 64),
        hostname: 'enrolled-now', osType: 'linux', osVersion: 'test', architecture: 'x64', agentVersion: 'test',
      });
      admitted.resolve();
      await release.promise;
    }));
    await admitted.promise;

    const assignment = assignParkedDevice({
      actor,
      item: { deviceId: parked.id, targetOrgId: customerOrgId, targetSiteId: customerSiteId },
      stepUp: null,
      audit: request,
    });
    await waitForBlocked('select "max_devices" from "partners"');
    release.resolve();
    await enrollment;

    expect(await assignment).toMatchObject({ ok: false, code: 'PARTNER_DEVICE_LIMIT_REACHED' });
    const [row] = await getTestDb().select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, parked.id));
    expect(row!.orgId).toBe(pool.orgId);
    expect(await assignedLedgerRows([parked.id])).toHaveLength(0);
  });
});

describe('assignment under a held partner row lock', () => {
  it('a partner row held past the lock timeout answers ASSIGNMENT_BUSY and writes nothing', async () => {
    await getTestDb().update(partners).set({ maxDevices: 10 }).where(eq(partners.id, partnerId));
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    const held = deferred();
    const release = deferred();
    const holder = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM partners WHERE id = ${partnerId} FOR UPDATE`);
      held.resolve();
      await release.promise;
    }));
    await held.promise;
    const result = await assignParkedDevice({
      actor,
      item: { deviceId: parked.id, targetOrgId: customerOrgId, targetSiteId: customerSiteId },
      stepUp: null,
      audit: request,
    });
    release.resolve();
    await holder;
    expect(result).toMatchObject({ ok: false, code: 'ASSIGNMENT_BUSY' });
    const [row] = await getTestDb().select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, parked.id));
    expect(row!.orgId).toBe(pool.orgId);
    expect(await assignedLedgerRows([parked.id])).toHaveLength(0);
  }, 20_000);
});

describe('parked cap — counted under the holding-area lock', () => {
  it(`concurrent admissions leave exactly ${PARKED_DEVICES_PER_PARTNER_MAX} parked devices; the rest are refused`, async () => {
    const attempts = PARKED_DEVICES_PER_PARTNER_MAX + 5;
    const outcomes = await Promise.allSettled(Array.from({ length: attempts }, () =>
      withSystemDbAccessContext(() => db.transaction(async (tx) => {
        await admitParkedEnrollment(tx, { partnerId, holdingOrgId: pool.orgId });
        await tx.insert(devices).values(parkedDeviceValues(pool.orgId, pool.siteId));
      }))));
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(PARKED_DEVICES_PER_PARTNER_MAX);
    expect(refused).toHaveLength(5);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ParkedCapReachedError);
    const parked = await getTestDb().select({ id: devices.id }).from(devices).where(eq(devices.orgId, pool.orgId));
    expect(parked).toHaveLength(PARKED_DEVICES_PER_PARTNER_MAX);

    // The next one is refused too; a decommissioned device frees its slot.
    await expect(withSystemDbAccessContext(() => db.transaction((tx) =>
      admitParkedEnrollment(tx, { partnerId, holdingOrgId: pool.orgId })))).rejects.toBeInstanceOf(ParkedCapReachedError);
    await getTestDb().update(devices).set({ status: 'decommissioned' }).where(eq(devices.id, parked[0]!.id));
    await expect(withSystemDbAccessContext(() => db.transaction((tx) =>
      admitParkedEnrollment(tx, { partnerId, holdingOrgId: pool.orgId })))).resolves.toEqual({ parkedCount: PARKED_DEVICES_PER_PARTNER_MAX - 1 });
  });

  it("refuses another partner's holding org", async () => {
    const other = await createPartner({ status: 'active' });
    const otherPool = await seedHoldingOrg(other.id);
    await expect(withSystemDbAccessContext(() => db.transaction((tx) =>
      admitParkedEnrollment(tx, { partnerId, holdingOrgId: otherPool.orgId })))).rejects.toThrow('not this partner');
  });
});

const DAY_MS = 86_400_000;

async function ledgerRows(deviceId: string, eventType: string) {
  return getTestDb().select().from(devicePoolAssignmentEvents).where(and(
    eq(devicePoolAssignmentEvents.deviceId, deviceId),
    eq(devicePoolAssignmentEvents.eventType, eventType as any),
  ));
}

async function deviceRow(id: string) {
  const [row] = await getTestDb().select().from(devices).where(eq(devices.id, id)).limit(1);
  return row;
}

async function draining(id: string): Promise<boolean> {
  return withSystemDbAccessContext(() => isDeviceUninstallDraining(id));
}

async function ageParkedDevice(id: string, days: number) {
  await getTestDb().update(devices).set({ createdAt: new Date(Date.now() - days * DAY_MS) }).where(eq(devices.id, id));
}

describe('parked-device expiry', () => {
  it('expires devices parked past the window: removed, uninstall queued, one expired ledger row', async () => {
    const old = await seedParkedDevice(pool.orgId, pool.siteId);
    const fresh = await seedParkedDevice(pool.orgId, pool.siteId);
    await ageParkedDevice(old.id, PARKED_DEVICE_TTL_DAYS + 1);

    const summary = await runParkedDeviceExpiryOnce();
    expect(summary).toMatchObject({ expired: 1, failed: 0 });

    const expired = await deviceRow(old.id);
    expect(expired!.status).toBe('decommissioned');
    expect(expired!.decommissionedAt).toBeInstanceOf(Date);
    expect(await draining(old.id)).toBe(true);
    const [uninstall] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, old.id));
    expect(uninstall).toMatchObject({ type: 'self_uninstall', status: 'pending' });
    const rows = await ledgerRows(old.id, 'expired');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ partnerId, fromOrgId: pool.orgId, toOrgId: null, deviceAgentId: old.agentId });
    expect(rows[0]!.parkedDurationSeconds).toBeGreaterThanOrEqual((PARKED_DEVICE_TTL_DAYS + 1) * 86_400 - 60);

    expect((await deviceRow(fresh.id))!.status).not.toBe('decommissioned');
    expect(await ledgerRows(fresh.id, 'expired')).toHaveLength(0);

    // Idempotent: a second run finds nothing.
    expect(await runParkedDeviceExpiryOnce()).toMatchObject({ expired: 0 });
    expect(await ledgerRows(old.id, 'expired')).toHaveLength(1);
  });

  it('expiry cancels pending ordinary commands the same way Remove does, and keeps the uninstall', async () => {
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    const [pending] = await getTestDb().insert(deviceCommands).values({
      deviceId: parked.id, type: 'script', payload: { executionId: randomUUID() }, status: 'pending', targetRole: 'agent',
    }).returning({ id: deviceCommands.id });
    expect(await expireParkedDevice({ partnerId, deviceId: parked.id, actorUserId: null, reason: 'parking_window' }))
      .toMatchObject({ expired: true });
    const [cancelled] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, pending!.id));
    expect(cancelled).toMatchObject({ status: 'cancelled', result: expect.objectContaining({ reason: 'device_decommissioned' }) });
    const uninstall = (await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, parked.id)))
      .filter((r: { type: string }) => r.type === 'self_uninstall');
    expect(uninstall).toHaveLength(1);
    expect(uninstall[0]).toMatchObject({ status: 'pending' });
  });

  it('never expires a device outside a holding org, even an old one', async () => {
    const customer = await insertDevice(customerOrgId, customerSiteId);
    await getTestDb().update(devices).set({ createdAt: new Date(Date.now() - 60 * DAY_MS) }).where(eq(devices.id, customer!.id));
    await runParkedDeviceExpiryOnce();
    expect((await deviceRow(customer!.id))!.status).not.toBe('decommissioned');
    expect(await draining(customer!.id)).toBe(false);
  });

  it('under the lock, a device no longer due (window re-checked) is left alone', async () => {
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    const outcome = await expireParkedDevice({
      partnerId, deviceId: parked.id, actorUserId: null, reason: 'parking_window',
      // A stale cutoff older than the device: the re-check refuses.
      cutoff: new Date(Date.now() - DAY_MS),
    });
    expect(outcome).toMatchObject({ expired: false, reason: 'NOT_DUE' });
    expect((await deviceRow(parked.id))!.status).not.toBe('decommissioned');
  });
});

describe('expiry and assignment of the same device — exactly one wins', () => {
  const assign = (deviceId: string, hooks?: { afterDeviceLock?: () => Promise<void> }) => assignParkedDevice(
    { actor, item: { deviceId, targetOrgId: customerOrgId, targetSiteId: customerSiteId }, stepUp: null, audit: request },
    { hooks },
  );
  const expire = (deviceId: string, hooks?: { afterDeviceLock?: () => Promise<void> }) => expireParkedDevice(
    { partnerId, deviceId, actorUserId: null, reason: 'deploy_key_incident' },
    { hooks },
  );

  it('assignment holding the device first: expiry then skips it — no expired row, not draining', async () => {
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    const locked = deferred();
    const release = deferred();
    const assignment = assign(parked.id, { afterDeviceLock: async () => { locked.resolve(); await release.promise; } });
    await locked.promise;
    const expiry = expire(parked.id);
    await waitForBlocked('SELECT pg_advisory_xact_lock');
    release.resolve();

    expect(await assignment).toMatchObject({ ok: true });
    expect(await expiry).toMatchObject({ expired: false, reason: 'NOT_PARKED' });
    const row = await deviceRow(parked.id);
    expect(row!.orgId).toBe(customerOrgId);
    expect(row!.status).not.toBe('decommissioned');
    expect(await draining(parked.id)).toBe(false);
    expect(await ledgerRows(parked.id, 'expired')).toHaveLength(0);
    expect(await ledgerRows(parked.id, 'assigned')).toHaveLength(1);
  });

  it('expiry holding the device first: assignment then refuses with the device-state error', async () => {
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    const locked = deferred();
    const release = deferred();
    const expiry = expire(parked.id, { afterDeviceLock: async () => { locked.resolve(); await release.promise; } });
    await locked.promise;
    const assignment = assign(parked.id);
    await waitForBlocked('SELECT pg_advisory_xact_lock');
    release.resolve();

    expect(await expiry).toMatchObject({ expired: true });
    expect(await assignment).toMatchObject({ ok: false, code: 'DEVICE_NOT_ASSIGNABLE' });
    const row = await deviceRow(parked.id);
    expect(row!.orgId).toBe(pool.orgId);
    expect(row!.status).toBe('decommissioned');
    expect(await ledgerRows(parked.id, 'assigned')).toHaveLength(0);
    expect(await ledgerRows(parked.id, 'expired')).toHaveLength(1);
  });

  it('started together, repeatedly: never both, never neither', async () => {
    for (let i = 0; i < 8; i += 1) {
      const parked = await seedParkedDevice(pool.orgId, pool.siteId);
      const [assigned, expired] = await Promise.all([assign(parked.id), expire(parked.id)]);
      expect([assigned.ok, expired.expired].filter(Boolean)).toHaveLength(1);
      const assignedRows = await ledgerRows(parked.id, 'assigned');
      const expiredRows = await ledgerRows(parked.id, 'expired');
      expect(assignedRows.length + expiredRows.length).toBe(1);
      const row = await deviceRow(parked.id);
      if (assigned.ok) {
        expect(row!.orgId).toBe(customerOrgId);
        expect(await draining(parked.id)).toBe(false);
      } else {
        expect(assigned).toMatchObject({ code: 'DEVICE_NOT_ASSIGNABLE' });
        expect(row!.status).toBe('decommissioned');
      }
    }
  });
});

describe('parked-device purge', () => {
  async function expireAndAge(days: number) {
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    expect(await expireParkedDevice({ partnerId, deviceId: parked.id, actorUserId: null, reason: 'parking_window' }))
      .toMatchObject({ expired: true });
    const when = new Date(Date.now() - days * DAY_MS);
    await getTestDb().update(devices).set({ decommissionedAt: when }).where(eq(devices.id, parked.id));
    // The agent collected (or never collected) its uninstall long ago.
    await getTestDb().update(deviceCommands).set({ deviceRemoveExpiresAt: when }).where(eq(deviceCommands.deviceId, parked.id));
    return parked;
  }

  it('hard-deletes holding-org devices expired longer than the purge window, with a purged ledger row', async () => {
    const due = await expireAndAge(PARKED_PURGE_AFTER_EXPIRY_DAYS + 1);
    const recent = await expireAndAge(PARKED_PURGE_AFTER_EXPIRY_DAYS - 5);

    const summary = await runParkedDevicePurgeOnce();
    expect(summary).toMatchObject({ purged: 1, failed: 0 });
    expect(await deviceRow(due.id)).toBeUndefined();
    const purged = await ledgerRows(due.id, 'purged');
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({ partnerId, fromOrgId: pool.orgId, toOrgId: null });
    // The earlier ledger rows outlive the device row.
    expect(await ledgerRows(due.id, 'expired')).toHaveLength(1);

    expect(await deviceRow(recent.id)).toBeDefined();
    expect(await ledgerRows(recent.id, 'purged')).toHaveLength(0);
  });

  it('leaves a device whose uninstall is still collectable', async () => {
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    await expireParkedDevice({ partnerId, deviceId: parked.id, actorUserId: null, reason: 'parking_window' });
    await getTestDb().update(devices)
      .set({ decommissionedAt: new Date(Date.now() - (PARKED_PURGE_AFTER_EXPIRY_DAYS + 1) * DAY_MS) })
      .where(eq(devices.id, parked.id));
    const summary = await runParkedDevicePurgeOnce();
    expect(summary).toMatchObject({ purged: 0, skippedUninstallPending: 1 });
    expect(await deviceRow(parked.id)).toBeDefined();
  });
});

describe('incident actions', () => {
  it('the partner switch defaults off, persists, and only takes effect with the platform flag on', async () => {
    const original = process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED;
    try {
      process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
      expect(await isDeployKeyEnrollmentEnabled(partnerId)).toBe(false);
      expect(await setDeployKeyEnrollmentSwitch({ partnerId, enabled: true, stepUp: null })).toEqual({ previous: false, enabled: true });
      expect(await isDeployKeyEnrollmentEnabled(partnerId)).toBe(true);
      process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'false';
      expect(await isDeployKeyEnrollmentEnabled(partnerId)).toBe(false);
      process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
      expect(await setDeployKeyEnrollmentSwitch({ partnerId, enabled: false, stepUp: null })).toEqual({ previous: true, enabled: false });
      expect(await isDeployKeyEnrollmentEnabled(partnerId)).toBe(false);
      expect(await setDeployKeyEnrollmentSwitch({ partnerId: randomUUID(), enabled: true, stepUp: null })).toBeNull();
    } finally {
      if (original === undefined) delete process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED;
      else process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = original;
    }
  });

  it('turning the switch ON consumes a real step-up grant in its transaction: single use, and a revoked session refuses', async () => {
    const familyId = randomUUID();
    await getTestDb().insert(refreshTokenFamilies).values({
      familyId, userId: actor.auth.user.id, absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    });
    const auth = { ...actor.auth, token: { ...actor.auth.token, sid: familyId } } as any;
    const binding: StepUpGrantBinding = {
      userId: auth.user.id, operation: 'pre_assignment_enable', authEpoch: auth.token.aep, mfaEpoch: auth.token.mep,
      sid: familyId, resourceDigest: preAssignmentEnableResourceDigest({ partnerId }),
    };
    const grantId = (await mintStepUpGrant(binding))!;
    expect(await setDeployKeyEnrollmentSwitch({ partnerId, enabled: true, stepUp: { grantId, binding, auth } }))
      .toEqual({ previous: false, enabled: true });
    await setDeployKeyEnrollmentSwitch({ partnerId, enabled: false, stepUp: null });
    // Replay of the spent grant: refused, nothing written.
    expect(await setDeployKeyEnrollmentSwitch({ partnerId, enabled: true, stepUp: { grantId, binding, auth } }))
      .toBe('STEP_UP_REQUIRED');
    const [row] = await getTestDb().select({ on: partners.deployKeyEnrollmentEnabled }).from(partners).where(eq(partners.id, partnerId));
    expect(row!.on).toBe(false);
    // A fresh grant from a session that was since revoked: refused.
    const fresh = (await mintStepUpGrant(binding))!;
    await getTestDb().update(refreshTokenFamilies).set({ revokedAt: new Date(), revokedReason: 'logout' })
      .where(eq(refreshTokenFamilies.familyId, familyId));
    expect(await setDeployKeyEnrollmentSwitch({ partnerId, enabled: true, stepUp: { grantId: fresh, binding, auth } }))
      .toBe('STEP_UP_REQUIRED');
  });

  it("expires exactly the still-parked devices one deploy key parked, for this partner only", async () => {
    const keyId = randomUUID();
    const otherKeyId = randomUUID();
    const enrolled = async (device: { id: string; agentId: string }, deployKeyId: string, forPartner = partnerId, toOrgId = pool.orgId) => {
      await getTestDb().insert(devicePoolAssignmentEvents).values({
        partnerId: forPartner, deviceId: device.id, deviceAgentId: device.agentId, eventType: 'enrolled',
        toOrgId, deployKeyId, deployKeyName: 'Front desk', parkedAt: new Date(),
      });
    };
    const a = await seedParkedDevice(pool.orgId, pool.siteId);
    const b = await seedParkedDevice(pool.orgId, pool.siteId);
    const assigned = await seedParkedDevice(pool.orgId, pool.siteId);
    const otherKey = await seedParkedDevice(pool.orgId, pool.siteId);
    for (const d of [a, b, assigned]) await enrolled(d, keyId);
    await enrolled(otherKey, otherKeyId);
    expect(await assignParkedDevice({ actor, item: { deviceId: assigned.id, targetOrgId: customerOrgId, targetSiteId: customerSiteId }, stepUp: null, audit: request }))
      .toMatchObject({ ok: true });

    // Another partner naming the same key id reaches nothing of ours.
    const stranger = await createPartner({ status: 'active' });
    expect(await expireDevicesParkedByDeployKey({ partnerId: stranger.id, deployKeyId: keyId, actorUserId: actor.auth.user.id }))
      .toEqual({ matched: 0, expired: 0, skipped: 0, failed: 0 });

    const result = await expireDevicesParkedByDeployKey({ partnerId, deployKeyId: keyId, actorUserId: actor.auth.user.id });
    expect(result).toEqual({ matched: 3, expired: 2, skipped: 1, failed: 0 });
    for (const d of [a, b]) {
      expect((await deviceRow(d.id))!.status).toBe('decommissioned');
      const [row] = await ledgerRows(d.id, 'expired');
      expect(row).toMatchObject({ deployKeyId: keyId, fromOrgId: pool.orgId });
    }
    expect((await deviceRow(assigned.id))!.orgId).toBe(customerOrgId);
    expect((await deviceRow(assigned.id))!.status).not.toBe('decommissioned');
    expect((await deviceRow(otherKey.id))!.status).not.toBe('decommissioned');

    // Repeating it changes nothing.
    expect(await expireDevicesParkedByDeployKey({ partnerId, deployKeyId: keyId, actorUserId: actor.auth.user.id }))
      .toEqual({ matched: 3, expired: 0, skipped: 3, failed: 0 });
  });
});

describe('default and fallback org resolution never picks a hidden org', () => {
  it('the MCP default org and the audit fallback org skip an older holding org and Quick Support org', async () => {
    const longAgo = new Date(Date.now() - 30 * DAY_MS);
    const qs = await createOrganization({ partnerId, name: 'Quick Support', slug: `qs-${partnerId}`, type: 'quick_support' });
    await getTestDb().update(organizations).set({ createdAt: longAgo }).where(eq(organizations.id, pool.orgId));
    await getTestDb().update(organizations).set({ createdAt: new Date(longAgo.getTime() + 1000) }).where(eq(organizations.id, qs.id));

    await withSystemDbAccessContext(async () => {
      expect(await resolveDefaultOrgId(partnerId)).toBe(customerOrgId);
      expect(await resolveAuditOrgIdForPartner(partnerId)).toBe(customerOrgId);
    });
  });
});

describe('integration mapping guard', () => {
  it('system scope — the only caller whose org reach includes a holding org — sees it as one', async () => {
    await withSystemDbAccessContext(async () => {
      expect(await isHoldingOrg(pool.orgId)).toBe(true);
      expect(await isHoldingOrg(customerOrgId)).toBe(false);
    });
  });
});

describe('system-scope device counts leave parked devices out', () => {
  it('GET /devices/stats as a platform admin counts the customer device, not the parked one', async () => {
    const app = new Hono();
    app.route('/devices', statsRoutes);
    const client = await createIntegrationTestClient(app, { scope: 'system' });
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, client.env.user.id));
    await seedParkedDevice(pool.orgId, pool.siteId);
    await insertDevice(customerOrgId, customerSiteId);

    const parkedOnly = await client.get(`/devices/stats?orgId=${pool.orgId}`);
    expect(parkedOnly.status).toBe(200);
    expect((await parkedOnly.json()).data.total).toBe(0);
    const customer = await client.get(`/devices/stats?orgId=${customerOrgId}`);
    expect((await customer.json()).data.total).toBe(1);
  });
});

describe('UniFi site mapping stays inside the connection\'s partner', () => {
  it("a platform admin acting for one partner cannot map another partner's site, nor a holding-org site", async () => {
    const app = new Hono();
    app.route('/unifi', unifiRoutes);
    const client = await createIntegrationTestClient(app, { scope: 'system' });
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, client.env.user.id));
    await getTestDb().insert(unifiIntegrations).values({ partnerId, apiKeyEncrypted: 'enc:v1:placeholder' });
    const stranger = await createPartner({ status: 'active' });
    const strangerOrg = await createOrganization({ partnerId: stranger.id, status: 'active' });
    const strangerSite = await createSite({ orgId: strangerOrg.id });

    // An MFA-assured platform-admin session (the route requires MFA).
    const token = await createAccessToken({
      sub: client.env.user.id, email: client.env.user.email, roleId: client.env.role.id, orgId: null, partnerId: null,
      scope: 'system', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const put = async (siteId: string) => {
      const res = await app.request(`/unifi/mappings?partnerId=${partnerId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: [{ unifiHostId: 'host-1', unifiSiteId: `site-${siteId.slice(0, 4)}`, siteId }] }),
      });
      return { status: res.status, body: await res.json() };
    };
    expect(await put(strangerSite.id)).toMatchObject({ status: 403, body: { message: 'Target site does not belong to this partner' } });
    expect(await put(pool.siteId)).toMatchObject({ status: 409, body: { code: 'ORG_PROTECTED' } });
    expect(await getTestDb().select().from(unifiSiteMappings)).toHaveLength(0);
  });
});
