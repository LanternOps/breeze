/**
 * Integration test — agent WS consent ingestion (the REAL transport).
 *
 * The Go agent reports its desktop consent verdict over the WebSocket
 * command-result fast-path (`desk-start-<sessionId>` results), NOT the operator
 * `POST /remote/sessions/:id/deny` route. That WS path
 * (`agentWs.ts` createAgentWsHandlers → onMessage) carries DB semantics the deny
 * route does not: a device-ownership-scoped UPDATE
 * (`deviceId = agent.deviceId AND status = 'connecting'`), viewer-token
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

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { devices, remoteSessions, auditLogs } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Minimal WSContext stand-in — the consent path only ever calls ws.send(). */
const fakeWs = { send: () => {} } as unknown as Parameters<ReturnType<typeof createAgentWsHandlers>['onMessage']>[1];

/** Drive the real onMessage handler with a desk-start command_result. */
async function sendDeskStartResult(
  agentId: string,
  deviceId: string,
  orgId: string,
  sessionId: string,
  result: Record<string, unknown>,
  status: 'completed' | 'failed' = 'completed',
): Promise<void> {
  const handlers = createAgentWsHandlers(agentId, { deviceId, orgId });
  const event = {
    data: JSON.stringify({
      type: 'command_result',
      commandId: `desk-start-${sessionId}`,
      status,
      result,
    }),
  } as MessageEvent;
  await handlers.onMessage(event, fakeWs);
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
}): Promise<string> {
  const tdb = getTestDb();
  const [row] = await tdb
    .insert(remoteSessions)
    .values({
      deviceId: opts.deviceId,
      orgId: opts.orgId,
      userId: opts.userId,
      type: 'desktop',
      status: opts.status ?? 'connecting',
      iceCandidates: [],
    })
    .returning({ id: remoteSessions.id });
  if (!row) throw new Error('insertSession: no row');
  return row.id;
}

async function readSessionStatus(sessionId: string): Promise<{ status: string; endedAt: Date | null; startedAt: Date | null }> {
  const tdb = getTestDb();
  const [row] = await tdb
    .select({ status: remoteSessions.status, endedAt: remoteSessions.endedAt, startedAt: remoteSessions.startedAt })
    .from(remoteSessions)
    .where(eq(remoteSessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error('session not found');
  return row as { status: string; endedAt: Date | null; startedAt: Date | null };
}

async function auditActionsFor(sessionId: string): Promise<string[]> {
  const tdb = getTestDb();
  const rows = await tdb
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.resourceId, sessionId), eq(auditLogs.resourceType, 'remote_session')));
  return rows.map((r) => r.action);
}

describe('agentWs consent ingestion (real onMessage, breeze_app)', () => {
  runDb('consent_denied reason=user → status=denied + audit session_consent_denied', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, sessionId, {
      event: 'consent_denied',
      sessionId,
      reason: 'user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('denied');
    expect(row.endedAt).not.toBeNull();
    expect(await auditActionsFor(sessionId)).toContain('session_consent_denied');
  });

  runDb('consent_denied reason=no_user → status=denied + audit session_consent_bypassed', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, sessionId, {
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
    await sendDeskStartResult(devB.agentId, devB.id, env.organization.id, sessionId, {
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

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, sessionId, {
      event: 'consent_denied',
      sessionId,
      reason: 'user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('active'); // untouched
    expect(await auditActionsFor(sessionId)).not.toContain('session_consent_denied');
  });

  // Grant path: a successful start carrying consentReason='user' activates the
  // session and emits session_consent_granted.
  runDb('answer + consentReason=user → status=active + audit session_consent_granted', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({ deviceId: dev.id, orgId: env.organization.id, userId: env.user.id });

    await sendDeskStartResult(dev.agentId, dev.id, env.organization.id, sessionId, {
      sessionId,
      answer: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n', // minimal SDP-ish string
      consentReason: 'user',
    });

    const row = await readSessionStatus(sessionId);
    expect(row.status).toBe('active');
    expect(row.startedAt).not.toBeNull();
    expect(await auditActionsFor(sessionId)).toContain('session_consent_granted');
  });
});
