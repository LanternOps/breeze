/**
 * The bounded rebind end to end against real PostgreSQL and Redis (#8318
 * wave 1b, spec docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §6.2–§6.6).
 *
 * Every agent call goes through the REAL agent router at its production mount
 * with real bearer tokens (agent auth, the parked allow-list, the auth-skip
 * set): the signed directive on the heartbeat, phase 1 (`POST /:id/rebind`),
 * the confirm (`POST /:id/rebind-confirm`, confirm-only token), and the new
 * install's first heartbeat. The intent itself is created through the service
 * (no HTTP route creates one in wave 1b).
 *
 * Proven here:
 *   - the happy path: directive (signature verified against the deployment
 *     key) → phase 1 → confirm → the target answers as incarnation n+1 under
 *     the staged credentials; the boundary cancelled the old install's work;
 *     the source is retired with every hash cleared and a `reattached` exit;
 *     ledger, audit in both orgs, the device.reinstalled event; old
 *     credentials of both rows are dead and a stale own-row write matches 0
 *     rows; confirm replays from the intent and, once pruned, from the ledger;
 *   - phase 1 retried with the same set; a different set refused
 *     (restage_refused) and a later confirm 409 `cancelled`, nothing written;
 *   - phase 1 / confirm on expired and cancelled intents (never reopened), a
 *     confirm before staging;
 *   - target revival between phase 1 and confirm (heartbeat, watchdog only,
 *     REST poll only, WS presence) → 409 target_alive, nothing written, the
 *     source keeps working; Redis down → liveness_unknown;
 *   - two confirms racing → one commit; partner_mismatch, source_changed and
 *     requester_revoked at confirm; a decommissioned target restored;
 *   - the routes' own authentication and validation.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceReattachProtocol.integration.test.ts
 */
import './setup';
import { createPublicKey, verify } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  deviceCommands,
  devicePoolAssignmentEvents,
  deviceReattachIntents,
  deviceReattachments,
  devices,
  organizations,
  users,
} from '../../db/schema';
import { __resetAgentAuthNegativeCacheForTests } from '../../middleware/agentAuthNegativeCache';
import { agentRoutes } from '../../routes/agents/index';
import { agentCredentialUseKey } from '../../services/agentCredentialUse';
import { updateOwnDeviceRow } from '../../services/agentOwnDeviceRow';
import { setAgentPresence } from '../../services/agentPresence';
import { confirmRebindIntent } from '../../services/deviceReattach/confirm';
import { canonicalRebindDirectiveBytes, type RebindDirective } from '../../services/deviceReattach/rebindDirective';
import { requestDeviceReattach, cancelReattachIntent } from '../../services/deviceReattach/requestIntent';
import { ensureActiveSigningKey } from '../../services/manifestSigning';
import { getRedis } from '../../services/redis';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  ageIntent,
  parkedSource,
  readDevice,
  readIntent,
  seedAgentDevice,
  seedReattachTenant,
  sha256,
  silentTarget,
  stagedSet,
  useDeploymentSigningKey,
  type ReattachTenant,
  type SeededAgentDevice,
} from './deviceReattachFixtures';
import { getTestDb } from './setup';

// Redis down for one test: every getRedis() caller sees "not configured".
const redisSeam = vi.hoisted(() => ({ down: false }));
vi.mock('../../services/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/redis')>();
  return {
    ...actual,
    getRedis: (...args: Parameters<typeof actual.getRedis>) => (redisSeam.down ? null : actual.getRedis(...args)),
  };
});

const MOUNT = '/api/v1/agents';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function app(): Hono {
  const a = new Hono();
  a.route(MOUNT, agentRoutes);
  return a;
}

async function call(method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const res = await app().request(`${MOUNT}${path}`, init);
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const AGENT_BEAT = { status: 'ok', agentVersion: '0.99.0', metricsAvailable: false };
const REBIND_BEAT = { ...AGENT_BEAT, securityCapabilities: { rebindProtocolVersion: 1 } };
const WATCHDOG_BEAT = { status: 'ok', agentVersion: '0.99.0-wd', metricsAvailable: false, role: 'watchdog', watchdogState: 'OK' };

const heartbeat = (device: Pick<SeededAgentDevice, 'agentId'>, token: string, body: unknown = REBIND_BEAT) =>
  call('POST', `/${device.agentId}/heartbeat`, token, body);
const phase1 = (source: SeededAgentDevice, intentId: string, hashes: ReturnType<typeof stagedSet>['hashes'], token = source.agentToken) =>
  call('POST', `/${source.agentId}/rebind`, token, { intentId, ...hashes });
const confirm = (sourceAgentId: string, confirmationToken: string | null) =>
  call('POST', `/${sourceAgentId}/rebind-confirm`, confirmationToken, {});

async function requestIntent(tenant: ReattachTenant, source: SeededAgentDevice, target: SeededAgentDevice, extra: Partial<Parameters<typeof requestDeviceReattach>[0]> = {}) {
  const result = await requestDeviceReattach({
    actor: { userId: tenant.admin.id },
    sourceDeviceId: source.id,
    targetDeviceId: target.id,
    evidenceLevel: 'hint',
    restoreDecommissioned: false,
    ...extra,
  });
  if (!result.ok) throw new Error(`request refused: ${result.code}`);
  return result.intent;
}

/** A requested intent, a parked rebind-capable source and a silent target in org A. */
async function arrange(options: { targetStatus?: 'decommissioned' } = {}) {
  const tenant = await seedReattachTenant();
  const source = await parkedSource(tenant);
  const target = await silentTarget(tenant.orgA, options.targetStatus ? { status: options.targetStatus } : {});
  const intent = await requestIntent(tenant, source, target, options.targetStatus ? { restoreDecommissioned: true } : {});
  return { tenant, source, target, intent };
}

/** A staged intent (phase 1 done through the route). */
async function arrangeStaged(options: { targetStatus?: 'decommissioned' } = {}) {
  const arranged = await arrange(options);
  const set = stagedSet();
  const staged = await phase1(arranged.source, arranged.intent.id, set.hashes);
  expect(staged.status).toBe(200);
  return { ...arranged, set, staged: staged.body as { stagedAgentId: string; target: { deviceId: string; orgId: string; siteId: string } } };
}

/** The identity columns that must not move when a confirm is refused. */
async function identitySnapshot(deviceId: string) {
  const row = await readDevice(deviceId);
  return {
    agentId: row!.agentId,
    agentTokenHash: row!.agentTokenHash,
    watchdogTokenHash: row!.watchdogTokenHash,
    helperTokenHash: row!.helperTokenHash,
    installIncarnation: row!.installIncarnation,
    status: row!.status,
    orgId: row!.orgId,
  };
}

async function clearCredentialUseMarker(deviceId: string): Promise<void> {
  await getRedis()!.del(agentCredentialUseKey(deviceId));
}

useDeploymentSigningKey();
beforeEach(() => {
  redisSeam.down = false;
});

describe('the bounded rebind, happy path (#8318 §6.1–§6.4)', () => {
  it('directive → phase 1 → confirm → the target answers as incarnation n+1, the old install\'s work is cancelled', async () => {
    const { tenant, source, target, intent } = await arrange();
    const signingKey = await ensureActiveSigningKey();

    // Work queued for the OLD install of the target, open across the confirm.
    const [queued] = await getTestDb().insert(deviceCommands).values({
      deviceId: target.id, type: 'script', payload: { scriptId: 'noop' }, status: 'pending', targetRole: 'agent',
    }).returning({ id: deviceCommands.id });

    // (1) The source's beat carries the signed directive.
    const beat = await heartbeat(source, source.agentToken);
    expect(beat.status).toBe(200);
    const directive = beat.body.rebind as RebindDirective;
    expect(directive).toMatchObject({
      intentId: intent.id,
      targetDeviceId: target.id,
      targetOrgId: tenant.orgA.orgId,
      targetSiteId: tenant.orgA.siteId,
      keyId: signingKey.keyId,
    });
    expect(directive).not.toHaveProperty('sourceAgentId');
    expect(directive.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(directive.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(new Date(directive.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000 + 1000);
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signingKey.publicKeyB64, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    const { signature, ...wire } = directive;
    expect(verify(null, canonicalRebindDirectiveBytes({ ...wire, sourceAgentId: source.agentId }), publicKey, Buffer.from(signature, 'base64'))).toBe(true);
    // The parked beat now carries the pinned keys to verify it against.
    expect(Array.isArray(beat.body.manifestTrustKeys)).toBe(true);
    // A fresh nonce on every response.
    const again = await heartbeat(source, source.agentToken);
    expect(again.body.rebind.nonce).not.toBe(directive.nonce);
    // A beat that does not declare the capability gets no directive.
    expect((await heartbeat(source, source.agentToken, AGENT_BEAT)).body).not.toHaveProperty('rebind');
    expect((await readDevice(source.id))!.rebindProtocolVersion).toBe(0);
    await heartbeat(source, source.agentToken);

    // (2) Phase 1: hashes only; the target's credentials do not change.
    const targetBefore = await identitySnapshot(target.id);
    const set = stagedSet();
    const staged = await phase1(source, intent.id, set.hashes);
    expect(staged.status).toBe(200);
    expect(staged.body).toMatchObject({
      intentId: intent.id,
      target: { deviceId: target.id, orgId: tenant.orgA.orgId, siteId: tenant.orgA.siteId },
      certificate: null,
    });
    expect(staged.body.stagedAgentId).toMatch(/^[0-9a-f]{64}$/);
    const stagedIntent = await readIntent(intent.id);
    expect(stagedIntent).toMatchObject({ state: 'staged', stagedAgentId: staged.body.stagedAgentId, ...set.hashes });
    expect(stagedIntent!.expiresAt.getTime() - stagedIntent!.stagedAt!.getTime()).toBe(15 * 60 * 1000);
    expect(await identitySnapshot(target.id)).toEqual(targetBefore);
    // The staged agent token authenticates nothing before confirm.
    expect((await heartbeat({ agentId: staged.body.stagedAgentId }, set.tokens.agentToken, AGENT_BEAT)).status).toBe(401);
    // That rejection (device_not_found) sits in this process's agent-auth
    // negative cache for up to 60 s (#8050, no explicit invalidation). A real
    // agent only probes with the staged set once its source credentials are
    // rejected, i.e. after confirm; drop it here so the first post-confirm
    // beat below is decided by the database, not by this test's probe.
    __resetAgentAuthNegativeCacheForTests();
    // The directive keeps coming while the intent is staged.
    expect((await heartbeat(source, source.agentToken)).body.rebind.intentId).toBe(intent.id);

    // (3) Confirm, with the confirm-only token.
    const confirmed = await confirm(source.agentId, set.tokens.confirmationToken);
    expect(confirmed.status).toBe(200);
    const identity = { deviceId: target.id, orgId: tenant.orgA.orgId, siteId: tenant.orgA.siteId, agentId: staged.body.stagedAgentId };
    expect(confirmed.body).toEqual(identity);

    // The target: the new install's identity, incarnation 2, pending.
    const targetAfter = await readDevice(target.id);
    expect(targetAfter).toMatchObject({
      agentId: staged.body.stagedAgentId,
      agentTokenHash: set.hashes.stagedTokenHash,
      watchdogTokenHash: set.hashes.stagedWatchdogTokenHash,
      helperTokenHash: set.hashes.stagedHelperTokenHash,
      previousTokenHash: null,
      previousWatchdogTokenHash: null,
      previousHelperTokenHash: null,
      pendingTokenHash: null,
      pendingWatchdogTokenHash: null,
      pendingHelperTokenHash: null,
      installIncarnation: 2,
      status: 'pending',
      rebindProtocolVersion: 1,
      orgId: tenant.orgA.orgId,
    });
    expect(targetAfter!.incarnationStartedAt).toBeInstanceOf(Date);
    expect(targetAfter!.lastReattachedAt).toBeInstanceOf(Date);

    // The boundary ran: the old install's queued work is cancelled.
    const [cmd] = await getTestDb().select({ status: deviceCommands.status })
      .from(deviceCommands).where(eq(deviceCommands.id, queued!.id));
    expect(cmd?.status).toBe('cancelled');

    // The source: retired in place, every hash cleared, the `reattached` exit.
    const sourceAfter = await readDevice(source.id);
    expect(sourceAfter).toMatchObject({
      status: 'decommissioned', agentTokenHash: null, watchdogTokenHash: null, helperTokenHash: null,
      previousTokenHash: null, pendingTokenHash: null,
    });
    const exits = await getTestDb().select().from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.deviceId, source.id));
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      eventType: 'reattached', fromOrgId: tenant.pool.orgId, toOrgId: tenant.orgA.orgId,
      assignedByUserId: tenant.admin.id, assignmentMethod: null, partnerId: tenant.partnerId,
    });
    expect(exits[0]!.parkedDurationSeconds).toBeGreaterThanOrEqual(0);

    // The ledger and the intent.
    const [ledger] = await getTestDb().select().from(deviceReattachments).where(eq(deviceReattachments.intentId, intent.id));
    expect(ledger).toMatchObject({
      sourceDeviceId: source.id, sourceAgentId: source.agentId, sourceOrgId: tenant.pool.orgId, sourceParked: true,
      targetDeviceId: target.id, targetOrgId: tenant.orgA.orgId, targetSiteId: tenant.orgA.siteId,
      targetPreviousAgentId: target.agentId, stagedAgentId: staged.body.stagedAgentId,
      targetPreviousIncarnation: 1, targetNewIncarnation: 2, actorUserId: tenant.admin.id,
      confirmationTokenHash: set.hashes.confirmationTokenHash,
    });
    expect((ledger!.invalidationCounts as Record<string, Record<string, number>>).commands).toBeDefined();
    expect(await readIntent(intent.id)).toMatchObject({
      state: 'confirmed', stagedTokenHash: null, stagedWatchdogTokenHash: null, stagedHelperTokenHash: null,
      confirmationTokenHash: set.hashes.confirmationTokenHash,
    });

    // Audit in both orgs, the requester as actor; the device.reinstalled event.
    const audits = await getTestDb().select({ orgId: auditLogs.orgId, actorId: auditLogs.actorId }).from(auditLogs)
      .where(and(eq(auditLogs.action, 'device.reinstall.reattached'), eq(auditLogs.resourceId, target.id)));
    expect(audits.map((a) => a.orgId).sort()).toEqual([tenant.orgA.orgId, tenant.pool.orgId].sort());
    expect(audits.every((a) => a.actorId === tenant.admin.id)).toBe(true);
    const stream = await getRedis()!.xrange(`breeze:events:${tenant.orgA.orgId}`, '-', '+');
    const events = stream.map(([, fields]) => JSON.parse(fields[1]!) as { type: string; id: string; payload: Record<string, unknown> });
    const reinstalled = events.filter((e) => e.type === 'device.reinstalled');
    expect(reinstalled).toHaveLength(1);
    expect(reinstalled[0]!.id).toBe(ledger!.id);
    expect(reinstalled[0]!.payload).toMatchObject({
      deviceId: target.id, sourceDeviceId: source.id, installIncarnation: 2, previousIncarnation: 1,
      evidenceLevel: 'hint', actorUserId: tenant.admin.id,
    });

    // (4) The new install heartbeats as the target, incarnation 2.
    const newBeat = await heartbeat({ agentId: staged.body.stagedAgentId }, set.tokens.agentToken, REBIND_BEAT);
    expect(newBeat.status).toBe(200);
    expect(newBeat.body).not.toHaveProperty('rebind');
    expect((await readDevice(target.id))!.status).toBe('online');
    expect((await call('GET', `/${staged.body.stagedAgentId}/commands`, set.tokens.agentToken)).body.commands ?? []).toEqual([]);
    // The watchdog of the new install authenticates too.
    expect((await heartbeat({ agentId: staged.body.stagedAgentId }, set.tokens.watchdogToken, WATCHDOG_BEAT)).status).toBe(200);

    // Old credentials of both rows are dead.
    expect((await heartbeat(target, target.agentToken, AGENT_BEAT)).status).toBe(401);
    expect((await heartbeat(source, source.agentToken, AGENT_BEAT)).status).toBe(401);
    // A stale own-row write authenticated under the old agent_id matches 0 rows.
    const stale = await withSystemDbAccessContext(() =>
      updateOwnDeviceRow(db, { deviceId: target.id, agentId: target.agentId }, { lastSeenIp: '203.0.113.9' }));
    expect(stale).toEqual([]);

    // (5) Confirm replay: from the intent, then from the ledger once pruned.
    expect(await confirm(source.agentId, set.tokens.confirmationToken)).toEqual({ status: 200, body: identity });
    await getTestDb().delete(deviceReattachIntents).where(eq(deviceReattachIntents.id, intent.id));
    expect(await confirm(source.agentId, set.tokens.confirmationToken)).toEqual({ status: 200, body: identity });
    // Exactly one ledger row, one incarnation step.
    expect((await readDevice(target.id))!.installIncarnation).toBe(2);
  });

  it('a real-org source is retired without a holding-area exit, and a decommissioned target is restored when asked', async () => {
    const tenant = await seedReattachTenant();
    const source = await seedAgentDevice(tenant.orgB, { rebindProtocolVersion: 1 });
    const target = await silentTarget(tenant.orgA, { status: 'decommissioned' });
    const intent = await requestIntent(tenant, source, target, { restoreDecommissioned: true });
    const set = stagedSet();
    expect((await phase1(source, intent.id, set.hashes)).status).toBe(200);
    expect((await confirm(source.agentId, set.tokens.confirmationToken)).status).toBe(200);
    expect(await readDevice(target.id)).toMatchObject({ status: 'pending', decommissionedAt: null, installIncarnation: 2 });
    expect(await readDevice(source.id)).toMatchObject({ status: 'decommissioned', agentTokenHash: null });
    const exits = await getTestDb().select().from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.deviceId, source.id));
    expect(exits).toEqual([]);
  });
});

describe('phase 1 (#8318 §6.3)', () => {
  it('a retry with the same set is a lost-response retry: the same staged agent id, still staged', async () => {
    const { source, intent, set, staged } = await arrangeStaged();
    const retry = await phase1(source, intent.id, set.hashes);
    expect(retry.status).toBe(200);
    expect(retry.body.stagedAgentId).toBe(staged.stagedAgentId);
    expect(await readIntent(intent.id)).toMatchObject({ state: 'staged', stagedAgentId: staged.stagedAgentId });
  });

  it('a different staged set is refused and cancels the intent (restage_refused); the first set\'s confirm gets 409 cancelled; nothing is written', async () => {
    const { tenant, source, target, intent, set } = await arrangeStaged();
    const sourceBefore = await identitySnapshot(source.id);
    const targetBefore = await identitySnapshot(target.id);

    const second = await phase1(source, intent.id, stagedSet().hashes);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'restage_refused', state: 'cancelled', cancelReason: 'restage_refused' });
    expect(await readIntent(intent.id)).toMatchObject({
      state: 'cancelled', cancelReason: 'restage_refused',
      stagedTokenHash: null, stagedWatchdogTokenHash: null, stagedHelperTokenHash: null,
      confirmationTokenHash: set.hashes.confirmationTokenHash,
    });
    const audits = await getTestDb().select({ details: auditLogs.details }).from(auditLogs)
      .where(and(eq(auditLogs.action, 'device.reinstall.cancelled'), eq(auditLogs.resourceId, target.id)));
    expect(audits.length).toBe(2);
    expect(JSON.stringify(audits[0]!.details)).toMatch(/credentials may have been copied/);

    const late = await confirm(source.agentId, set.tokens.confirmationToken);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'cancelled', state: 'cancelled', cancelReason: 'restage_refused' });
    // Even the first set again is refused now: nothing reopens staging.
    expect((await phase1(source, intent.id, set.hashes)).body).toMatchObject({ code: 'cancelled', state: 'cancelled' });
    expect(await identitySnapshot(source.id)).toEqual(sourceBefore);
    expect(await identitySnapshot(target.id)).toEqual(targetBefore);
    expect(tenant.partnerId).toBeTruthy();
  });

  it('on an expired intent: 409 expired, and the intent is marked expired (never reopens)', async () => {
    const { source, intent } = await arrange();
    await ageIntent(intent.id, 61 * 60 * 1000);
    const res = await phase1(source, intent.id, stagedSet().hashes);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'expired', state: 'expired' });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'expired' });
    expect((await phase1(source, intent.id, stagedSet().hashes)).body).toMatchObject({ code: 'expired' });
  });

  it('on a cancelled intent: 409 cancelled with the reason', async () => {
    const { source, intent } = await arrange();
    await cancelReattachIntent(intent.id, 'admin');
    const res = await phase1(source, intent.id, stagedSet().hashes);
    expect(res).toMatchObject({ status: 409, body: { code: 'cancelled', state: 'cancelled', cancelReason: 'admin' } });
  });

  // Review of wave 1b-2, finding 2: one confirmation token, one intent.
  it('refuses a confirmation token already bound to another intent (409 confirmation_token_reused); a fresh set stages', async () => {
    const first = await arrangeStaged();
    const tenant = first.tenant;
    const source = await parkedSource(tenant);
    const intent = await requestIntent(tenant, source, await silentTarget(tenant.orgA));
    const reused = { ...stagedSet().hashes, confirmationTokenHash: first.set.hashes.confirmationTokenHash };
    expect(await phase1(source, intent.id, reused))
      .toMatchObject({ status: 409, body: { code: 'confirmation_token_reused' } });
    // Nothing staged, nothing cancelled: the agent generates a fresh set.
    expect(await readIntent(intent.id)).toMatchObject({ state: 'requested', confirmationTokenHash: null });
    expect((await phase1(source, intent.id, stagedSet().hashes)).status).toBe(200);
  });

  it('refuses a confirmation token already on a ledger row (a confirmed, pruned intent)', async () => {
    const first = await arrangeStaged();
    expect((await confirm(first.source.agentId, first.set.tokens.confirmationToken)).status).toBe(200);
    await getTestDb().delete(deviceReattachIntents).where(eq(deviceReattachIntents.id, first.intent.id));
    const source = await parkedSource(first.tenant);
    const intent = await requestIntent(first.tenant, source, await silentTarget(first.tenant.orgA));
    const reused = { ...stagedSet().hashes, confirmationTokenHash: first.set.hashes.confirmationTokenHash };
    expect(await phase1(source, intent.id, reused)).toMatchObject({ status: 409, body: { code: 'confirmation_token_reused' } });
    // And the token still resolves to its own ledger row, deterministically.
    expect((await confirm(first.source.agentId, first.set.tokens.confirmationToken)).body.deviceId).toBe(first.target.id);
  });

  it('only the source\'s main agent credential may stage', async () => {
    const { tenant, source, intent } = await arrange();
    const set = stagedSet();
    // The source's watchdog credential.
    expect((await phase1(source, intent.id, set.hashes, source.watchdogToken)).status).toBe(403);
    // Another device's agent (it is not the intent's source).
    const other = await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 });
    const foreign = await call('POST', `/${other.agentId}/rebind`, other.agentToken, { intentId: intent.id, ...set.hashes });
    expect(foreign).toMatchObject({ status: 404, body: { code: 'intent_not_found' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'requested' });
    // No credential at all.
    expect((await phase1(source, intent.id, set.hashes, '')).status).toBe(401);
  });

  it('validates the body: four 64-hex hashes, distinct, none of them the source\'s own', async () => {
    const { source, intent } = await arrange();
    const set = stagedSet();
    expect((await phase1(source, intent.id, { ...set.hashes, stagedTokenHash: 'nothex' })).status).toBe(400);
    const dup = await phase1(source, intent.id, { ...set.hashes, stagedHelperTokenHash: set.hashes.stagedTokenHash });
    expect(dup).toMatchObject({ status: 400, body: { code: 'invalid_staged_set' } });
    const own = await phase1(source, intent.id, { ...set.hashes, stagedTokenHash: sha256(source.agentToken) });
    expect(own).toMatchObject({ status: 400, body: { code: 'invalid_staged_set' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'requested' });
  });
});

describe('rebind-confirm (#8318 §6.4, §6.5)', () => {
  it('authenticates itself: no token, a malformed token, a wrong token or another :id → 401; nothing changes', async () => {
    const { source, target, intent, set } = await arrangeStaged();
    expect((await confirm(source.agentId, null)).status).toBe(401);
    expect((await confirm(source.agentId, 'brz_rbc_short')).status).toBe(401);
    expect((await confirm(source.agentId, source.agentToken)).status).toBe(401);
    expect((await confirm(source.agentId, stagedSet().tokens.confirmationToken)).status).toBe(401);
    expect((await confirm(target.agentId, set.tokens.confirmationToken)).status).toBe(401);
    expect(await readIntent(intent.id)).toMatchObject({ state: 'staged' });
  });

  it('a confirm before phase 1 cannot match (no confirmation hash yet) → 401', async () => {
    const { source, intent } = await arrange();
    expect((await confirm(source.agentId, stagedSet().tokens.confirmationToken)).status).toBe(401);
    expect(await readIntent(intent.id)).toMatchObject({ state: 'requested' });
  });

  it('on an expired staged intent: 409 expired, the staged hashes discarded, never activated', async () => {
    const { source, target, intent, set } = await arrangeStaged();
    const targetBefore = await identitySnapshot(target.id);
    await ageIntent(intent.id, 16 * 60 * 1000);
    const res = await confirm(source.agentId, set.tokens.confirmationToken);
    expect(res).toMatchObject({ status: 409, body: { code: 'expired', state: 'expired' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'expired', stagedTokenHash: null, confirmationTokenHash: set.hashes.confirmationTokenHash });
    expect(await identitySnapshot(target.id)).toEqual(targetBefore);
    // Asked again: the same typed answer, from the intent, before any lock.
    expect((await confirm(source.agentId, set.tokens.confirmationToken)).body).toMatchObject({ code: 'expired' });
  });

  it('on a cancelled intent: 409 cancelled with the reason', async () => {
    const { source, intent, set } = await arrangeStaged();
    await cancelReattachIntent(intent.id, 'admin');
    expect(await confirm(source.agentId, set.tokens.confirmationToken))
      .toMatchObject({ status: 409, body: { code: 'cancelled', cancelReason: 'admin' } });
  });

  describe('target revival between phase 1 and confirm → 409 target_alive, nothing written, the source keeps working', () => {
    async function expectTargetAlive(arranged: Awaited<ReturnType<typeof arrangeStaged>>) {
      const { source, target, intent, set } = arranged;
      const sourceBefore = await identitySnapshot(source.id);
      const targetBefore = await identitySnapshot(target.id);
      const res = await confirm(source.agentId, set.tokens.confirmationToken);
      expect(res).toMatchObject({ status: 409, body: { code: 'target_alive', state: 'cancelled', cancelReason: 'target_alive' } });
      expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'target_alive' });
      expect(await identitySnapshot(source.id)).toEqual(sourceBefore);
      expect(await identitySnapshot(target.id)).toEqual(targetBefore);
      const ledger = await getTestDb().select().from(deviceReattachments).where(eq(deviceReattachments.intentId, intent.id));
      expect(ledger).toEqual([]);
      const beat = await heartbeat(source, source.agentToken);
      expect(beat.status).toBe(200);
      expect(beat.body).not.toHaveProperty('rebind');
    }

    it('the old install heartbeats (last_seen_at alone)', async () => {
      const arranged = await arrangeStaged();
      expect((await heartbeat(arranged.target, arranged.target.agentToken, AGENT_BEAT)).status).toBe(200);
      await clearCredentialUseMarker(arranged.target.id);
      await expectTargetAlive(arranged);
    });

    it('only the old install\'s watchdog beats (watchdog_last_seen alone)', async () => {
      const arranged = await arrangeStaged();
      expect((await heartbeat(arranged.target, arranged.target.watchdogToken, WATCHDOG_BEAT)).status).toBe(200);
      await clearCredentialUseMarker(arranged.target.id);
      expect((await readDevice(arranged.target.id))!.lastSeenAt!.getTime()).toBeLessThan(Date.now() - 60 * 60 * 1000);
      await expectTargetAlive(arranged);
    });

    it('only the old install\'s REST command poll runs (the credential-use marker alone)', async () => {
      const arranged = await arrangeStaged();
      expect((await call('GET', `/${arranged.target.agentId}/commands`, arranged.target.agentToken)).status).toBe(200);
      const row = await readDevice(arranged.target.id);
      expect(row!.lastSeenAt!.getTime()).toBeLessThan(Date.now() - 60 * 60 * 1000);
      expect(row!.watchdogLastSeen).toBeNull();
      await expectTargetAlive(arranged);
    });

    it('the old install holds a live WebSocket (the presence lease)', async () => {
      const arranged = await arrangeStaged();
      await setAgentPresence(arranged.target.agentId, { instanceId: 'test-instance', connectionToken: 'tok' });
      await expectTargetAlive(arranged);
    });
  });

  it('a use inside the 10-minute quiet period counts at confirm even when it predates the request', async () => {
    const { source, target, set } = await arrangeStaged();
    // Recorded as five minutes ago: before the request, inside the quiet period.
    await getTestDb().update(devices).set({ lastSeenAt: new Date(Date.now() - 5 * 60 * 1000) }).where(eq(devices.id, target.id));
    expect(await confirm(source.agentId, set.tokens.confirmationToken)).toMatchObject({ status: 409, body: { code: 'target_alive' } });
  });

  // Review of wave 1b-2, finding 1: the orgs are revalidated at every step.
  it('cancels with org_draining when the target org was suspended after staging (confirm)', async () => {
    const { source, target, intent, set } = await arrangeStaged();
    await getTestDb().update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, target.orgId));
    const targetBefore = await identitySnapshot(target.id);
    expect(await confirm(source.agentId, set.tokens.confirmationToken))
      .toMatchObject({ status: 409, body: { code: 'org_draining', state: 'cancelled', cancelReason: 'org_draining' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'org_draining' });
    expect(await identitySnapshot(target.id)).toEqual(targetBefore);
  });

  it('cancels with org_draining at phase 1 when the target org was soft-deleted after the request', async () => {
    const { tenant, source, intent } = await arrange();
    await getTestDb().update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, tenant.orgA.orgId));
    expect(await phase1(source, intent.id, stagedSet().hashes))
      .toMatchObject({ status: 409, body: { code: 'org_draining', state: 'cancelled' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'org_draining' });
  });

  it('fails closed without Redis: 409 liveness_unknown', async () => {
    const { source, target, intent, set } = await arrangeStaged();
    const targetBefore = await identitySnapshot(target.id);
    redisSeam.down = true;
    try {
      const result = await confirmRebindIntent({
        sourceAgentId: source.agentId,
        token: set.tokens.confirmationToken,
        assertion: { assertionTrusted: false, assertedVerified: false, assertedSerial: null },
      });
      expect(result).toMatchObject({ ok: false, status: 409, code: 'liveness_unknown', state: 'cancelled' });
    } finally {
      redisSeam.down = false;
    }
    expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'liveness_unknown' });
    expect(await identitySnapshot(target.id)).toEqual(targetBefore);
  });

  it('two confirms racing over the same pair: exactly one commits, both answer the confirmed identity', async () => {
    const { source, target, intent, set, staged } = await arrangeStaged();
    const [a, b] = await Promise.all([
      confirm(source.agentId, set.tokens.confirmationToken),
      confirm(source.agentId, set.tokens.confirmationToken),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(a.body.agentId).toBe(staged.stagedAgentId);
    const ledger = await getTestDb().select().from(deviceReattachments).where(eq(deviceReattachments.intentId, intent.id));
    expect(ledger).toHaveLength(1);
    expect((await readDevice(target.id))!.installIncarnation).toBe(2);
  });

  it('refuses with partner_mismatch when an org no longer carries the intent\'s partner (seeded directly)', async () => {
    const { source, target, intent, set } = await arrangeStaged();
    const other = await createPartner();
    // Seeded directly, triggers off: org A now belongs to another partner.
    await getTestDb().transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`UPDATE organizations SET partner_id = ${other.id}::uuid WHERE id = ${target.orgId}::uuid`);
    });
    const targetBefore = await identitySnapshot(target.id);
    expect(await confirm(source.agentId, set.tokens.confirmationToken))
      .toMatchObject({ status: 409, body: { code: 'partner_mismatch', state: 'cancelled' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'partner_mismatch' });
    expect(await identitySnapshot(target.id)).toEqual(targetBefore);
  });

  it('refuses with source_changed when the source was quarantined after staging', async () => {
    const { source, intent, set } = await arrangeStaged();
    await getTestDb().update(devices).set({ status: 'quarantined' }).where(eq(devices.id, source.id));
    expect(await confirm(source.agentId, set.tokens.confirmationToken))
      .toMatchObject({ status: 409, body: { code: 'source_changed' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'source_changed' });
  });

  it('refuses with target_changed when the target moved org after the request', async () => {
    const { tenant, source, target, intent, set } = await arrangeStaged();
    await getTestDb().update(devices).set({ orgId: tenant.orgB.orgId, siteId: tenant.orgB.siteId }).where(eq(devices.id, target.id));
    expect(await confirm(source.agentId, set.tokens.confirmationToken))
      .toMatchObject({ status: 409, body: { code: 'target_changed' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'target_changed' });
  });

  it('refuses with requester_revoked when the requester was disabled after the request', async () => {
    const { tenant, source, intent, set } = await arrangeStaged();
    await getTestDb().update(users).set({ status: 'disabled' }).where(eq(users.id, tenant.admin.id));
    expect(await confirm(source.agentId, set.tokens.confirmationToken))
      .toMatchObject({ status: 409, body: { code: 'requester_revoked' } });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'requester_revoked' });
  });

  it('the directive stops once the intent has ended', async () => {
    const { source, intent } = await arrange();
    expect((await heartbeat(source, source.agentToken)).body.rebind?.intentId).toBe(intent.id);
    await cancelReattachIntent(intent.id, 'admin');
    expect((await heartbeat(source, source.agentToken)).body).not.toHaveProperty('rebind');
  });

  it('a decommissioned target is not restored past the partner device limit (409 device_limit_reached)', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA, { status: 'decommissioned' });
    const intent = await requestIntent(tenant, source, target, { restoreDecommissioned: true });
    const set = stagedSet();
    expect((await phase1(source, intent.id, set.hashes)).status).toBe(200);
    // One licensed device already fills a limit of 1.
    await seedAgentDevice(tenant.orgB);
    await getTestDb().execute(sql`UPDATE partners SET max_devices = 1 WHERE id = ${tenant.partnerId}::uuid`);
    expect(await confirm(source.agentId, set.tokens.confirmationToken))
      .toMatchObject({ status: 409, body: { code: 'device_limit_reached' } });
    expect(await readDevice(target.id)).toMatchObject({ status: 'decommissioned', installIncarnation: 1 });
  });
});

describe('a source in another partner\'s org is never reachable', () => {
  it('a foreign agent cannot stage or confirm an intent of this partner', async () => {
    const { intent, set } = await arrangeStaged();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const foreign = await seedAgentDevice({ orgId: otherOrg.id, siteId: otherSite.id }, { rebindProtocolVersion: 1 });
    expect((await phase1(foreign, intent.id, stagedSet().hashes)).status).toBe(404);
    expect((await confirm(foreign.agentId, set.tokens.confirmationToken)).status).toBe(401);
    expect(await readIntent(intent.id)).toMatchObject({ state: 'staged' });
  });
});
