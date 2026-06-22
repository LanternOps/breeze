/**
 * Integration test — remote-session consent deny/bypass teardown + audit
 *
 * Exercises the real deny path (POST /remote/sessions/:id/deny) against the
 * actual test DB running as breeze_app. Verifies:
 *   1. reason='user'  → status='denied', endedAt set,
 *      audit_logs row action='session_consent_denied'
 *   2. reason='policy_proceed' → status='denied', endedAt set,
 *      audit_logs row action='session_consent_bypassed'
 *   3. State guard: deny on a non-connecting session → 400
 *
 * Run:
 *   set -a; . ./.env.test; set +a
 *   PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH \
 *     pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/remote-session-consent.integration.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';

import './setup';
import { getTestDb } from './setup';
import {
  setupTestEnvironment,
} from './db-utils';
import { createAccessToken } from '../../services/jwt';

import { remoteRoutes } from '../../routes/remote';
import { devices, remoteSessions, auditLogs } from '../../db/schema';

// ============================================================
// Helpers
// ============================================================

/** Insert a minimal device into the test DB (superuser connection). */
async function insertDevice(orgId: string, siteId: string): Promise<string> {
  const tdb = getTestDb();
  const agentId = `agent-consent-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId,
      hostname: `consent-test-host-${agentId}`,
      displayName: 'Consent Test Host',
      osType: 'windows',
      osVersion: '11',
      osBuild: '22000',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice: no row returned');
  return row.id;
}

/** Insert a remote_session in the given status (superuser connection). */
async function insertSession(opts: {
  deviceId: string;
  orgId: string;
  userId: string;
  status?: 'pending' | 'connecting' | 'active' | 'disconnected' | 'failed' | 'denied';
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
  if (!row) throw new Error('insertSession: no row returned');
  return row.id;
}

/** Create a Hono app with the real remoteRoutes mounted. */
function buildApp() {
  const app = new Hono();
  app.route('/remote', remoteRoutes);
  return app;
}

/**
 * Mint a token for the given environment with mfa:true so the
 * requireMfa() guard on remoteRoutes is satisfied.
 */
async function mintMfaToken(env: Awaited<ReturnType<typeof setupTestEnvironment>>) {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization' as const,
    mfa: true, // satisfies requireMfa() on the remote route group
  });
}

// ============================================================
// Tests
// ============================================================

describe('POST /remote/sessions/:id/deny — consent teardown + audit', () => {
  let app: Hono;

  beforeEach(() => {
    app = buildApp();
  });

  // --------------------------------------------------------
  // Case 1: user denial → session_consent_denied
  // --------------------------------------------------------
  it('reason=user → status=denied, endedAt set, audit action=session_consent_denied', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tdb = getTestDb();

    const deviceId = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId,
      orgId: env.organization.id,
      userId: env.user.id,
      status: 'connecting',
    });

    const res = await app.request(`/remote/sessions/${sessionId}/deny`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'user' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; status: string; endedAt: string | null };
    expect(body.status).toBe('denied');
    expect(body.endedAt).not.toBeNull();

    // Verify the DB row was updated (query via superuser connection)
    const [sessionRow] = await tdb
      .select({ status: remoteSessions.status, endedAt: remoteSessions.endedAt })
      .from(remoteSessions)
      .where(eq(remoteSessions.id, sessionId))
      .limit(1);
    expect(sessionRow?.status).toBe('denied');
    expect(sessionRow?.endedAt).not.toBeNull();

    // Verify audit log — filter by resourceId=sessionId so the append-only
    // table's prior rows don't interfere with this assertion.
    const auditRows = await tdb
      .select({ action: auditLogs.action, resourceType: auditLogs.resourceType, resourceId: auditLogs.resourceId, details: auditLogs.details })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, sessionId),
          eq(auditLogs.action, 'session_consent_denied'),
        )
      );

    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const auditRow = auditRows[0]!;
    expect(auditRow.resourceType).toBe('remote_session');
    expect(auditRow.resourceId).toBe(sessionId);
    const details = auditRow.details as Record<string, unknown>;
    expect(details.reason).toBe('user');
    expect(details.sessionId).toBe(sessionId);
  });

  // --------------------------------------------------------
  // Case 2: bypass reason → session_consent_bypassed
  // --------------------------------------------------------
  it('reason=policy_proceed → status=denied, audit action=session_consent_bypassed', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tdb = getTestDb();

    const deviceId = await insertDevice(env.organization.id, env.site.id);
    const sessionId = await insertSession({
      deviceId,
      orgId: env.organization.id,
      userId: env.user.id,
      status: 'connecting',
    });

    const res = await app.request(`/remote/sessions/${sessionId}/deny`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'policy_proceed' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; endedAt: string | null };
    expect(body.status).toBe('denied');
    expect(body.endedAt).not.toBeNull();

    // Verify the DB row
    const [sessionRow] = await tdb
      .select({ status: remoteSessions.status, endedAt: remoteSessions.endedAt })
      .from(remoteSessions)
      .where(eq(remoteSessions.id, sessionId))
      .limit(1);
    expect(sessionRow?.status).toBe('denied');
    expect(sessionRow?.endedAt).not.toBeNull();

    // Verify audit — must be 'session_consent_bypassed', NOT 'session_consent_denied'
    const auditRows = await tdb
      .select({ action: auditLogs.action, resourceType: auditLogs.resourceType, details: auditLogs.details })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, sessionId),
          eq(auditLogs.action, 'session_consent_bypassed'),
        )
      );

    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const auditRow = auditRows[0]!;
    expect(auditRow.resourceType).toBe('remote_session');
    const details = auditRow.details as Record<string, unknown>;
    expect(details.reason).toBe('policy_proceed');

    // Double-check no 'session_consent_denied' was emitted for this session
    const deniedAuditRows = await tdb
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, sessionId),
          eq(auditLogs.action, 'session_consent_denied'),
        )
      );
    expect(deniedAuditRows.length).toBe(0);
  });

  // --------------------------------------------------------
  // Case 3: state guard — deny on non-connecting session → 400
  // --------------------------------------------------------
  it('deny on an active session → 400 (state guard)', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);

    const deviceId = await insertDevice(env.organization.id, env.site.id);
    // Seed a session already in 'active' — deny should be rejected
    const sessionId = await insertSession({
      deviceId,
      orgId: env.organization.id,
      userId: env.user.id,
      status: 'active',
    });

    const res = await app.request(`/remote/sessions/${sessionId}/deny`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'user' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; status: string };
    expect(body.error).toMatch(/current state/i);
    expect(body.status).toBe('active');
  });
});
