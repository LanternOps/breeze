/**
 * #8318 wave 1b-1 — stale-caller hardening against real PostgreSQL and Redis
 * (spec docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §6.4 "Stale callers", "Live sockets"; §6.5 liveness).
 *
 * A request the previous install authenticated just before a reattach confirm
 * still runs after it. The confirm changes the target row's `agent_id` and
 * advances `install_incarnation`; these tests drive the real routes, claim and
 * result paths with a context that carries the OLD identity / incarnation and
 * prove that:
 *
 *  - every own-row `devices` update matches 0 rows (main beat, watchdog beat,
 *    parked beat, one plain REST route);
 *  - a claim by a caller authenticated under incarnation n never takes a row
 *    stamped n+1, and a result from it is refused on both transports;
 *  - the server push addresses the agent_id read IN the claim;
 *  - the WS lease re-check denies a socket whose device moved org or site;
 *  - F3 re-enroll revokes every hash of the row and refuses (no fresh row)
 *    when the matched row's agent_id changed under it.
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs, deviceCommands, devices, enrollmentKeys } from '../../db/schema';
import type { AgentAuthContext } from '../../middleware/agentAuth';
import { createAgentWsHandlers, isAgentDeviceStillAuthorized } from '../../routes/agentWs';
import { commandsRoutes } from '../../routes/agents/commands';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { heartbeatRoutes } from '../../routes/agents/heartbeat';
import { uninstallIntentRoutes } from '../../routes/agents/uninstallIntent';
import { claimPendingCommandForDelivery, claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { DRAIN_CLAIM_TYPE_ALLOWLIST } from '../../services/drainClaimAllowlist';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { getRedis } from '../../services/redis';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

// ─── Fixtures ──────────────────────────────────────────────────────────────

async function seedOrg(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const rawKey = `stale-${suffix}`;
  await withSystemDbAccessContext(async () => {
    await db.insert(enrollmentKeys).values({
      orgId: org.id, siteId: site.id, name: `Stale ${label}`, key: hashEnrollmentKey(rawKey),
      keySecretHash: null, usageCount: 0, maxUsage: null, expiresAt: null,
    });
  });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, rawKey, suffix };
}
type SeededOrg = Awaited<ReturnType<typeof seedOrg>>;

/** Enroll writes its audit row fire-and-forget; wait for it so a later TRUNCATE never races it. */
async function waitForEnrollAuditCommitted(deviceId: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: auditLogs.id }).from(auditLogs)
        .where(and(eq(auditLogs.action, 'agent.enroll'), eq(auditLogs.resourceId, deviceId))).limit(1),
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`agent.enroll audit row for device ${deviceId} never became visible (10s)`);
}

function enrollApp(): Hono {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  return app;
}

function enrollBody(org: SeededOrg, hostname: string) {
  return {
    enrollmentKey: org.rawKey, hostname, osType: 'windows',
    osVersion: 'Integration Windows', architecture: 'amd64', agentVersion: '1.0.0-test',
  };
}

async function enrollDevice(org: SeededOrg, label: string) {
  const hostname = `${label}-${org.suffix}`;
  const response = await enrollApp().request('/agents/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(enrollBody(org, hostname)),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as {
    deviceId: string; agentId: string; authToken: string; watchdogAuthToken: string; helperAuthToken: string;
  };
  await waitForEnrollAuditCommitted(body.deviceId);
  return { ...body, hostname, orgId: org.orgId, siteId: org.siteId, partnerId: org.partnerId };
}
type EnrolledDevice = Awaited<ReturnType<typeof enrollDevice>>;

function agentContext(device: EnrolledDevice, overrides: Partial<AgentAuthContext> = {}): AgentAuthContext {
  return {
    deviceId: device.deviceId,
    agentId: device.agentId,
    orgId: device.orgId,
    siteId: device.siteId,
    partnerId: device.partnerId,
    installIncarnation: 1,
    role: 'agent',
    isPreAssignment: false,
    authTokenHash: digest(device.authToken),
    ...overrides,
  };
}

/** The real routes under a hand-set agent context (the auth middleware's output), like the retain-state suite. */
function agentApp(ctx: AgentAuthContext, opts: { wrapOrgContext?: boolean } = {}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', ctx);
    if (!opts.wrapOrgContext) return next();
    await withDbAccessContext(
      { scope: 'organization', orgId: ctx.orgId, accessibleOrgIds: [ctx.orgId], accessiblePartnerIds: [], currentPartnerId: ctx.partnerId },
      async () => { await next(); },
    );
  });
  app.route('/agents', heartbeatRoutes);
  app.route('/agents', uninstallIntentRoutes);
  app.route('/agents', commandsRoutes);
  return app;
}

const AGENT_BEAT = { status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false };
const WATCHDOG_BEAT = { status: 'ok', agentVersion: '1.0.0-wd', metricsAvailable: false, role: 'watchdog', watchdogState: 'OK' };

async function deviceRow(deviceId: string) {
  const [row] = await getTestDb().select().from(devices).where(eq(devices.id, deviceId));
  return row!;
}

/** What a reattach confirm does to the target's identity (superuser, no boundary): new agent_id, incarnation n+1. */
async function reattachTarget(deviceId: string): Promise<{ agentId: string }> {
  const agentId = `reattached-${randomUUID()}`;
  await getTestDb().execute(sql`
    UPDATE devices
       SET agent_id = ${agentId},
           install_incarnation = install_incarnation + 1,
           incarnation_started_at = now(),
           last_reattached_at = now()
     WHERE id = ${deviceId}::uuid`);
  return { agentId };
}

async function insertCommand(deviceId: string, values: Partial<typeof deviceCommands.$inferInsert> = {}): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({ deviceId, type: 'refresh_inventory', status: 'pending', targetRole: 'agent', ...values })
    .returning({ id: deviceCommands.id });
  return row!.id;
}

async function commandRow(id: string) {
  const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, id));
  return row!;
}

// ─── 1. Own-row devices updates (§6.4 item 1) ──────────────────────────────

describe('own-row devices updates by a stale credential match 0 rows (#8318 §6.4, item 1)', () => {
  async function freeze(deviceId: string) {
    const frozenAt = new Date('2026-01-01T00:00:00.000Z');
    await getTestDb().update(devices)
      .set({ status: 'offline', lastSeenAt: frozenAt, agentVersion: '0.0.1-frozen', watchdogLastSeen: null, watchdogStatus: null })
      .where(eq(devices.id, deviceId));
    return frozenAt;
  }

  runDb('the main beat: liveness and inventory columns stay as they were; the new identity still writes them', async () => {
    const org = await seedOrg('main-beat');
    const device = await enrollDevice(org, 'main-beat');
    const frozenAt = await freeze(device.deviceId);
    const staleCtx = agentContext(device); // the identity the OLD install authenticated with
    const { agentId: newAgentId } = await reattachTarget(device.deviceId);

    const stale = await agentApp(staleCtx).request(`/agents/${device.agentId}/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(AGENT_BEAT),
    });
    expect(stale.status).toBe(200);
    const afterStale = await deviceRow(device.deviceId);
    expect(afterStale.status).toBe('offline');
    expect(afterStale.lastSeenAt?.toISOString()).toBe(frozenAt.toISOString());
    expect(afterStale.agentVersion).toBe('0.0.1-frozen');

    // Control: the install that now owns the row (its identity + incarnation) is written.
    const fresh = await agentApp(agentContext(device, { agentId: newAgentId, installIncarnation: 2 }))
      .request(`/agents/${newAgentId}/heartbeat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(AGENT_BEAT),
      });
    expect(fresh.status).toBe(200);
    const afterFresh = await deviceRow(device.deviceId);
    expect(afterFresh.status).toBe('online');
    expect(afterFresh.agentVersion).toBe('1.0.0-test');
    expect(afterFresh.lastSeenAt!.getTime()).toBeGreaterThan(frozenAt.getTime());
  });

  runDb('the watchdog beat: the watchdog columns stay untouched', async () => {
    const org = await seedOrg('wd-beat');
    const device = await enrollDevice(org, 'wd-beat');
    await freeze(device.deviceId);
    const staleCtx = agentContext(device, { role: 'watchdog', authTokenHash: digest(device.watchdogAuthToken) });
    const { agentId: newAgentId } = await reattachTarget(device.deviceId);

    const stale = await agentApp(staleCtx).request(`/agents/${device.agentId}/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(WATCHDOG_BEAT),
    });
    expect(stale.status).toBe(200);
    const afterStale = await deviceRow(device.deviceId);
    expect(afterStale.watchdogLastSeen).toBeNull();
    expect(afterStale.watchdogStatus).toBeNull();

    const fresh = await agentApp(agentContext(device, { role: 'watchdog', agentId: newAgentId, installIncarnation: 2 }))
      .request(`/agents/${newAgentId}/heartbeat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(WATCHDOG_BEAT),
      });
    expect(fresh.status).toBe(200);
    const afterFresh = await deviceRow(device.deviceId);
    expect(afterFresh.watchdogLastSeen).not.toBeNull();
    expect(afterFresh.watchdogStatus).toBe('connected');
  });

  runDb('the parked beat: liveness stays as it was', async () => {
    const org = await seedOrg('parked-beat');
    const device = await enrollDevice(org, 'parked-beat');
    const frozenAt = await freeze(device.deviceId);
    const parked = { isPreAssignment: true, claimTypeAllowlist: DRAIN_CLAIM_TYPE_ALLOWLIST } as const;
    const staleCtx = agentContext(device, parked);
    const { agentId: newAgentId } = await reattachTarget(device.deviceId);

    const stale = await agentApp(staleCtx).request(`/agents/${device.agentId}/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(AGENT_BEAT),
    });
    expect(stale.status).toBe(200);
    const afterStale = await deviceRow(device.deviceId);
    expect(afterStale.status).toBe('offline');
    expect(afterStale.lastSeenAt?.toISOString()).toBe(frozenAt.toISOString());

    const fresh = await agentApp(agentContext(device, { ...parked, agentId: newAgentId, installIncarnation: 2 }))
      .request(`/agents/${newAgentId}/heartbeat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(AGENT_BEAT),
      });
    expect(fresh.status).toBe(200);
    expect((await deviceRow(device.deviceId)).status).toBe('online');
  });

  runDb('a plain REST route (uninstall-intent): the stamp is not written', async () => {
    const org = await seedOrg('uninstall-intent');
    const device = await enrollDevice(org, 'uninstall-intent');
    const staleCtx = agentContext(device);
    const { agentId: newAgentId } = await reattachTarget(device.deviceId);

    const stale = await agentApp(staleCtx, { wrapOrgContext: true })
      .request(`/agents/${device.agentId}/uninstall-intent`, { method: 'POST' });
    expect(stale.status).toBe(200);
    expect((await deviceRow(device.deviceId)).uninstallIntentAt).toBeNull();

    const fresh = await agentApp(agentContext(device, { agentId: newAgentId, installIncarnation: 2 }), { wrapOrgContext: true })
      .request(`/agents/${newAgentId}/uninstall-intent`, { method: 'POST' });
    expect(fresh.status).toBe(200);
    expect((await deviceRow(device.deviceId)).uninstallIntentAt).not.toBeNull();
  });
});

// ─── 2. The caller's incarnation on claim and result (§6.4 item 2) ──────────

describe('a caller authenticated under incarnation n after the device moved to n+1 (#8318 §6.4, item 2)', () => {
  async function fixture() {
    const org = await seedOrg('incarnation');
    const device = await enrollDevice(org, 'incarnation');
    await getTestDb().update(devices).set({ status: 'online' }).where(eq(devices.id, device.deviceId));
    return device;
  }

  runDb('its claim takes nothing: a row stamped n+1 stays pending for the new install, a row stamped n is superseded', async () => {
    const device = await fixture();
    const oldRow = await insertCommand(device.deviceId); // stamped 1
    const { agentId: newAgentId } = await reattachTarget(device.deviceId);
    const newRow = await insertCommand(device.deviceId); // stamped 2
    expect((await commandRow(newRow)).deviceIncarnation).toBe(2);

    const staleClaim = await withSystemDbAccessContext(() =>
      claimPendingCommandsForDevice({ deviceId: device.deviceId, installIncarnation: 1 }, 10, 'agent'),
    );
    expect(staleClaim).toEqual([]);
    expect((await commandRow(newRow)).status).toBe('pending');
    expect((await commandRow(oldRow)).result).toMatchObject({ reason: 'superseded_by_reattach' });

    // The new install (authenticated as newAgentId under incarnation 2) gets it.
    const freshClaim = await withSystemDbAccessContext(() =>
      claimPendingCommandsForDevice({ deviceId: device.deviceId, installIncarnation: 2 }, 10, 'agent'),
    );
    expect(freshClaim.map((c) => c.id)).toEqual([newRow]);
    expect(newAgentId).toMatch(/^reattached-/);
  });

  runDb('its REST result for a row stamped n+1 is refused; the new install\'s is recorded', async () => {
    const device = await fixture();
    const { agentId: newAgentId } = await reattachTarget(device.deviceId);
    const commandId = await insertCommand(device.deviceId, { status: 'sent' });
    const body = JSON.stringify({ status: 'completed', exitCode: 0, stdout: 'hello' });

    const stale = await agentApp(agentContext(device, { installIncarnation: 1 }), { wrapOrgContext: true })
      .request(`/agents/${device.agentId}/commands/${commandId}/result`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
    expect(stale.status).toBe(200);
    expect((await commandRow(commandId)).status).toBe('sent');

    const fresh = await agentApp(agentContext(device, { agentId: newAgentId, installIncarnation: 2 }), { wrapOrgContext: true })
      .request(`/agents/${newAgentId}/commands/${commandId}/result`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
    expect(fresh.status).toBe(200);
    expect((await commandRow(commandId)).status).toBe('completed');
  });

  runDb('its WebSocket result for a row stamped n+1 is refused', async () => {
    const device = await fixture();
    const { agentId: newAgentId } = await reattachTarget(device.deviceId);
    const commandId = await insertCommand(device.deviceId, { status: 'sent' });
    const fakeWs = { send: () => {} } as unknown as Parameters<ReturnType<typeof createAgentWsHandlers>['onMessage']>[1];
    const frame = { data: JSON.stringify({ type: 'command_result', commandId, status: 'completed', exitCode: 0, stdout: 'x' }) } as MessageEvent;

    const staleSocket = createAgentWsHandlers(device.agentId, {
      deviceId: device.deviceId, agentId: device.agentId, orgId: device.orgId, siteId: device.siteId,
      partnerId: device.partnerId, installIncarnation: 1,
    });
    await staleSocket.onOpen({}, fakeWs);
    await staleSocket.onMessage(frame, fakeWs);
    await staleSocket.onClose({}, fakeWs);
    expect((await commandRow(commandId)).status).toBe('sent');

    const freshSocket = createAgentWsHandlers(newAgentId, {
      deviceId: device.deviceId, agentId: newAgentId, orgId: device.orgId, siteId: device.siteId,
      partnerId: device.partnerId, installIncarnation: 2,
    });
    await freshSocket.onOpen({}, fakeWs);
    await freshSocket.onMessage(frame, fakeWs);
    await freshSocket.onClose({}, fakeWs);
    expect((await commandRow(commandId)).status).toBe('completed');
  });

  runDb('the server push addresses the agent_id read in the claim, not one read before it', async () => {
    const device = await fixture();
    const commandId = await insertCommand(device.deviceId);
    // A reattach between the enqueue-time device read and the claim.
    const { agentId: newAgentId } = await reattachTarget(device.deviceId);
    // The row was stamped 1 and the device is now 2: refused (cancelled), not pushed anywhere.
    expect(await claimPendingCommandForDelivery(commandId)).toMatchObject({ status: 'cancelled', reason: 'superseded_by_reattach' });

    const current = await insertCommand(device.deviceId);
    const claimed = await claimPendingCommandForDelivery(current);
    expect(claimed).toMatchObject({ status: 'claimed', id: current, agentId: newAgentId });
  });
});

// ─── 3. WS lease identity comparison (F5) ──────────────────────────────────

describe('the WS lease re-check compares the row identity with the socket (#8318 §6.4 "Live sockets", F5)', () => {
  runDb('denies a socket whose device moved site or org, or whose cached partner differs', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const agentId = `ws-identity-${randomUUID()}`;
    const tokenHash = digest('brz_ws_identity');
    const [row] = await getTestDb().insert(devices).values({
      orgId: org.id, siteId: site.id, agentId, agentTokenHash: tokenHash,
      hostname: `ws-identity-${randomUUID()}`, osType: 'linux', osVersion: 'test', architecture: 'amd64',
      agentVersion: '0.0.0-test', status: 'online',
    }).returning({ id: devices.id });
    const cached = { deviceId: row!.id, orgId: org.id, siteId: site.id, partnerId: partner.id };

    expect(await isAgentDeviceStillAuthorized(agentId, tokenHash, cached)).toBe('authorized');

    // Site moved under the socket.
    const otherSite = await createSite({ orgId: org.id });
    await getTestDb().update(devices).set({ siteId: otherSite.id }).where(eq(devices.id, row!.id));
    expect(await isAgentDeviceStillAuthorized(agentId, tokenHash, cached)).toBe('denied');
    await getTestDb().update(devices).set({ siteId: site.id }).where(eq(devices.id, row!.id));
    expect(await isAgentDeviceStillAuthorized(agentId, tokenHash, cached)).toBe('authorized');

    // Org moved under the socket (same partner).
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const otherOrgSite = await createSite({ orgId: otherOrg.id });
    await getTestDb().update(devices).set({ orgId: otherOrg.id, siteId: otherOrgSite.id }).where(eq(devices.id, row!.id));
    expect(await isAgentDeviceStillAuthorized(agentId, tokenHash, cached)).toBe('denied');
    // A socket that cached the NEW identity is fine.
    expect(await isAgentDeviceStillAuthorized(agentId, tokenHash, { ...cached, orgId: otherOrg.id, siteId: otherOrgSite.id })).toBe('authorized');
    // ...unless its cached partner is not the org's.
    expect(await isAgentDeviceStillAuthorized(agentId, tokenHash, { ...cached, orgId: otherOrg.id, siteId: otherOrgSite.id, partnerId: randomUUID() })).toBe('denied');

    // Without an identity the lifecycle/credential re-check still answers on its own (the #8838 seam).
    expect(await isAgentDeviceStillAuthorized(agentId, tokenHash)).toBe('authorized');
  });
});

// ─── 4. F3 re-enroll: every hash revoked, refused when the row moved ───────

describe('token-authenticated re-enroll (F3) under #8318 §6.4', () => {
  runDb('publishes revocation for every hash of the matched row: agent, watchdog, helper; current, previous, pending', async () => {
    const org = await seedOrg('reenroll-revoke');
    const device = await enrollDevice(org, 'reenroll-revoke');
    const extra = {
      previousTokenHash: digest('prev-agent'), previousTokenExpiresAt: new Date(Date.now() + 60_000),
      pendingTokenHash: digest('pending-agent'), pendingTokenExpiresAt: new Date(Date.now() + 60_000),
      previousWatchdogTokenHash: digest('prev-wd'), previousWatchdogTokenExpiresAt: new Date(Date.now() + 60_000),
      pendingWatchdogTokenHash: digest('pending-wd'),
      previousHelperTokenHash: digest('prev-helper'), previousHelperTokenExpiresAt: new Date(Date.now() + 60_000),
      pendingHelperTokenHash: digest('pending-helper'),
    };
    await getTestDb().update(devices).set(extra).where(eq(devices.id, device.deviceId));
    const expectedHashes = [
      digest(device.authToken), digest(device.watchdogAuthToken), digest(device.helperAuthToken),
      extra.previousTokenHash, extra.pendingTokenHash,
      extra.previousWatchdogTokenHash, extra.pendingWatchdogTokenHash,
      extra.previousHelperTokenHash, extra.pendingHelperTokenHash,
    ];

    const redis = getRedis();
    if (!redis) throw new Error('Redis is required for this integration test');
    const subscriber = redis.duplicate({ connectionName: 'reattach-reenroll-revocation' });
    const received = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('revocation broadcast timed out')), 5_000);
      subscriber.on('message', (channel, message) => {
        if (channel !== 'agent-credential:revoked') return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    try {
      await subscriber.subscribe('agent-credential:revoked');
      const response = await enrollApp().request('/agents/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-reenrollment-token': device.authToken },
        body: JSON.stringify(enrollBody(org, device.hostname)),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { deviceId: string; agentId: string };
      expect(body.deviceId).toBe(device.deviceId); // the same row, rewritten in place
      expect(body.agentId).not.toBe(device.agentId);

      const message = JSON.parse(await received) as { agentId: string; revokedTokenHashes: string[] };
      expect(message.agentId).toBe(device.agentId);
      expect([...message.revokedTokenHashes].sort()).toEqual([...expectedHashes].sort());
    } finally {
      await subscriber.quit();
    }
  });

  runDb('refuses with 409 reenrollment_conflict, minting no fresh row, when the matched row\'s agent_id changed under it', async () => {
    const org = await seedOrg('reenroll-race');
    const device = await enrollDevice(org, 'reenroll-race');
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      let releaseHolder!: () => void;
      const holderMayCommit = new Promise<void>((resolve) => { releaseHolder = resolve; });
      let lockHeld!: () => void;
      const lockTaken = new Promise<void>((resolve) => { lockHeld = resolve; });
      const takenOver = `taken-over-${randomUUID()}`;

      // The "confirm": holds the row, then hands it to a new install and commits.
      const confirm = holder.begin(async (tx) => {
        await tx`SELECT id FROM devices WHERE id = ${device.deviceId}::uuid FOR UPDATE`;
        lockHeld();
        await holderMayCommit;
        await tx`UPDATE devices SET agent_id = ${takenOver} WHERE id = ${device.deviceId}::uuid`;
      });
      await lockTaken;

      // The re-enroll matched the row (no lock) and now blocks on its UPDATE.
      const reenroll = enrollApp().request('/agents/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-reenrollment-token': device.authToken },
        body: JSON.stringify(enrollBody(org, device.hostname)),
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [blocked] = await getTestDb().execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query ILIKE '%update "devices"%'`);
        if ((blocked?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error('the re-enroll never blocked on the device row');
        await new Promise((r) => setTimeout(r, 25));
      }
      releaseHolder();
      await confirm;

      const response = await reenroll;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'reenrollment_conflict' });

      // Nothing was minted: one row under the hostname, and it belongs to the new install.
      const rows = await getTestDb().select({ id: devices.id, agentId: devices.agentId }).from(devices)
        .where(and(eq(devices.hostname, device.hostname), eq(devices.orgId, org.orgId)));
      expect(rows).toEqual([{ id: device.deviceId, agentId: takenOver }]);
    } finally {
      await holder.end({ timeout: 5 });
    }
  });
});
