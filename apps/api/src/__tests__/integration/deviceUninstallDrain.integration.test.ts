/**
 * #3986 — device-remove uninstall drain, end to end against real Postgres.
 *
 * Everything else on this branch is covered by unit tests that mock Drizzle and
 * assert on COMPILED SQL TEXT. Those can prove the query has the right shape and
 * deliberately cannot prove what Postgres does with it. Two of this feature's
 * deny semantics live entirely in the database's evaluation rules and were, until
 * this file, argued in comments rather than executed:
 *
 *   - `NULL @> ARRAY['device_remove']` is NULL, not false — and a row with NULL
 *     `uninstall_reasons` (every abuse-suspension row; every row queued before
 *     the column existed) must therefore NOT drain, and must NOT be exempted
 *     from the stale-command reaper.
 *   - `device_remove_expires_at > now()` is a STRICT comparison against the
 *     database clock, and NULL > now() is NULL — an expired or absent deadline
 *     must revert the device to today's hard 403.
 *
 * The suite is organised as the five properties that actually matter:
 *
 *   1. Delivery      — Remove with uninstallAgent queues a provenanced row, the
 *                      agent is admitted on exactly the drain surface, collects
 *                      the uninstall AND NOTHING ELSE, acks it, and is refused
 *                      again once the row is terminal.
 *   2. Restore       — restore cancels the row and ends the exemption.
 *   3. Incident guard— an abuse suspension's reason-less fleet uninstalls are
 *                      reaped, never drained, and never delivered to a
 *                      reinstated customer's machines. THE test of this branch.
 *   4. Overlap       — one row, two reasons; each owner releases only its own.
 *   5. Deny semantics— the three non-draining shapes, executed rather than
 *                      argued, plus a positive control so the negatives cannot
 *                      pass vacuously.
 *
 * Deliberately NOT `it.runIf(...)`: a skipped guard is indistinguishable from a
 * passing one in a CI log, and this file exists precisely because the property
 * it pins has never been executed. If the database is missing these fail loudly.
 *
 * Run (note: NO `--` before the path — `pnpm ... test:integration -- <path>`
 * silently runs the whole integration suite instead of filtering):
 *   pnpm test-stack up
 *   cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceUninstallDrain.integration.test.ts
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * The org/user the stubbed user-auth middleware authorizes for the current
 * test. Read only when a request runs (never in the mock factory body), so the
 * `let` is fully initialized by then.
 */
let activeAuth: { orgId: string; userId: string; email: string } | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuth) return c.json({ error: 'Unauthorized' }, 401);
      const { orgId, userId, email } = activeAuth;
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId,
        accessibleOrgIds: [orgId],
        // Mirrors buildOrgAccessClosures in middleware/auth.ts — both real
        // constructors always set it, so omitting it makes the route throw
        // instead of authorizing.
        canAccessOrg: (candidate: string) => candidate === orgId,
        user: { id: userId, email },
      });
      // requirePermission is stubbed below, and it is what normally populates
      // this. getDeviceWithOrgAndSiteCheck hard-throws (500) without it.
      // `allowedSiteIds: null` == no site restriction.
      c.set('permissions', { allowedSiteIds: null });
      return withDbAccessContext(
        { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: null, userId },
        () => next(),
      );
    },
    requireScope: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, organizations, partners } from '../../db/schema';
import { isDeviceUninstallDraining } from '../../services/deviceUninstallDrain';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { reapStaleDeviceCommands } from '../../jobs/staleCommandReaper';
import {
  abortOrganizationOffboarding,
  beginOrganizationOffboarding,
} from '../../services/tenantOffboarding';
import { invalidateAgentTenantCache } from '../../services/tenantStatus';
import { agentRoutes } from '../../routes/agents';
import { coreRoutes } from '../../routes/devices/core';
import { abuseRoutes } from '../../routes/admin/abuse';

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/**
 * The agent app MUST be mounted at the production shape `/api/v1/agents`.
 * `middleware/agentAuth.isCoreAgentPath` anchors the drain surface ABSOLUTELY
 * from the front of the path, so a convenience mount at `/` would put every
 * request off the drain allowlist and 403 the whole suite — mounting it exactly
 * as `index.ts` does is part of what this file proves.
 */
function buildAgentApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/agents', agentRoutes);
  return app;
}

function buildDeviceApp(): Hono {
  const app = new Hono();
  app.route('/devices', coreRoutes);
  return app;
}

/**
 * abuseRoutes carries no auth middleware of its own (the /admin mount supplies
 * it), so the stub only has to seat `auth`. The handlers open their own
 * `withSystemDbAccessContext`, so no ambient DB context is established here.
 */
function buildAbuseApp(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'system',
      user: { id: activeAuth!.userId, email: activeAuth!.email },
    } as never);
    await next();
  });
  app.route('/admin', abuseRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeededDevice {
  id: string;
  agentId: string;
  agentToken: string;
}

let deviceCounter = 0;

async function seedDevice(
  orgId: string,
  siteId: string,
  status: 'online' | 'offline' | 'decommissioned' = 'online',
): Promise<SeededDevice> {
  deviceCounter += 1;
  const suffix = `${Date.now()}-${deviceCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `agent-3986-${suffix}`;
  const agentToken = `brz_3986_${suffix}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId,
      hostname: `host-3986-${suffix}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status,
      agentTokenHash: createHash('sha256').update(agentToken).digest('hex'),
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: insert returned no row');
  return { id: row.id, agentId, agentToken };
}

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  userId: string;
  userEmail: string;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner.id, status: 'active' });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  activeAuth = { orgId: org.id, userId: user.id, email: user.email };
  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    userId: user.id,
    userEmail: user.email,
  };
}

// ---------------------------------------------------------------------------
// Readers / drivers
// ---------------------------------------------------------------------------

async function readUninstallRows(deviceId: string) {
  return getTestDb()
    .select({
      id: deviceCommands.id,
      status: deviceCommands.status,
      type: deviceCommands.type,
      uninstallReasons: deviceCommands.uninstallReasons,
      deviceRemoveExpiresAt: deviceCommands.deviceRemoveExpiresAt,
      result: deviceCommands.result,
    })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'self_uninstall')));
}

async function readDeviceStatus(deviceId: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ status: devices.status })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row!.status;
}

/** Queue a non-uninstall command the drain must never hand over. */
async function queueScriptCommand(deviceId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({
      deviceId,
      type: 'script',
      payload: { scriptId: 'noop', content: 'echo hi' },
      status: 'pending',
      targetRole: 'agent',
    })
    .returning({ id: deviceCommands.id });
  return row!.id;
}

/**
 * Request helpers.
 *
 * `async` is load-bearing, not stylistic: Hono's `app.request()` is overloaded
 * and returns `Response | Promise<Response>`, which does NOT satisfy a plain
 * `: Promise<Response>` annotation on a synchronous function (TS2322). Inside
 * an `async` function the returned value is awaited, so the union collapses to
 * `Response` and the declared type holds. Do not "simplify" the `async` away:
 * apps/api/tsconfig.json includes every file under `src`, so this integration
 * file IS typechecked by CI's required Type Check job
 * (`tsc --noEmit --project apps/api/tsconfig.json`) and dropping the keyword
 * reddens it — a test file being out of typecheck scope is NOT true here.
 */
async function heartbeat(app: Hono, device: SeededDevice): Promise<Response> {
  return app.request(`/api/v1/agents/${device.agentId}/heartbeat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${device.agentToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'ok', agentVersion: '1.0.0-test' }),
  });
}

async function removeDevice(app: Hono, deviceId: string, uninstallAgent: boolean): Promise<Response> {
  return app.request(`/devices/${deviceId}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer stub', 'Content-Type': 'application/json' },
    body: JSON.stringify({ uninstallAgent }),
  });
}

async function restoreDevice(app: Hono, deviceId: string): Promise<Response> {
  return app.request(`/devices/${deviceId}/restore`, {
    method: 'POST',
    headers: { Authorization: 'Bearer stub' },
  });
}

/** Age a command past the 30-minute self_uninstall timeout AND the reaper's
 *  conservative 5-minute SQL pre-filter. */
async function ageCommands(deviceIds: string[]): Promise<void> {
  await getTestDb()
    .update(deviceCommands)
    .set({ createdAt: new Date(Date.now() - 45 * 60 * 1000) })
    .where(inArray(deviceCommands.deviceId, deviceIds));
}

// ===========================================================================
// 1. Delivery
// ===========================================================================

describe('#3986 delivery — a Removed device collects its uninstall and nothing else', () => {
  it('queues a provenanced uninstall, narrows the agent surface to it, and closes on ack', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId, 'online');
    // A perfectly ordinary command already waiting for this agent. The drain
    // must leave it untouched — a type allowlist that silently defaults to
    // "unrestricted" is the trap this proves closed.
    const scriptCommandId = await queueScriptCommand(device.id);

    const deviceApp = buildDeviceApp();
    const agentApp = buildAgentApp();

    // --- Remove with uninstallAgent -----------------------------------------
    const removeRes = await removeDevice(deviceApp, device.id, true);
    expect(removeRes.status, await removeRes.clone().text()).toBe(200);
    expect(((await removeRes.json()) as { uninstallQueued: boolean }).uninstallQueued).toBe(true);

    expect(await readDeviceStatus(device.id)).toBe('decommissioned');

    const queued = await readUninstallRows(device.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('pending');
    expect(queued[0]!.uninstallReasons).toEqual(['device_remove']);
    expect(queued[0]!.deviceRemoveExpiresAt).not.toBeNull();
    expect(queued[0]!.deviceRemoveExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // --- The agent is admitted, and gets ONLY the uninstall -----------------
    const beat = await heartbeat(agentApp, device);
    expect(beat.status, await beat.clone().text()).toBe(200);

    const beatBody = (await beat.json()) as Record<string, unknown>;
    // "and nothing else" is a claim about the whole response, not just the
    // command list: the normal beat also carries configUpdate, agent/helper/
    // watchdog upgrade targets, manifest trust keys, renewCert and
    // rotateToken. Asserting the exact key set is what stops any of those
    // being re-added to a machine that is being uninstalled.
    expect(Object.keys(beatBody)).toEqual(['commands']);
    const delivered = beatBody.commands as Array<{ id: string; type: string }>;
    expect(delivered.map((cmd) => cmd.type)).toEqual(['self_uninstall']);

    // ...and the script command was NOT delivered, and is still pending.
    const [scriptRow] = await getTestDb()
      .select({ status: deviceCommands.status })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, scriptCommandId));
    expect(scriptRow!.status).toBe('pending');

    // --- The rest of the authenticated agent surface stays closed ----------
    const recoveryKeys = await agentApp.request(
      `/api/v1/agents/${device.agentId}/security/recovery-keys`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${device.agentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ keys: [{ keyType: 'bitlocker', recoveryKey: 'x' }] }),
      },
    );
    expect(recoveryKeys.status).toBe(403);
    expect((await recoveryKeys.json()) as unknown).toEqual({ error: 'device_uninstall_draining' });

    // --- Ack it completed --------------------------------------------------
    const ack = await agentApp.request(
      `/api/v1/agents/${device.agentId}/commands/${delivered[0]!.id}/result`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${device.agentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'completed', exitCode: 0 }),
      },
    );
    expect(ack.status, await ack.clone().text()).toBe(200);

    const acked = await readUninstallRows(device.id);
    expect(acked[0]!.status).toBe('completed');

    // --- With no non-terminal uninstall left, the window is over -----------
    const afterAck = await heartbeat(agentApp, device);
    expect(afterAck.status).toBe(403);
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(false);
  });
});

// ===========================================================================
// 2. Restore
// ===========================================================================

describe('#3986 restore — cancels the uninstall and ends the exemption', () => {
  it('cancels the pending row, delivers nothing afterwards, and re-closes the 403', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId, 'online');
    const deviceApp = buildDeviceApp();
    const agentApp = buildAgentApp();

    expect((await removeDevice(deviceApp, device.id, true)).status).toBe(200);

    const restoreRes = await restoreDevice(deviceApp, device.id);
    expect(restoreRes.status, await restoreRes.clone().text()).toBe(200);
    expect(
      ((await restoreRes.json()) as { uninstallAlreadyDispatched: boolean }).uninstallAlreadyDispatched,
    ).toBe(false);

    const rows = await readUninstallRows(device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('cancelled');
    expect(rows[0]!.result).toMatchObject({ reason: 'device_restored' });
    // Reason stripped and — because nothing else owned the row — the deadline
    // nulled with it, so no residue can re-arm a drain later.
    expect(rows[0]!.uninstallReasons).toEqual([]);
    expect(rows[0]!.deviceRemoveExpiresAt).toBeNull();
    expect(await readDeviceStatus(device.id)).toBe('offline');
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(false);

    // The device is an ordinary agent again — and the safety property is that
    // the cancelled uninstall is NOT deliverable on that ordinary (allowlist-
    // free) path. This is the device-wiping race the shared transaction in
    // POST /devices/:id/restore exists to prevent.
    const beat = await heartbeat(agentApp, device);
    expect(beat.status, await beat.clone().text()).toBe(200);
    expect((await beat.json()) as { commands: unknown[] }).toMatchObject({ commands: [] });

    // And the exemption did not survive: Removed again WITHOUT uninstallAgent,
    // the agent is back to today's hard 403.
    expect((await removeDevice(deviceApp, device.id, false)).status).toBe(200);
    const afterSecondRemove = await heartbeat(agentApp, device);
    expect(afterSecondRemove.status).toBe(403);
  });
});

// ===========================================================================
// 3. THE INCIDENT GUARD
// ===========================================================================

/**
 * routes/admin/abuse.ts queues a `self_uninstall` for EVERY device under a
 * suspended partner, in one bulk INSERT with NO status filter and NO
 * provenance — so it stamps reason-less rows onto already-`decommissioned`
 * devices too. If the drain predicate were ever loosened to "decommissioned
 * device + any pending self_uninstall", or the reaper's exemption keyed on
 * anything less than the explicit reason AND an unexpired deadline, then:
 *
 *   - those rows would be held past the 30-minute timeout instead of expiring,
 *   - the already-decommissioned device's agent channel would reopen, and
 *   - un-suspending the partner would deliver a fleet-wide uninstall to a
 *     reinstated customer's machines.
 *
 * This test is the thing that goes red first.
 */
describe('#3986 incident guard — an abuse suspension never becomes a drain', () => {
  it('reaps the fleet uninstalls, keeps the removed device 403d, and delivers zero commands after un-suspend', async () => {
    const tenant = await seedTenant();
    const liveDevice = await seedDevice(tenant.orgId, tenant.siteId, 'online');
    // Already Removed BEFORE the suspension — abuse.ts has no status filter,
    // so it will stamp a reason-less uninstall onto this row too.
    const removedDevice = await seedDevice(tenant.orgId, tenant.siteId, 'decommissioned');

    // Unsuspend only returns a partner to `active` when the full activation
    // gate is satisfied; otherwise it lands on `pending` and the fleet stays
    // locked out, which would make "zero commands claimed" pass vacuously.
    await getTestDb()
      .update(partners)
      .set({ emailVerifiedAt: new Date(), paymentMethodAttachedAt: new Date() })
      .where(eq(partners.id, tenant.partnerId));

    const abuseApp = buildAbuseApp();
    const agentApp = buildAgentApp();

    // --- Suspend -----------------------------------------------------------
    const suspend = await abuseApp.request(
      `/admin/partners/${tenant.partnerId}/suspend-for-abuse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmEmail: tenant.userEmail,
          reason: 'integration test: fleet-wide abuse suspension',
        }),
      },
    );
    // Deliberately NOT a strict 200. suspend-for-abuse returns 500
    // `partial_suspend` when any user's Redis token cutoff fails or
    // revokeAllPartnerOauthArtifacts throws — well under 1% with Redis as a
    // service container, but this guard runs on EVERY PR, and an
    // intermittently-red security test is the kind that gets `.skip`ped. The
    // status code is not the property under test: the DB suspend has committed
    // by this point either way, and the assertions immediately below are the
    // actual contract. (`unsuspend`'s status assertion stays strict — that one
    // is a vacuity control, not incidental.)
    if (suspend.status !== 200) {
      expect(
        ((await suspend.clone().json()) as { error?: string }).error,
        await suspend.clone().text(),
      ).toBe('partial_suspend');
    }

    // The precondition the whole guard rests on: abuse rows carry NO
    // provenance and NO deadline, on BOTH the live and the removed device.
    for (const deviceId of [liveDevice.id, removedDevice.id]) {
      const rows = await readUninstallRows(deviceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('pending');
      expect(rows[0]!.uninstallReasons).toBeNull();
      expect(rows[0]!.deviceRemoveExpiresAt).toBeNull();
    }
    // ...and the already-removed device is NOT draining on the strength of it.
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(removedDevice.id))).toBe(
      false,
    );

    // --- Age past the 30-minute command timeout, then reap ------------------
    await ageCommands([liveDevice.id, removedDevice.id]);
    const reaped = await withSystemDbAccessContext(() => reapStaleDeviceCommands());

    for (const deviceId of [liveDevice.id, removedDevice.id]) {
      const rows = await readUninstallRows(deviceId);
      expect(
        rows[0]!.status,
        'an abuse-queued uninstall must expire normally — it is not drain-exempt',
      ).toBe('failed');
    }
    // Exactly 2: cleanupDatabase TRUNCATEs before every test, so these are the
    // only commands in the database. Asserted AFTER the per-row statuses so a
    // mutant fails on the sentence naming the property, not on arithmetic.
    expect(reaped).toBe(2);

    // --- Un-suspend --------------------------------------------------------
    const unsuspend = await abuseApp.request(
      `/admin/partners/${tenant.partnerId}/unsuspend`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'integration test: wrongly suspended, reinstated' }),
      },
    );
    expect(unsuspend.status, await unsuspend.clone().text()).toBe(200);
    expect((await unsuspend.json()) as { status: string }).toMatchObject({ status: 'active' });
    await invalidateAgentTenantCache([tenant.orgId]);

    const [partnerRow] = await getTestDb()
      .select({ status: partners.status })
      .from(partners)
      .where(eq(partners.id, tenant.partnerId));
    expect(partnerRow!.status).toBe('active');

    // --- The reinstated fleet checks in ------------------------------------
    // The live device authenticates normally (no allowlist narrows this path)
    // and MUST be handed nothing. If the reaper's exemption ever widened, the
    // reason-less uninstall would still be `pending` here and this is where a
    // reinstated customer's machine would receive it.
    const liveBeat = await heartbeat(agentApp, liveDevice);
    expect(liveBeat.status, await liveBeat.clone().text()).toBe(200);
    const liveBody = (await liveBeat.json()) as { commands: unknown[] };
    expect(liveBody.commands, 'a reinstated device must be handed ZERO commands').toEqual([]);

    // The already-removed device stays hard-403d: an abuse-queued row grants
    // no drain, whatever its status.
    const removedBeat = await heartbeat(agentApp, removedDevice);
    expect(removedBeat.status).toBe(403);
  });
});

// ===========================================================================
// 4. Overlap — one row, two owners
// ===========================================================================

async function seedOverlappingRow() {
  const tenant = await seedTenant();
  const device = await seedDevice(tenant.orgId, tenant.siteId, 'online');
  const deviceApp = buildDeviceApp();

  // The tenant starts offboarding FIRST (its drain skips decommissioned
  // devices, so this is the only order that produces a co-owned row).
  await getTestDb()
    .update(organizations)
    .set({ status: 'offboarding', updatedAt: new Date() })
    .where(eq(organizations.id, tenant.orgId));
  await invalidateAgentTenantCache([tenant.orgId]);
  await beginOrganizationOffboarding(tenant.orgId, tenant.userId);

  const tenantOwned = await readUninstallRows(device.id);
  expect(tenantOwned).toHaveLength(1);
  expect(tenantOwned[0]!.uninstallReasons).toEqual(['tenant_offboarding']);

  // ...and THEN the device is individually Removed.
  expect((await removeDevice(deviceApp, device.id, true)).status).toBe(200);

  const merged = await readUninstallRows(device.id);
  expect(merged, 'device-remove must MERGE, never insert a competing row').toHaveLength(1);
  expect(new Set(merged[0]!.uninstallReasons ?? [])).toEqual(
    new Set(['tenant_offboarding', 'device_remove']),
  );
  expect(merged[0]!.deviceRemoveExpiresAt).not.toBeNull();

  return { tenant, device, deviceApp, deadline: merged[0]!.deviceRemoveExpiresAt! };
}

describe('#3986 overlap — a device Removed while its tenant is offboarding', () => {
  it('restore strips ONLY device_remove; the tenant drain still owns and delivers the row', async () => {
    const { tenant, device, deviceApp } = await seedOverlappingRow();

    expect((await restoreDevice(deviceApp, device.id)).status).toBe(200);

    const rows = await readUninstallRows(device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status, 'another owner still needs this delivered').toBe('pending');
    expect(rows[0]!.uninstallReasons).toEqual(['tenant_offboarding']);
    // ...AND the deadline goes with it. The row survives, so the deadline is
    // the only place a released device-remove hold can hide: the earlier
    // `array_remove(...) = '{}'` form cleared it only when NO owner remained,
    // which is never true for a co-owned row. Confirmed against live
    // Postgres before this assertion existed — the deadline was PRESERVED.
    //
    // A left-behind deadline is not cosmetic. The next Remove of this device
    // takes `row.deviceRemoveExpiresAt ?? deadline` and INHERITS the stale
    // one: before it passes the second window is silently shortened, and
    // after it passes `isDeviceUninstallDraining` is false the instant the
    // row is written — agentAuth hard-403s the machine while the API and the
    // audit log both report `uninstallQueued: true`, so that uninstall can
    // never be delivered at all. This assertion is what makes the test's own
    // name ("strips ONLY device_remove") true of the whole row.
    expect(rows[0]!.deviceRemoveExpiresAt, 'the deadline belongs to device_remove and must be released with it').toBeNull();
    // The device half of the exemption is gone even though the row lives on.
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(false);

    // Still genuinely deliverable on the tenant drain's narrowed claim.
    const claimed = await withSystemDbAccessContext(() =>
      claimPendingCommandsForDevice(device.id, 10, 'agent', ['self_uninstall']),
    );
    expect(claimed.map((row) => row.type)).toEqual(['self_uninstall']);
    void tenant;
  });

  it('a tenant abort strips ONLY tenant_offboarding; the device-remove row survives with its deadline intact', async () => {
    const { tenant, device, deadline } = await seedOverlappingRow();
    const agentApp = buildAgentApp();

    await abortOrganizationOffboarding(tenant.orgId);
    // Reactivate the org so the agent is NOT admitted by the tenant drain —
    // otherwise this would prove nothing about the device-remove exemption.
    await getTestDb()
      .update(organizations)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(organizations.id, tenant.orgId));
    await invalidateAgentTenantCache([tenant.orgId]);

    const rows = await readUninstallRows(device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.uninstallReasons).toEqual(['device_remove']);
    expect(
      rows[0]!.deviceRemoveExpiresAt!.getTime(),
      'the tenant path must never write device_remove_expires_at',
    ).toBe(deadline.getTime());

    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(true);

    const beat = await heartbeat(agentApp, device);
    expect(beat.status, await beat.clone().text()).toBe(200);
    const body = (await beat.json()) as { commands: Array<{ type: string }> };
    expect(body.commands.map((cmd) => cmd.type)).toEqual(['self_uninstall']);
  });
});

// ===========================================================================
// 5. Reaper — the exemption arm, exercised live in BOTH directions
// ===========================================================================

const future = () => new Date(Date.now() + 60 * 60 * 1000);
const past = () => new Date(Date.now() - 60 * 1000);

/**
 * Plant a `decommissioned` device carrying one directly-inserted
 * `self_uninstall` row of an exact shape. Direct insert on purpose: the point
 * is the DATABASE's evaluation of a predicate against a given row, not the
 * route that would normally produce it.
 */
async function plantDecommissionedDeviceWithUninstall(opts: {
  uninstallReasons: string[] | null;
  deviceRemoveExpiresAt: Date | null;
  /** 'offboarding' exercises the pre-existing #2774 arm instead of the #3986 one. */
  orgStatus?: 'active' | 'offboarding';
}): Promise<SeededDevice & { orgId: string }> {
  const tenant = await seedTenant();
  if (opts.orgStatus && opts.orgStatus !== 'active') {
    await getTestDb()
      .update(organizations)
      .set({ status: opts.orgStatus, updatedAt: new Date() })
      .where(eq(organizations.id, tenant.orgId));
  }
  const device = await seedDevice(tenant.orgId, tenant.siteId, 'decommissioned');
  await getTestDb().insert(deviceCommands).values({
    deviceId: device.id,
    type: 'self_uninstall',
    payload: { removeConfig: true },
    status: 'pending',
    targetRole: 'agent',
    uninstallReasons: opts.uninstallReasons,
    deviceRemoveExpiresAt: opts.deviceRemoveExpiresAt,
  });
  return { ...device, orgId: tenant.orgId };
}

/**
 * The incident guard above only ever asserts that rows ARE reaped. Nothing
 * there fails if the device-remove exemption arm is deleted outright — the
 * feature's core promise (an OFFLINE machine's uninstall waits out the drain
 * window instead of expiring at 30 minutes) would die silently, caught only by
 * a compiled-SQL unit assertion, which is exactly the class of proof this file
 * exists to supplement.
 *
 * All five shapes are reaped in ONE pass, so this also proves the arm
 * DISCRIMINATES rather than merely exempting or expiring everything:
 *
 *   | uninstall_reasons  | device_remove_expires_at | org status  | outcome |
 *   |--------------------|--------------------------|-------------|---------|
 *   | ['device_remove']  | future                   | active      | HELD    |
 *   | NULL               | NULL                     | offboarding | HELD    |  (#2774 arm)
 *   | NULL               | future                   | active      | reaped  |
 *   | ['device_remove']  | expired                  | active      | reaped  |
 *   | ['device_remove']  | NULL                     | active      | reaped  |
 *
 * The last row is the shape the COALESCE fix newly reaps, and reaping it is
 * correct: `isDeviceUninstallDraining` requires a non-null FUTURE deadline, so
 * that device is hard-403d and could never have collected the row anyway —
 * holding it would have made it immortal for nobody's benefit.
 *
 * This is also what makes SINGLE-clause mutants of the reaper arm detectable
 * live. The incident guard alone cannot see them: drop only the reason clause
 * and abuse rows still have a NULL deadline (still reaped, still green); drop
 * only the deadline clause and they still have NULL reasons (same). Here,
 * dropping the reason clause holds `reasonlessButDated`, and dropping the
 * deadline clause holds `expired` and `nullDeadline`.
 */
describe('#3986 reaper — a genuine device_remove row SURVIVES its window', () => {
  it('holds the device-remove and offboarding rows while expiring every other shape, in one pass', async () => {
    const held = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: ['device_remove'],
      deviceRemoveExpiresAt: future(),
    });
    // The pre-existing #2774 arm, which the COALESCE edit also wrapped — this
    // is its first live positive control.
    const offboarding = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: null,
      deviceRemoveExpiresAt: null,
      orgStatus: 'offboarding',
    });
    const reasonlessButDated = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: null,
      deviceRemoveExpiresAt: future(),
    });
    const expired = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: ['device_remove'],
      deviceRemoveExpiresAt: past(),
    });
    const nullDeadline = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: ['device_remove'],
      deviceRemoveExpiresAt: null,
    });

    const all = [held, offboarding, reasonlessButDated, expired, nullDeadline];
    await ageCommands(all.map((d) => d.id));

    const reaped = await withSystemDbAccessContext(() => reapStaleDeviceCommands());

    const statusOf = async (d: SeededDevice) => (await readUninstallRows(d.id))[0]!.status;

    // Per-row FIRST, aggregate count last: a mutant must fail on the sentence
    // that names the property it broke, not on an arithmetic mismatch that
    // happens to be evaluated earlier.
    expect(
      await statusOf(held),
      'THE feature promise: an offline machine still has its uninstall waiting when it reconnects',
    ).toBe('pending');
    expect(await statusOf(offboarding), '#2774 offboarding drain must still be exempt').toBe(
      'pending',
    );
    expect(await statusOf(reasonlessButDated), 'no provenance -> expires normally').toBe('failed');
    expect(await statusOf(expired), 'past its deadline -> expires normally').toBe('failed');
    expect(await statusOf(nullDeadline), 'no deadline -> expires normally').toBe('failed');

    expect(reaped, 'exactly the three non-exempt rows, and nothing else').toBe(3);
  });
});

// ===========================================================================
// 5. Deny semantics — executed, not argued
// ===========================================================================

/**
 * Each case plants the row directly, because the point is the DATABASE's
 * evaluation of the predicate, not the route that would normally produce the
 * row. The positive control is not optional: without it every negative here
 * could pass for a reason that has nothing to do with the predicate (a broken
 * fixture, a mis-hashed token, a wrong mount path).
 */
describe('#3986 deny semantics — what does NOT drain', () => {
  it('POSITIVE CONTROL: device_remove + an unexpired deadline DOES drain', async () => {
    const device = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: ['device_remove'],
      deviceRemoveExpiresAt: future(),
    });
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(true);
    const beat = await heartbeat(buildAgentApp(), device);
    expect(beat.status, await beat.clone().text()).toBe(200);
  });

  it('uninstall_reasons IS NULL does not drain (NULL @> ARRAY[...] is NULL, not true)', async () => {
    const device = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: null,
      deviceRemoveExpiresAt: future(),
    });
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(false);
    const beat = await heartbeat(buildAgentApp(), device);
    expect(beat.status).toBe(403);
    expect(await beat.text()).toContain('decommissioned');
  });

  it('a DIFFERENT reason does not drain — only device_remove grants the exemption', async () => {
    const device = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: ['tenant_offboarding'],
      deviceRemoveExpiresAt: future(),
    });
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(false);
    const beat = await heartbeat(buildAgentApp(), device);
    expect(beat.status).toBe(403);
  });

  it('an EXPIRED deadline does not drain (strict > against the database clock)', async () => {
    const device = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: ['device_remove'],
      deviceRemoveExpiresAt: past(),
    });
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(false);
    const beat = await heartbeat(buildAgentApp(), device);
    expect(beat.status).toBe(403);
  });

  it('a NULL deadline does not drain either (NULL > now() is NULL)', async () => {
    const device = await plantDecommissionedDeviceWithUninstall({
      uninstallReasons: ['device_remove'],
      deviceRemoveExpiresAt: null,
    });
    expect(await withSystemDbAccessContext(() => isDeviceUninstallDraining(device.id))).toBe(false);
    const beat = await heartbeat(buildAgentApp(), device);
    expect(beat.status).toBe(403);
  });
});
