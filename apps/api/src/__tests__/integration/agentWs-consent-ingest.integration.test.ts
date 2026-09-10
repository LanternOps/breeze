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
 *   2. consent_denied reason=no_user   → status='denied', audit session_consent_bypassed
 *   3. device-ownership guard: a different agent's deviceId → NO write (stays connecting)
 *   4. status guard: an already-active session is NOT flipped to denied
 *   5. grant path: answer + consentReason=user → status='active', audit session_consent_granted
 */
import { describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { devices, remoteSessions, auditLogs } from '../../db/schema';

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

  runDb('consent_denied reason=no_user → status=denied + audit session_consent_bypassed', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, env.partner.id, sessionId, {
      event: 'consent_denied',
      sessionId,
      reason: 'no_user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('denied');
    const actions = await auditActionsFor(sessionId);
    expect(actions).toContain('session_consent_bypassed');
    expect(actions).not.toContain('session_consent_denied');
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
});
