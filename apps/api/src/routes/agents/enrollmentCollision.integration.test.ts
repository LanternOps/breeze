/**
 * Real-Postgres integration coverage for the enrollment idempotency work
 * (#2764): hostname-collision fresh-row enrollment, the uninstall-intent ->
 * reap -> re-enroll lifecycle, and the bootstrap-cancel exactly-once refund
 * guard.
 *
 * None of these three properties can be proven by the existing mocked unit
 * suites (`enrollment.test.ts`, `uninstallIntent.test.ts`,
 * `installer.test.ts`):
 *
 *  - The collision path's "the colliding row is NEVER written" guarantee is a
 *    negative assertion about what DIDN'T happen to a real row across two
 *    real transactions — a mock can only assert which Drizzle calls were
 *    made, not that a full `SELECT *` before/after stays byte-identical.
 *  - The reap predicate (`uninstall_intent_at < now() - interval AND
 *    (last_seen_at IS NULL OR last_seen_at < uninstall_intent_at) AND status
 *    NOT IN (...)`) needs a real Postgres `now()` and a real partial index to
 *    mean anything; `offlineDetector.test.ts` only asserts the generated SQL
 *    shape.
 *  - The cancel-refund's exactly-once guarantee is a DB-level row-lock race
 *    (`DELETE ... WHERE id = X AND usage_count = 0 RETURNING id`) between two
 *    genuinely concurrent transactions — unreproducible against a mocked `db`
 *    where every call resolves sequentially in test order.
 *
 * This suite drives the actual route handlers (`enrollmentRoutes`,
 * `uninstallIntentRoutes`, `installerRoutes`) and the actual reaper
 * (`processReapUninstallIntent`) against the test DB, mirroring the
 * mount-a-real-Hono-app-and-fake-only-the-authenticating-middleware pattern
 * used by `patches.integration.test.ts`.
 */
import '../../__tests__/integration/setup';
import { randomBytes } from 'crypto';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, enrollmentKeys, installerBootstrapTokens } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { enrollmentRoutes } from './enrollment';
import { uninstallIntentRoutes } from './uninstallIntent';
import { installerRoutes } from '../installer';
import { processReapUninstallIntent } from '../../jobs/offlineDetector';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** The exact RLS context `agentAuthMiddleware` sets up for org-scoped agent routes. */
function agentRequestContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

function enrollmentApp(): Hono {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  return app;
}

/** Fakes agentAuthMiddleware's `c.set('agent', ...)` — the route only reads `agent.deviceId`. */
function uninstallIntentApp(deviceId: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', { deviceId, agentId: 'itest-agent', orgId: 'unused', siteId: 'unused', role: 'agent' } as never);
    await next();
  });
  app.route('/agents', uninstallIntentRoutes);
  return app;
}

function installerApp(): Hono {
  const app = new Hono();
  app.route('/installer', installerRoutes);
  return app;
}

async function makeEnrollmentKey(orgId: string, siteId: string, rawKey: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(enrollmentKeys)
      .values({
        orgId,
        siteId,
        name: 'Integration Test Key',
        key: hashEnrollmentKey(rawKey),
        keySecretHash: null,
        usageCount: 0,
        maxUsage: null,
        expiresAt: null,
      })
      .returning();
    if (!row) throw new Error('makeEnrollmentKey: no row');
    return row;
  });
}

function enrollBody(rawKey: string, hostname: string) {
  return {
    enrollmentKey: rawKey,
    hostname,
    osType: 'windows' as const,
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '1.0.0-test',
  };
}

async function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function selectDevice(deviceId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(devices).where(eq(devices.id, deviceId));
    return row ?? null;
  });
}

describe('enrollment idempotency — real Postgres (#2764)', () => {
  runDb('enroll -> uninstall-intent -> reap -> re-enroll lands a fresh device row', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const rawKey = `reap-key-${unique}`;
    await makeEnrollmentKey(org.id, site.id, rawKey);

    const app = enrollmentApp();
    const hostname = `reap-host-${unique}`;

    // 1. Enroll.
    const enrollRes = await postJson(app, '/agents/enroll', enrollBody(rawKey, hostname));
    expect(enrollRes.status).toBe(201);
    const enrollBodyJson = await enrollRes.json();
    const deviceId = enrollBodyJson.deviceId as string;
    expect(deviceId).toBeTruthy();

    const afterEnroll = await selectDevice(deviceId);
    expect(afterEnroll?.status).toBe('pending');
    expect(afterEnroll?.uninstallIntentAt).toBeNull();

    // 2. Signal uninstall intent (token-resolved write — device auth is faked,
    // matching patches.integration.test.ts's agentAuthMiddleware stand-in).
    const uiApp = uninstallIntentApp(deviceId);
    // `async` is load-bearing: Hono's app.request() is typed
    // `Response | Promise<Response>`, but withDbAccessContext's callback must
    // return a Promise — a bare arrow fails tsc with TS2322.
    const uiRes = await withDbAccessContext(agentRequestContext(org.id), async () =>
      uiApp.request(`/agents/${deviceId}/uninstall-intent`, { method: 'POST' }),
    );
    expect(uiRes.status).toBe(200);

    const afterIntent = await selectDevice(deviceId);
    expect(afterIntent?.uninstallIntentAt).not.toBeNull();
    expect(afterIntent?.status).toBe('pending'); // reaper hasn't run yet

    // 3. Reap. UNINSTALL_INTENT_DECOMMISSION_HOURS=0 makes the just-stamped
    // intent immediately eligible — the predicate's `< now() - interval`
    // clause needs only the few ms that have already elapsed since step 2's
    // write landed.
    const previousHoursEnv = process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS;
    process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS = '0';
    try {
      const reapResult = await withSystemDbAccessContext(() => processReapUninstallIntent());
      expect(reapResult.decommissioned).toBeGreaterThanOrEqual(1);
    } finally {
      if (previousHoursEnv === undefined) {
        delete process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS;
      } else {
        process.env.UNINSTALL_INTENT_DECOMMISSION_HOURS = previousHoursEnv;
      }
    }

    const afterReap = await selectDevice(deviceId);
    expect(afterReap?.status).toBe('decommissioned');

    // 4. Re-enroll with the SAME hostname/key and no existing-device token —
    // the decommissioned row cannot authenticate, so this must take the
    // decom-bypass fresh-row path (issue #914), landing a NEW device id
    // rather than reviving the reaped one or refusing the enrollment.
    const reenrollRes = await postJson(app, '/agents/enroll', enrollBody(rawKey, hostname));
    expect(reenrollRes.status).toBe(201);
    const reenrollBodyJson = await reenrollRes.json();
    const freshDeviceId = reenrollBodyJson.deviceId as string;
    expect(freshDeviceId).toBeTruthy();
    expect(freshDeviceId).not.toBe(deviceId);

    const freshDevice = await selectDevice(freshDeviceId);
    expect(freshDevice?.status).toBe('pending');
    expect(freshDevice?.hostname).toBe(hostname);

    // The prior (reaped) row keeps its history but is renamed off the
    // hostname to free the slot — the decom-bypass rename, not the
    // collision path (which never touches the old row at all; see the next
    // test).
    const priorDevice = await selectDevice(deviceId);
    expect(priorDevice?.status).toBe('decommissioned');
    expect(priorDevice?.hostname).toBe(`${hostname}.decom-${deviceId.slice(0, 8)}`);
  });

  runDb('a hostname-collision enroll leaves the colliding row byte-identical', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const rawKey = `collision-key-${unique}`;
    await makeEnrollmentKey(org.id, site.id, rawKey);

    const app = enrollmentApp();
    const hostname = `collision-host-${unique}`;

    const firstRes = await postJson(app, '/agents/enroll', enrollBody(rawKey, hostname));
    expect(firstRes.status).toBe(201);
    const firstDeviceId = (await firstRes.json()).deviceId as string;

    const before = await selectDevice(firstDeviceId);
    expect(before).not.toBeNull();
    expect(before?.status).toBe('pending'); // fresh enrollment has not proved reachability yet

    // Second machine claims the SAME hostname/org/site with the SAME
    // enrollment key but no existing-device token — no way to distinguish
    // this from a hostname collision. Per #2764 this must NOT 409 and must
    // NOT touch the first row at all: only a fresh row is inserted.
    const secondRes = await postJson(app, '/agents/enroll', enrollBody(rawKey, hostname));
    expect(secondRes.status).toBe(201);
    const secondBody = await secondRes.json();
    const secondDeviceId = secondBody.deviceId as string;
    expect(secondDeviceId).not.toBe(firstDeviceId);

    const secondDevice = await selectDevice(secondDeviceId);
    expect(secondDevice?.possibleReplacementOfDeviceId).toBe(firstDeviceId);

    const after = await selectDevice(firstDeviceId);
    // Byte-identical: every column, not just status — the collision path
    // must perform ZERO writes to the row it may be replacing.
    expect(after).toEqual(before);
  });
});

describe('bootstrap cancel — exactly-once refund under concurrency (#2764)', () => {
  runDb('two concurrent cancels of the same unused child key refund exactly once', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const parentKey = await makeEnrollmentKey(org.id, site.id, `parent-key-${unique}`);

    const tokenValue = randomBytes(24).toString('hex');
    const token = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(installerBootstrapTokens)
        .values({
          token: tokenValue,
          orgId: org.id,
          parentEnrollmentKeyId: parentKey.id,
          siteId: site.id,
          maxUsage: 5,
          consumedCount: 1, // simulates the one redemption that minted the child key below
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })
        .returning();
      if (!row) throw new Error('no installer_bootstrap_tokens row');
      return row;
    });

    const childRawSecret = randomBytes(24).toString('hex');
    const childKey = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(enrollmentKeys)
        .values({
          orgId: org.id,
          siteId: site.id,
          name: 'Integration Test Child Key',
          key: hashEnrollmentKey(childRawSecret),
          keySecretHash: null,
          usageCount: 0,
          maxUsage: 1,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          bootstrapTokenId: token.id,
        })
        .returning();
      if (!row) throw new Error('no enrollment_keys child row');
      return row;
    });

    const app = installerApp();
    const cancelOnce = () => postJson(app, '/installer/bootstrap/cancel', { enrollmentSecret: childRawSecret });

    const [res1, res2] = await Promise.all([cancelOnce(), cancelOnce()]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

    const refundedCount = [body1, body2].filter((b) => b.refunded === true).length;
    expect(refundedCount).toBe(1);
    const loser = [body1, body2].find((b) => b.refunded === false);
    expect(loser).toEqual({ refunded: false, reason: 'already_used' });

    // Final state must reflect exactly one refund regardless of which HTTP
    // response "won" the race: the child key is gone, and the token's slot
    // was decremented exactly once (1 -> 0), never twice (which would go
    // negative pre-GREATEST, or double-free the slot).
    const remainingChild = await withSystemDbAccessContext(async () => {
      const [row] = await db.select().from(enrollmentKeys).where(eq(enrollmentKeys.id, childKey.id));
      return row ?? null;
    });
    expect(remainingChild).toBeNull();

    const finalToken = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .select()
        .from(installerBootstrapTokens)
        .where(eq(installerBootstrapTokens.id, token.id));
      return row ?? null;
    });
    expect(finalToken?.consumedCount).toBe(0);
  });
});
