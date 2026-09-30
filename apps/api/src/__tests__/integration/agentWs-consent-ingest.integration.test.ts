/**
 * Integration test — agent WS consent ingestion (the REAL transport).
 *
 * The Go agent reports its desktop consent verdict over the WebSocket
 * command-result fast-path (`desk-start-<sessionId>-<generation>` results).
 * The user-authenticated compatibility verdict routes are retired. This WS path
 * (`agentWs.ts` createAgentWsHandlers → onMessage) carries DB semantics the deny
 * uses a device/generation/state-scoped UPDATE, viewer-token
 * revocation, and a `consentReason: 'user'` grant-audit branch.
 *
 * This drives the real onMessage handler against the test DB as the
 * unprivileged breeze_app role (the handler runs its writes under the agent's
 * org-scoped withDbAccessContext), covering what the unit-mocked agentWs.test.ts
 * and the deny-route integration test cannot:
 *   1. consent_denied reason=user      → status='denied', audit session_consent_denied
 *   2. consent_denied reason=no_user|helper_absent → status='denied', audit
 *      session_consent_blocked_unavailable; reason=timeout → audit
 *      session_consent_blocked_unanswered (a refused start is never
 *      audited as session_consent_bypassed)
 *   3. device-ownership guard: a different agent's deviceId → NO write (stays connecting)
 *   4. status guard: an already-active session is NOT flipped to denied
 *   5. grant path: answer + consentReason=user → status='active', audit session_consent_granted
 *   6. unavailable-proceed path (#6819): answer + consentReason=helper_absent|timeout
 *      activates ONLY when the start bound consentUnavailableBehavior='proceed',
 *      and is audited session_consent_bypassed with the true reason — never as
 *      a user grant
 *   7. WebSocket fallback: the stream start's result carries the screen size
 *      instead of an answer; it activates the same exact connecting start
 *      under the same consent predicate, and its denial finalizes 'denied'
 */
import { describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { devices, remoteSessions, auditLogs } from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';
import { commitDesktopTerminalIntent } from '../../services/remoteDesktopTerminalIntent';

const runDb = it.runIf(!!process.env.DATABASE_URL);
// Combined validation exercises live credential admission before consent sinks.
const CREDENTIAL_HASH = createHash('sha256').update('synthetic-consent-agent').digest('hex');
const START_GENERATION = '22222222-2222-4222-8222-222222222222';

function startCommandId(sessionId: string, generation = START_GENERATION): string {
  return `desk-start-${sessionId}-${generation}`;
}

/** Minimal WSContext stand-in — the consent path only ever calls ws.send(). */
const fakeWs = { send: () => {}, close: () => {} } as unknown as Parameters<ReturnType<typeof createAgentWsHandlers>['onMessage']>[1];

/** Drive the real onMessage handler with a desk-start command_result. */
async function sendDeskStartResult(
  agentId: string,
  deviceId: string,
  orgId: string,
  partnerId: string,
  sessionId: string,
  result: Record<string, unknown>,
  status: 'completed' | 'failed' = 'completed',
  generation = START_GENERATION,
): Promise<void> {
  const handlers = createAgentWsHandlers(agentId, { deviceId, orgId, partnerId, credentialTokenHash: CREDENTIAL_HASH });
  const event = {
    data: JSON.stringify({
      type: 'command_result',
      commandId: startCommandId(sessionId, generation),
      status,
      result,
    }),
  } as MessageEvent;
  // A desk-start result only carries teardown/consent authority on the
  // agent's CURRENT socket (delivery-epoch proof) — register it first, as
  // the real transport does on connect.
  await handlers.onOpen({}, fakeWs);
  await handlers.onMessage(event, fakeWs);
  // Close the lease so the per-socket ping interval doesn't outlive the test.
  await handlers.onClose({}, fakeWs);
}

async function insertDevice(orgId: string, siteId: string): Promise<{ id: string; agentId: string }> {
  const tdb = getTestDb();
  const agentId = `agent-ws-consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId,
      agentTokenHash: CREDENTIAL_HASH,
      hostname: `ws-consent-${agentId}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice: no row');
  return { id: row.id, agentId };
}

async function insertSession(opts: {
  deviceId: string;
  orgId: string;
  userId: string;
  status?: 'connecting' | 'active';
  promptMode?: 'off' | 'notify' | 'consent';
  consentUnavailableBehavior?: 'proceed' | 'block' | null;
}): Promise<string> {
  const tdb = getTestDb();
  const sessionId = randomUUID();
  const [row] = await tdb
    .insert(remoteSessions)
    .values({
      id: sessionId,
      deviceId: opts.deviceId,
      orgId: opts.orgId,
      userId: opts.userId,
      type: 'desktop',
      status: opts.status ?? 'connecting',
      desktopStartCommandId: startCommandId(sessionId),
      desktopPromptMode: opts.promptMode ?? 'consent',
      desktopConsentUnavailableBehavior: opts.consentUnavailableBehavior === undefined
        ? 'block'
        : opts.consentUnavailableBehavior,
      iceCandidates: [],
    })
    .returning({ id: remoteSessions.id });
  if (!row) throw new Error('insertSession: no row');
  return row.id;
}

async function readSessionStatus(sessionId: string): Promise<{
  status: string;
  endedAt: Date | null;
  startedAt: Date | null;
  webrtcAnswer: string | null;
  errorMessage: string | null;
}> {
  const tdb = getTestDb();
  const [row] = await tdb
    .select({
      status: remoteSessions.status,
      endedAt: remoteSessions.endedAt,
      startedAt: remoteSessions.startedAt,
      webrtcAnswer: remoteSessions.webrtcAnswer,
      errorMessage: remoteSessions.errorMessage,
    })
    .from(remoteSessions)
    .where(eq(remoteSessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error('session not found');
  return row;
}

async function auditActionsFor(sessionId: string): Promise<string[]> {
  const tdb = getTestDb();
  const rows = await tdb
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.resourceId, sessionId), eq(auditLogs.resourceType, 'remote_session')));
  return rows.map((r) => r.action);
}

async function consentAuditFor(sessionId: string, action: string) {
  const [row] = await getTestDb().select({
    actorType: auditLogs.actorType,
    actorId: auditLogs.actorId,
    details: auditLogs.details,
  }).from(auditLogs).where(and(
    eq(auditLogs.resourceId, sessionId),
    eq(auditLogs.action, action),
  ));
  return row;
}

describe('agentWs consent ingestion (real onMessage, breeze_app)', () => {
  runDb('consent_denied reason=user → status=denied + audit session_consent_denied', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      event: 'consent_denied',
      sessionId,
      reason: 'user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('denied');
    expect(row.endedAt).not.toBeNull();
    // #6818: the reason is recorded so the viewer's answer poll can show it.
    expect(row.errorMessage).toBe('The user on the remote device declined the connection.');
    expect(await auditActionsFor(sessionId)).toContain('session_consent_denied');
    expect(await consentAuditFor(sessionId, 'session_consent_denied')).toMatchObject({
      actorType: 'agent',
      actorId: dev.id,
      details: expect.objectContaining({
        deviceId: dev.id,
        sessionOwnerId: env.user.id,
        startCommandId: startCommandId(sessionId),
        promptMode: 'consent',
        reportedBy: 'authenticated_agent',
      }),
    });
  });

  for (const [reason, action] of [
    ['no_user', 'session_consent_blocked_unavailable'],
    ['helper_absent', 'session_consent_blocked_unavailable'],
    ['timeout', 'session_consent_blocked_unanswered'],
  ] as const) {
    runDb(`consent_denied reason=${reason} → status=denied + audit ${action}, not session_consent_bypassed`, async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const dev = await insertDevice(env.organization.id, env.site.id);
      const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

      await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
        event: 'consent_denied',
        sessionId,
        reason,
      });

      const row = await readSessionStatus(sessionId);
      expect(row.status).toBe('denied');
      const actions = await auditActionsFor(sessionId);
      expect(actions).toContain(action);
      expect(actions).not.toContain('session_consent_bypassed');
      expect(actions).not.toContain('session_consent_denied');
      expect(await consentAuditFor(sessionId, action)).toMatchObject({
        actorType: 'agent',
        details: expect.objectContaining({ reason, promptMode: 'consent' }),
      });
    });
  }

  // Version 2 agents (consentPromptProtocolVersion 2) split "nobody is signed
  // in to the captured session" from "someone is signed in but the prompt
  // could not be shown to them", and say whether the prompt was presented.
  // The server records both truthfully and accepts them alongside version 1.
  for (const [reason, outcome, occupancy, message] of [
    ['no_user_session', 'unavailable', 'unoccupied', /no one is signed in/i],
    ['helper_unreachable', 'unavailable', 'occupied', /could not be shown/],
  ] as const) {
    runDb(`v2 consent_denied reason=${reason} → denied + session_consent_blocked_unavailable with the structured outcome`, async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const dev = await insertDevice(env.organization.id, env.site.id);
      const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

      await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
        event: 'consent_denied',
        sessionId,
        reason,
        consentOutcome: outcome,
        consentOccupancy: occupancy,
        consentProtocol: 2,
      });

      const row = await readSessionStatus(sessionId);
      expect(row.status).toBe('denied');
      expect(row.errorMessage).toMatch(message);
      const actions = await auditActionsFor(sessionId);
      expect(actions).toContain('session_consent_blocked_unavailable');
      expect(actions).not.toContain('session_consent_bypassed');
      expect(await consentAuditFor(sessionId, 'session_consent_blocked_unavailable')).toMatchObject({
        actorType: 'agent',
        details: expect.objectContaining({
          reason,
          consentOutcome: outcome,
          consentOccupancy: occupancy,
          consentProtocol: 2,
          promptMode: 'consent',
        }),
      });
    });
  }

  runDb('v1 consent_denied records consentProtocol 1 in the audit', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      event: 'consent_denied',
      sessionId,
      reason: 'helper_absent',
    });

    expect(await consentAuditFor(sessionId, 'session_consent_blocked_unavailable')).toMatchObject({
      details: expect.objectContaining({ reason: 'helper_absent', consentProtocol: 1 }),
    });
  });

  runDb('v2 answer + consentReason=no_user_session under a proceed fallback → active + session_consent_bypassed', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId: dev.id,
      orgId: env.organization.id,
      userId: env.user.id,
      consentUnavailableBehavior: 'proceed',
    });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
      consentReason: 'no_user_session',
      consentOutcome: 'unavailable',
      consentOccupancy: 'unoccupied',
      consentProtocol: 2,
    });

    expect((await readSessionStatus(sessionId)).status).toBe('active');
    const actions = await auditActionsFor(sessionId);
    expect(actions).not.toContain('session_consent_granted');
    expect(await consentAuditFor(sessionId, 'session_consent_bypassed')).toMatchObject({
      details: expect.objectContaining({
        reason: 'no_user_session',
        outcome: 'proceeded',
        consentOutcome: 'unavailable',
        consentOccupancy: 'unoccupied',
        consentProtocol: 2,
        consentUnavailableBehavior: 'proceed',
      }),
    });
  });

  runDb('v2 answer + consentReason=no_user_session under a block fallback fails closed', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId: dev.id,
      orgId: env.organization.id,
      userId: env.user.id,
      consentUnavailableBehavior: 'block',
    });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
      consentReason: 'no_user_session',
      consentOutcome: 'unavailable',
      consentOccupancy: 'unoccupied',
      consentProtocol: 2,
    });

    expect(await readSessionStatus(sessionId)).toMatchObject({ status: 'connecting', webrtcAnswer: null });
    expect(await auditActionsFor(sessionId)).toEqual([]);
  });

  runDb('an answer claiming helper_unreachable never activates, even under a proceed fallback', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId: dev.id,
      orgId: env.organization.id,
      userId: env.user.id,
      consentUnavailableBehavior: 'proceed',
    });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
      consentReason: 'helper_unreachable',
      consentProtocol: 2,
    });

    // Not a result this server accepts: the start fails instead of activating.
    expect(await readSessionStatus(sessionId)).toMatchObject({ status: 'failed', webrtcAnswer: null });
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_bypassed');
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_granted');
  });

  runDb('v2 grant and v2 presented-and-expired bypass carry the structured outcome in the audit', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const granted = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });
    const expired = await insertSession({
      deviceId: dev.id,
      orgId: env.organization.id,
      userId: env.user.id,
      consentUnavailableBehavior: 'proceed',
    });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, granted, {
      sessionId: granted,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
      consentReason: 'user',
      consentOutcome: 'granted',
      consentProtocol: 2,
    });
    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, expired, {
      sessionId: expired,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
      consentReason: 'timeout',
      consentOutcome: 'presented_expired',
      consentProtocol: 2,
    });

    expect((await readSessionStatus(granted)).status).toBe('active');
    expect(await consentAuditFor(granted, 'session_consent_granted')).toMatchObject({
      details: expect.objectContaining({ reason: 'user', consentOutcome: 'granted', consentProtocol: 2 }),
    });
    expect((await readSessionStatus(expired)).status).toBe('active');
    expect(await consentAuditFor(expired, 'session_consent_bypassed')).toMatchObject({
      details: expect.objectContaining({ reason: 'timeout', consentOutcome: 'presented_expired', consentProtocol: 2 }),
    });
  });

  // A version 2 marker must be backed by its own outcome: a `user` start
  // needs `granted`, a `timeout` start needs `presented_expired`.
  for (const [consentReason, consentOutcome, behavior] of [
    ['user', 'unknown', 'block'],
    ['timeout', 'unavailable', 'proceed'],
  ] as const) {
    runDb(`v2 answer + consentReason=${consentReason} with outcome ${consentOutcome} does not activate`, async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const dev = await insertDevice(env.organization.id, env.site.id);
      const sessionId = await insertSession({
        deviceId: dev.id,
        orgId: env.organization.id,
        userId: env.user.id,
        consentUnavailableBehavior: behavior,
      });

      await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
        sessionId,
        answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
        consentReason,
        consentOutcome,
        consentProtocol: 2,
      });

      expect(await readSessionStatus(sessionId)).toMatchObject({ status: 'connecting', webrtcAnswer: null });
      expect(await auditActionsFor(sessionId)).toEqual([]);
    });
  }

  // A start result the server cannot read (it fails the result schema) used to
  // be dropped, leaving the session `connecting` until the viewer gave up. When
  // its command id still names the start, the session is failed with a reason.
  runDb('an unreadable desk-start result fails its session with a clear message', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
      consentReason: 'user',
      somethingThisServerDoesNotKnow: true,
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('failed');
    expect(row.webrtcAnswer).toBeNull();
    expect(row.errorMessage).toMatch(/could not be read/);
  });

  runDb('an unreadable desk-start result for another device\'s session changes nothing', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const owner = await insertDevice(env.organization.id, env.site.id);
    const other = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: owner.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(other.agentId, other.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      somethingThisServerDoesNotKnow: true,
    });

    expect(await readSessionStatus(sessionId)).toMatchObject({ status: 'connecting', errorMessage: null });
  });

  // Device-ownership guard: a session owned by device A cannot be denied by
  // device B's agent (same org, so RLS lets the row be seen — the deviceId
  // predicate in the UPDATE is the load-bearing isolation control).
  runDb('a different device cannot deny another device\'s session (ownership guard)', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const devA = await insertDevice(env.organization.id, env.site.id);
    const devB = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: devA.id, orgId: env.organization.id, userId: env.user.id });

    // devB's agent reports a denial for devA's session.
    await sendDeskStartResult(devB.agentId, devB.id, env.organization.id, env.partner.id, sessionId, {
      event: 'consent_denied',
      sessionId,
      reason: 'user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('connecting'); // untouched
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_denied');
  });

  // Status guard: a session already 'active' must not be flipped to denied by a
  // late verdict (the UPDATE filters on status='connecting').
  runDb('an already-active session is not flipped to denied (status guard)', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id, status: 'active' });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      event: 'consent_denied',
      sessionId,
      reason: 'user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('active'); // untouched
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_denied');
  });

  runDb('a superseded desktop-start generation cannot decide the session', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });
    const handlers = createAgentWsHandlers(dev.agentId, {
      deviceId: dev.id,
      orgId: env.organization.id,
      partnerId: env.partner.id,
      credentialTokenHash: CREDENTIAL_HASH,
    });
    await handlers.onOpen({}, fakeWs);
    await handlers.onMessage({
      data: JSON.stringify({
        type: 'command_result',
        commandId: startCommandId(sessionId, '33333333-3333-4333-8333-333333333333'),
        status: 'completed',
        result: { event: 'consent_denied', sessionId, reason: 'user' },
      }),
    } as MessageEvent, fakeWs);
    await handlers.onClose({}, fakeWs);

    expect((await readSessionStatus(sessionId)).status).toBe('connecting');
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_denied');
  });

  // Grant path: a successful start carrying consentReason='user' activates the
  // session and emits session_consent_granted.
  runDb('answer + consentReason=user → status=active + audit session_consent_granted', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n', // minimal SDP-ish string
      consentReason: 'user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('active');
    expect(row.startedAt).not.toBeNull();
    expect(await auditActionsFor(sessionId)).toContain('session_consent_granted');
    expect(await consentAuditFor(sessionId, 'session_consent_granted')).toMatchObject({
      actorType: 'agent',
      actorId: dev.id,
    });
  });

  for (const reason of ['helper_absent', 'timeout'] as const) {
    runDb(`answer + consentReason=${reason} under a proceed fallback → active + audit session_consent_bypassed (not granted)`, async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const dev = await insertDevice(env.organization.id, env.site.id);
      const sessionId = await insertSession({
        deviceId: dev.id,
        orgId: env.organization.id,
        userId: env.user.id,
        consentUnavailableBehavior: 'proceed',
      });

      await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
        sessionId,
        answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
        consentReason: reason,
      });

      expect((await readSessionStatus(sessionId)).status).toBe('active');
      const actions = await auditActionsFor(sessionId);
      expect(actions).not.toContain('session_consent_granted');
      expect(actions).toContain('session_consent_bypassed');
      expect(await consentAuditFor(sessionId, 'session_consent_bypassed')).toMatchObject({
        actorType: 'agent',
        actorId: dev.id,
        details: expect.objectContaining({
          reason,
          outcome: 'proceeded',
          consentUnavailableBehavior: 'proceed',
          promptMode: 'consent',
          startCommandId: startCommandId(sessionId),
          reportedBy: 'authenticated_agent',
        }),
      });
    });

    runDb(`answer + consentReason=${reason} under a block fallback fails closed`, async () => {
      const env = await setupTestEnvironment({ scope: 'organization' });
      const dev = await insertDevice(env.organization.id, env.site.id);
      const sessionId = await insertSession({
        deviceId: dev.id,
        orgId: env.organization.id,
        userId: env.user.id,
        consentUnavailableBehavior: 'block',
      });

      await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
        sessionId,
        answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
        consentReason: reason,
      });

      expect(await readSessionStatus(sessionId)).toMatchObject({ status: 'connecting', webrtcAnswer: null });
      expect(await auditActionsFor(sessionId)).toEqual([]);
    });
  }

  runDb('answer + consentReason=timeout on a row with no bound fallback (pre-#6819 start) fails closed', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId: dev.id,
      orgId: env.organization.id,
      userId: env.user.id,
      consentUnavailableBehavior: null,
    });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
      consentReason: 'timeout',
    });

    expect((await readSessionStatus(sessionId)).status).toBe('connecting');
    expect(await auditActionsFor(sessionId)).toEqual([]);
  });

  runDb('an explicit user grant activates regardless of the bound fallback (older agents send only "user")', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId: dev.id,
      orgId: env.organization.id,
      userId: env.user.id,
      consentUnavailableBehavior: null,
    });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
      consentReason: 'user',
    });

    expect((await readSessionStatus(sessionId)).status).toBe('active');
    expect(await consentAuditFor(sessionId, 'session_consent_granted')).toMatchObject({
      details: expect.objectContaining({ reason: 'user' }),
    });
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_bypassed');
  });

  runDb('consent-mode answer without the explicit grant marker fails closed', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
    });

    expect((await readSessionStatus(sessionId)).status).toBe('connecting');
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_granted');
  });

  runDb('notify-mode answer activates without fabricating a consent grant', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId: dev.id,
      orgId: env.organization.id,
      userId: env.user.id,
      promptMode: 'notify',
    });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n',
    });

    expect((await readSessionStatus(sessionId)).status).toBe('active');
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_granted');
  });

  runDb('a superseded desktop-start generation cannot activate or store an answer', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'stale answer',
      consentReason: 'user',
    }, 'completed', '33333333-3333-4333-8333-333333333333');

    expect(await readSessionStatus(sessionId)).toMatchObject({
      status: 'connecting',
      startedAt: null,
      webrtcAnswer: null,
    });
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_granted');
  });

  runDb('a superseded desktop-start generation cannot fail the current generation', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      error: 'stale capture failure',
    }, 'failed', '33333333-3333-4333-8333-333333333333');

    expect(await readSessionStatus(sessionId)).toMatchObject({
      status: 'connecting',
      endedAt: null,
      errorMessage: null,
    });
  });

  runDb('a different device cannot activate another device\'s session', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const owner = await insertDevice(env.organization.id, env.site.id);
    const other = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: owner.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(other.agentId, other.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      answer: 'wrong-device answer',
      consentReason: 'user',
    });

    expect(await readSessionStatus(sessionId)).toMatchObject({
      status: 'connecting',
      startedAt: null,
      webrtcAnswer: null,
    });
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_granted');
  });

  runDb('a different device cannot fail another device\'s session', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const owner = await insertDevice(env.organization.id, env.site.id);
    const other = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: owner.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(other.agentId, other.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      error: 'wrong-device capture failure',
    }, 'failed');

    expect(await readSessionStatus(sessionId)).toMatchObject({
      status: 'connecting',
      endedAt: null,
      errorMessage: null,
    });
  });
  // WebSocket fallback (desktop_stream_start): the result has no SDP answer,
  // only the captured screen size. Same exact-command, same-consent-predicate
  // activation as the WebRTC answer; before this the result was dropped as
  // malformed and a consent-mode session was marked active before any prompt.
  runDb('stream start + consentReason=user → status=active + audit session_consent_granted', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      screenWidth: 1920,
      screenHeight: 1080,
      consentReason: 'user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('active');
    // startedAt belongs to the start commit (commitDesktopStreamStartIntent),
    // which this fixture skips; activation does not move it.
    expect(row.startedAt).toBeNull();
    expect(row.webrtcAnswer).toBeNull();
    expect(await consentAuditFor(sessionId, 'session_consent_granted')).toMatchObject({
      actorType: 'agent',
      actorId: dev.id,
      // Same structured consent record as the WebRTC answer path.
      details: expect.objectContaining({ startCommandId: startCommandId(sessionId), consentProtocol: 1 }),
    });
  });

  runDb('stream start in consent mode with no consent marker stays connecting (fails closed)', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      screenWidth: 1920,
      screenHeight: 1080,
    });

    expect((await readSessionStatus(sessionId)).status).toBe('connecting');
    expect(await auditActionsFor(sessionId)).toEqual([]);
  });

  runDb('stream start in notify mode activates with no consent audit', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId: dev.id,
      orgId: env.organization.id,
      userId: env.user.id,
      promptMode: 'notify',
      consentUnavailableBehavior: null,
    });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      screenWidth: 1280,
      screenHeight: 720,
    });

    expect((await readSessionStatus(sessionId)).status).toBe('active');
    expect(await auditActionsFor(sessionId)).toEqual([]);
  });

  runDb('stream start result for a different start of the same session activates nothing', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id, promptMode: 'off', consentUnavailableBehavior: null });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      screenWidth: 1280,
      screenHeight: 720,
    }, 'completed', '99999999-9999-4999-8999-999999999999');

    expect((await readSessionStatus(sessionId)).status).toBe('connecting');
  });

  runDb('stream start consent denial → status=denied + audit session_consent_denied', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      event: 'consent_denied',
      reason: 'user',
    });

    expect((await readSessionStatus(sessionId)).status).toBe('denied');
    expect(await auditActionsFor(sessionId)).toContain('session_consent_denied');
  });

  // The relay closes right after a denial and runs its durable finalization,
  // which writes 'failed' through the terminal-intent contract. That write
  // only matches a live row, so the recorded denial survives it.
  runDb('a consent denial survives the relay close that follows it', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      sessionId,
      event: 'consent_denied',
      reason: 'user',
    });
    const closed = await withSystemDbAccessContext(() => commitDesktopTerminalIntent({
      sessionId,
      write: { status: 'failed', endedAt: new Date(), errorMessage: 'setup_failed' },
      phase: 'confirmed',
    }));

    expect(closed.ok).toBe(false);
    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('denied');
    expect(row.errorMessage).toBe('The user on the remote device declined the connection.');
  });
});
