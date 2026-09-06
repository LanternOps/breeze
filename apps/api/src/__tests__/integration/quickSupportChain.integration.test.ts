/**
 * Quick Support — the whole chain against REAL Postgres.
 *
 * provision hidden org -> mint session -> redeem code -> enroll ephemeral
 * device -> licence accounting -> end session -> reap.
 *
 * Every mocked unit suite in this feature (`quickSupportOrg.test.ts`,
 * `supportPublic.test.ts`, `enrollment.test.ts`, `quickSupportEnd.test.ts`,
 * `quickSupportReaper.test.ts`) mocks `../db` wholesale, so none of them can
 * prove any of the properties that actually matter here:
 *
 *  - Idempotent org provisioning depends on a PARTIAL UNIQUE INDEX
 *    (`organizations_partner_quick_support_uniq`) plus `onConflictDoNothing`.
 *    A mock has no index.
 *  - "A code is strictly single-use" is an atomic `UPDATE ... WHERE
 *    status = 'pending'` — its whole meaning is the row-level guard, which a
 *    chainable mock resolves unconditionally.
 *  - The reaper's purge relies on `support_sessions.device_id` being
 *    `ON DELETE SET NULL`, i.e. on the real FK action. A mock cannot have one.
 *  - Licence counting is a real `count(*)` over a real `IN (subquery)` with a
 *    real `is_ephemeral = false` predicate.
 *
 * Where a real HTTP handler exists (POST /support/redeem, POST /agents/enroll)
 * this suite drives THE ROUTE, not a re-implementation, following the
 * mount-a-real-Hono-app pattern from `enrollmentCollision.integration.test.ts`.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  db,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import {
  devices,
  enrollmentKeys,
  organizations,
  partners,
  sites,
  supportSessions,
} from '../../db/schema';
import { createPartner, createOrganization, createSite, createUser } from './db-utils';
import { getOrCreateQuickSupportOrg } from '../../services/quickSupportOrg';
import {
  SUPPORT_CODE_TTL_MINUTES,
  SUPPORT_SESSION_HARD_CAP_HOURS,
  generateSupportCode,
  hashSupportCode,
} from '../../services/quickSupportCode';
import { endSupportSession } from '../../services/quickSupportEnd';
import { reapOnce } from '../../jobs/quickSupportReaper';
import { countContractDevices } from '../../services/contractQuantities';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { supportPublicRoutes } from '../../routes/supportPublic';
import { enrollmentRoutes } from '../../routes/agents/enrollment';

// ============================================
// Fixtures / cleanup bookkeeping
// ============================================

const createdDevices: string[] = [];
const createdOrgs: string[] = [];
const createdPartners: string[] = [];

/** Everything here runs OUTSIDE a request, so escalate the same way jobs do. */
function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * Explicitly drop every feature-owned row this file creates.
 *
 * The tenant ROOTS (organizations / partners / users / audit_logs) are left to
 * setup.ts's global `beforeEach` TRUNCATE ... CASCADE, which already lists all
 * four. Deleting them here would abort anyway: `audit_logs.org_id` is an FK
 * with no ON DELETE action, and the redeem + enroll routes under test both
 * write audit rows, so an org DELETE raises 23503 while audit_logs is
 * append-only (REVOKE DELETE) and cannot be cleared first.
 */
afterEach(async () => {
  if (createdPartners.length === 0 && createdOrgs.length === 0 && createdDevices.length === 0) return;
  await asSystem(async () => {
    // Devices first: deleteDeviceCascade also NULLs support_sessions.device_id.
    for (const deviceId of createdDevices) {
      await db.transaction(async (tx) => {
        await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, deviceId);
      });
    }
    for (const orgId of createdOrgs) {
      await db.delete(enrollmentKeys).where(eq(enrollmentKeys.orgId, orgId));
      await db.delete(supportSessions).where(eq(supportSessions.orgId, orgId));
      await db.delete(devices).where(eq(devices.orgId, orgId));
      await db.delete(sites).where(eq(sites.orgId, orgId));
    }
  });
  createdDevices.length = 0;
  createdOrgs.length = 0;
  createdPartners.length = 0;
});

function redeemApp(): Hono {
  const app = new Hono();
  app.route('/support', supportPublicRoutes);
  return app;
}

function enrollApp(): Hono {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  return app;
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function uniqueEmail(): string {
  return `qs-chain-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@example.com`;
}

/**
 * A partner with its hidden Quick Support org provisioned and a technician
 * user to own the sessions.
 */
async function seedSupportTenant() {
  const partner = await createPartner();
  createdPartners.push(partner.id);
  const { orgId, siteId } = await getOrCreateQuickSupportOrg(partner.id);
  createdOrgs.push(orgId);
  // users.email is UNIQUE and db-utils' default is `test-${Date.now()}`, which
  // collides when two tenants land in the same millisecond.
  const tech = await createUser({ partnerId: partner.id, email: uniqueEmail() });
  return { partnerId: partner.id, orgId, siteId, techId: tech.id };
}

/** Mirrors POST /remote/support-sessions' insert (routes/remote/supportSessions.ts). */
async function mintSession(orgId: string, techId: string): Promise<{ id: string; code: string }> {
  const code = generateSupportCode();
  const now = Date.now();
  const [row] = await asSystem(() =>
    db
      .insert(supportSessions)
      .values({
        orgId,
        createdByUserId: techId,
        codeHash: hashSupportCode(code),
        codeExpiresAt: new Date(now + SUPPORT_CODE_TTL_MINUTES * 60_000),
        hardExpiresAt: new Date(now + SUPPORT_SESSION_HARD_CAP_HOURS * 3_600_000),
      })
      .returning(),
  );
  if (!row) throw new Error('mintSession: no row');
  return { id: row.id, code };
}

function redeemBody(code: string, hostname: string) {
  return { code, hostname, osType: 'windows' as const };
}

function enrollBody(rawKey: string, rawSecret: string | null, hostname: string) {
  return {
    enrollmentKey: rawKey,
    ...(rawSecret ? { enrollmentSecret: rawSecret } : {}),
    hostname,
    osType: 'windows' as const,
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '1.0.0-test',
  };
}

async function readSession(id: string) {
  return asSystem(async () => {
    const [row] = await db.select().from(supportSessions).where(eq(supportSessions.id, id));
    return row ?? null;
  });
}

async function readDevice(id: string) {
  return asSystem(async () => {
    const [row] = await db.select().from(devices).where(eq(devices.id, id));
    return row ?? null;
  });
}

/** Full redeem -> enroll, returning the ephemeral device id. */
async function redeemAndEnroll(sessionCode: string, hostname: string): Promise<{ deviceId: string; redeem: Record<string, string> }> {
  const redeemRes = await postJson(redeemApp(), '/support/redeem', redeemBody(sessionCode, hostname));
  expect(redeemRes.status).toBe(200);
  const redeem = (await redeemRes.json()) as Record<string, string>;

  const enrollRes = await postJson(
    enrollApp(),
    '/agents/enroll',
    enrollBody(redeem.enrollmentKey!, redeem.enrollmentSecret!, hostname),
  );
  expect(enrollRes.status).toBe(201);
  const enrolled = (await enrollRes.json()) as { deviceId: string };
  createdDevices.push(enrolled.deviceId);
  return { deviceId: enrolled.deviceId, redeem };
}

// ============================================
// 1. Hidden-org provisioning
// ============================================

describe('getOrCreateQuickSupportOrg — hidden per-partner org', () => {
  it('is idempotent: two calls for the same partner return the same org and site, and only one row exists', async () => {
    const partner = await createPartner();
    createdPartners.push(partner.id);

    const first = await getOrCreateQuickSupportOrg(partner.id);
    createdOrgs.push(first.orgId);
    const second = await getOrCreateQuickSupportOrg(partner.id);

    expect(second.orgId).toBe(first.orgId);
    expect(second.siteId).toBe(first.siteId);

    const rows = await asSystem(() =>
      db
        .select({ id: organizations.id, type: organizations.type })
        .from(organizations)
        .where(and(eq(organizations.partnerId, partner.id), eq(organizations.type, 'quick_support'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.orgId);

    const siteRows = await asSystem(() =>
      db.select({ id: sites.id }).from(sites).where(eq(sites.orgId, first.orgId)),
    );
    expect(siteRows).toHaveLength(1);
  });

  it('gives DIFFERENT partners different hidden orgs', async () => {
    const a = await createPartner();
    const b = await createPartner();
    createdPartners.push(a.id, b.id);

    const orgA = await getOrCreateQuickSupportOrg(a.id);
    const orgB = await getOrCreateQuickSupportOrg(b.id);
    createdOrgs.push(orgA.orgId, orgB.orgId);

    expect(orgA.orgId).not.toBe(orgB.orgId);
  });
});

// ============================================
// 2 + 3. Redemption and single-use
// ============================================

describe('POST /support/redeem — claim + child key minting', () => {
  it('flips pending -> claimed and mints a single-use child key with its own secret', async () => {
    const tenant = await seedSupportTenant();
    const session = await mintSession(tenant.orgId, tenant.techId);

    const res = await postJson(redeemApp(), '/support/redeem', redeemBody(session.code, 'qs-host-1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.enrollmentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(body.enrollmentSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sessionId).toBe(session.id);

    const claimed = await readSession(session.id);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claimedAt).toBeInstanceOf(Date);

    const keys = await asSystem(() =>
      db.select().from(enrollmentKeys).where(eq(enrollmentKeys.supportSessionId, session.id)),
    );
    expect(keys).toHaveLength(1);
    const key = keys[0]!;
    expect(key.orgId).toBe(tenant.orgId);
    expect(key.siteId).toBe(tenant.siteId);
    expect(key.maxUsage).toBe(1);
    expect(key.usageCount).toBe(0);
    // Its OWN secret, not the global AGENT_ENROLLMENT_SECRET.
    expect(key.keySecretHash).toMatch(/^[0-9a-f]{64}$/);
    // The stored key is a hash of the raw key handed to the client, never the
    // raw value itself.
    expect(key.key).toBe(hashEnrollmentKey(body.enrollmentKey!));
    expect(key.key).not.toBe(body.enrollmentKey);
    expect(key.expiresAt).toBeInstanceOf(Date);
  });

  it('a SECOND redemption of the same code fails and mints NO second key (strictly single-use)', async () => {
    const tenant = await seedSupportTenant();
    const session = await mintSession(tenant.orgId, tenant.techId);

    const first = await postJson(redeemApp(), '/support/redeem', redeemBody(session.code, 'qs-host-1'));
    expect(first.status).toBe(200);

    const second = await postJson(redeemApp(), '/support/redeem', redeemBody(session.code, 'qs-host-2'));
    expect(second.status).toBe(404);
    // Indistinguishable from an unknown code — no confirmation the code existed.
    expect(await second.json()).toEqual({ error: 'invalid or expired code' });

    // The load-bearing assertion: exactly ONE credential ever existed for
    // this code. A second key here is a second live agent on a stranger's
    // machine.
    const keys = await asSystem(() =>
      db.select({ id: enrollmentKeys.id }).from(enrollmentKeys).where(eq(enrollmentKeys.supportSessionId, session.id)),
    );
    expect(keys).toHaveLength(1);

    const row = await readSession(session.id);
    expect(row?.status).toBe('claimed');
  });

  it('CONCURRENT redemptions of the same code: exactly one wins', async () => {
    const tenant = await seedSupportTenant();
    const session = await mintSession(tenant.orgId, tenant.techId);

    // Genuinely overlapping requests through the real pool — the atomic
    // `WHERE status='pending'` guard is the only thing separating them.
    const results = await Promise.all([
      postJson(redeemApp(), '/support/redeem', redeemBody(session.code, 'qs-race-a')),
      postJson(redeemApp(), '/support/redeem', redeemBody(session.code, 'qs-race-b')),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 404]);

    const keys = await asSystem(() =>
      db.select({ id: enrollmentKeys.id }).from(enrollmentKeys).where(eq(enrollmentKeys.supportSessionId, session.id)),
    );
    expect(keys).toHaveLength(1);
  });
});

// ============================================
// 4. Ephemeral enrollment
// ============================================

describe('POST /agents/enroll with a support child key', () => {
  it('mints an EPHEMERAL device and links it back to the session', async () => {
    const tenant = await seedSupportTenant();
    const session = await mintSession(tenant.orgId, tenant.techId);

    const { deviceId } = await redeemAndEnroll(session.code, 'qs-enroll-host');

    const device = await readDevice(deviceId);
    expect(device?.isEphemeral).toBe(true);
    expect(device?.orgId).toBe(tenant.orgId);
    expect(device?.siteId).toBe(tenant.siteId);

    const linked = await readSession(session.id);
    expect(linked?.deviceId).toBe(deviceId);

    // The single-use child key is now spent.
    const [key] = await asSystem(() =>
      db.select().from(enrollmentKeys).where(eq(enrollmentKeys.supportSessionId, session.id)),
    );
    expect(key?.usageCount).toBe(1);
  });
});

// ============================================
// 5. Licence accounting
// ============================================

describe('licence counting — ephemeral devices are not endpoints', () => {
  it('a partner AT its maxDevices cap can still take a support session, but a normal enrollment is refused', async () => {
    const partner = await createPartner();
    createdPartners.push(partner.id);
    const custOrg = await createOrganization({ partnerId: partner.id });
    createdOrgs.push(custOrg.id);
    const custSite = await createSite({ orgId: custOrg.id });

    // Ordinary (non-support) key for the customer org.
    const rawKey = `cap-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await asSystem(() =>
      db.insert(enrollmentKeys).values({
        orgId: custOrg.id,
        siteId: custSite.id,
        name: 'Cap Test Key',
        key: hashEnrollmentKey(rawKey),
        keySecretHash: null,
        usageCount: 0,
        maxUsage: null,
        expiresAt: null,
      }),
    );

    // One real endpoint, then the cap set to exactly that.
    // /agents/enroll answers 201 Created, not 200 — matching the route and its
    // unit suite.
    const firstRes = await postJson(enrollApp(), '/agents/enroll', enrollBody(rawKey, null, 'cap-host-1'));
    expect(firstRes.status).toBe(201);
    const first = (await firstRes.json()) as { deviceId: string };
    createdDevices.push(first.deviceId);

    await asSystem(() => db.update(partners).set({ maxDevices: 1 }).where(eq(partners.id, partner.id)));

    // Quick Support tenant for the SAME partner.
    const { orgId: qsOrgId } = await getOrCreateQuickSupportOrg(partner.id);
    createdOrgs.push(qsOrgId);
    const tech = await createUser({ partnerId: partner.id, email: uniqueEmail() });
    const session = await mintSession(qsOrgId, tech.id);

    // (a) Support enrollment succeeds at the cap — a tech must always be able
    // to help a caller.
    const { deviceId: ephemeralId } = await redeemAndEnroll(session.code, 'cap-support-host');
    const ephemeral = await readDevice(ephemeralId);
    expect(ephemeral?.isEphemeral).toBe(true);

    // (b) A NORMAL enrollment at the same cap is refused — proving (a) was an
    // exemption for support, not a broken/absent limit check.
    const deniedRes = await postJson(enrollApp(), '/agents/enroll', enrollBody(rawKey, null, 'cap-host-2'));
    expect(deniedRes.status).toBe(403);
    const denied = (await deniedRes.json()) as { code?: string; currentDevices?: number; maxDevices?: number };
    expect(denied.code).toBe('DEVICE_LIMIT_REACHED');
    // The ephemeral device did NOT inflate the count.
    expect(denied.currentDevices).toBe(1);
    expect(denied.maxDevices).toBe(1);

    // (c) countContractDevices feeds contract AND invoice line quantities —
    // an ephemeral device reaching it would bill a customer for a machine
    // that existed for twenty minutes and was never theirs.
    await asSystem(async () => {
      expect(await countContractDevices(qsOrgId, null)).toBe(0);
      expect(await countContractDevices(custOrg.id, null)).toBe(1);
    });
  });
});

// ============================================
// 6. Teardown
// ============================================

describe('endSupportSession', () => {
  it("revokes all three device token hashes, decommissions the device and marks the session 'ended'", async () => {
    const tenant = await seedSupportTenant();
    const session = await mintSession(tenant.orgId, tenant.techId);
    const { deviceId } = await redeemAndEnroll(session.code, 'qs-end-host');

    const before = await readDevice(deviceId);
    // Anti-vacuity: the hashes must actually be SET before we assert they
    // were cleared.
    expect(before?.agentTokenHash).toBeTruthy();
    expect(before?.watchdogTokenHash).toBeTruthy();
    expect(before?.helperTokenHash).toBeTruthy();
    expect(before?.status).toBe('pending');

    const result = await endSupportSession(session.id, 'tech');
    expect(result.ended).toBe(true);

    const after = await readDevice(deviceId);
    expect(after?.agentTokenHash).toBeNull();
    expect(after?.watchdogTokenHash).toBeNull();
    expect(after?.helperTokenHash).toBeNull();
    expect(after?.status).toBe('decommissioned');

    const ended = await readSession(session.id);
    expect(ended?.status).toBe('ended');
    expect(ended?.endedReason).toBe('tech');
    expect(ended?.endedAt).toBeInstanceOf(Date);
    // The audit trail still points at the device until the reaper purges it.
    expect(ended?.deviceId).toBe(deviceId);
  });

  it('is idempotent: a second end on a terminal session reports ended:false', async () => {
    const tenant = await seedSupportTenant();
    const session = await mintSession(tenant.orgId, tenant.techId);
    const { deviceId } = await redeemAndEnroll(session.code, 'qs-end-twice');

    expect((await endSupportSession(session.id, 'tech')).ended).toBe(true);
    expect((await endSupportSession(session.id, 'tech')).ended).toBe(false);

    const row = await readSession(session.id);
    expect(row?.endedReason).toBe('tech');
    expect(row?.deviceId).toBe(deviceId);
  });
});

// ============================================
// 7 + 8. The reaper
// ============================================

describe('reapOnce — ephemeral device purge', () => {
  it('purges the ephemeral device 6h after the session ended, while the session row SURVIVES with device_id NULL', async () => {
    const tenant = await seedSupportTenant();
    const session = await mintSession(tenant.orgId, tenant.techId);
    const { deviceId } = await redeemAndEnroll(session.code, 'qs-reap-host');

    await endSupportSession(session.id, 'tech');

    // Backdate past PURGE_AFTER_ENDED_MS (6h).
    await asSystem(() =>
      db
        .update(supportSessions)
        .set({ endedAt: new Date(Date.now() - 7 * 3_600_000) })
        .where(eq(supportSessions.id, session.id)),
    );

    expect(await readDevice(deviceId)).not.toBeNull(); // control

    await reapOnce();

    expect(await readDevice(deviceId)).toBeNull();

    // The session row is the audit trail — ON DELETE SET NULL, never CASCADE.
    const survivor = await readSession(session.id);
    expect(survivor).not.toBeNull();
    expect(survivor?.deviceId).toBeNull();
    expect(survivor?.status).toBe('ended');
    expect(survivor?.endedReason).toBe('tech');
  });

  it('REFUSES to purge a non-ephemeral device even when a session row points at it', async () => {
    const tenant = await seedSupportTenant();

    // A real, managed customer device — is_ephemeral = false.
    const custOrg = await createOrganization({ partnerId: tenant.partnerId });
    createdOrgs.push(custOrg.id);
    const custSite = await createSite({ orgId: custOrg.id });
    const [realDevice] = await asSystem(() =>
      db
        .insert(devices)
        .values({
          orgId: custOrg.id,
          siteId: custSite.id,
          agentId: `real-agent-${Date.now()}`,
          hostname: 'not-ephemeral-host',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: '1.0.0-test',
          isEphemeral: false,
        })
        .returning(),
    );
    if (!realDevice) throw new Error('failed to seed non-ephemeral device');
    createdDevices.push(realDevice.id);

    // A corrupted/mis-linked session pointing at that real device, already
    // long past its purge deadline.
    const bad = await mintSession(tenant.orgId, tenant.techId);
    await asSystem(() =>
      db
        .update(supportSessions)
        .set({
          status: 'ended',
          deviceId: realDevice.id,
          endedAt: new Date(Date.now() - 7 * 3_600_000),
          endedReason: 'tech',
        })
        .where(eq(supportSessions.id, bad.id)),
    );

    // A legitimate ephemeral session in the SAME pass, so a reaper that
    // simply no-opped could not make this test pass.
    const good = await mintSession(tenant.orgId, tenant.techId);
    const { deviceId: ephemeralId } = await redeemAndEnroll(good.code, 'qs-reap-good');
    await endSupportSession(good.id, 'tech');
    await asSystem(() =>
      db
        .update(supportSessions)
        .set({ endedAt: new Date(Date.now() - 7 * 3_600_000) })
        .where(eq(supportSessions.id, good.id)),
    );

    await reapOnce();

    // The real device survives, still attached to the bad session row.
    const stillThere = await readDevice(realDevice.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.isEphemeral).toBe(false);
    expect((await readSession(bad.id))?.deviceId).toBe(realDevice.id);

    // ...and the pass genuinely ran.
    expect(await readDevice(ephemeralId)).toBeNull();
    expect((await readSession(good.id))?.deviceId).toBeNull();
  });
});
