import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Quick Support session routes.
 *
 * The load-bearing guards here are the scope checks: the hidden Quick Support
 * org is per-PARTNER, so an org-scope token (which carries a partnerId but
 * never passes breeze_has_partner_access) must not be able to mint sessions,
 * and a system token with no partner context has no org to provision into.
 */

const { getOrCreateQuickSupportOrg, logSessionAudit, getTrustedClientIp, evaluateCapability, partnerTrustMode } = vi.hoisted(() => ({
  getOrCreateQuickSupportOrg: vi.fn(() => Promise.resolve({ orgId: 'qs-org', siteId: 'qs-site' })),
  logSessionAudit: vi.fn(() => Promise.resolve()),
  getTrustedClientIp: vi.fn(() => '203.0.113.7'),
  evaluateCapability: vi.fn(async (): Promise<any> => ({ allow: true })),
  partnerTrustMode: vi.fn(() => 'off'),
}));

const { endSupportSession } = vi.hoisted(() => ({
  // Return type annotated so a test can script a 'close-failed' outcome; an
  // inferred literal would narrow it to 'closed'.
  endSupportSession: vi.fn((): Promise<{
    ended: boolean;
    disconnect: 'closed' | 'close-failed' | 'not-connected' | null;
    commandDelivered: boolean;
  }> => Promise.resolve({ ended: true, disconnect: 'closed', commandDelivered: true })),
}));

vi.mock('../../services/quickSupportOrg', () => ({ getOrCreateQuickSupportOrg }));
vi.mock('../../services/quickSupportEnd', () => ({ endSupportSession }));
vi.mock('./helpers', () => ({ logSessionAudit }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIp }));
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode }));
vi.mock('../../services/partnerTrust', () => ({
  evaluateCapability,
  partnerIdForDevice: vi.fn(),
  trustDenyBody: (d: Record<string, unknown>, reviewRequested: boolean) => ({
    error: d.code,
    capability: d.capability,
    reason: d.reason,
    reviewRequested,
    meetingUrl: null,
  }),
}));

// Scripted select results, consumed in call order.
const selectResults: unknown[][] = [];
const insertedValues: unknown[] = [];
const insertReturns: unknown[][] = [];

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    const rows = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin']) {
      builder[m] = vi.fn(() => builder);
    }
    builder.limit = vi.fn(() => Promise.resolve(rows));
    // list route awaits the builder directly after orderBy/limit
    builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return builder;
  });

  const insert = vi.fn(() => ({
    values: vi.fn((values: unknown) => {
      insertedValues.push(values);
      const rows = insertReturns.shift() ?? [];
      return { returning: vi.fn(() => Promise.resolve(rows)) };
    }),
  }));

  return {
    db: { select, insert },
    runOutsideDbContext: vi.fn(<T>(fn: () => T): T => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../../db/schema', () => ({
  supportSessions: {
    id: 'supportSessions.id',
    orgId: 'supportSessions.orgId',
    status: 'supportSessions.status',
    deviceId: 'supportSessions.deviceId',
    createdAt: 'supportSessions.createdAt',
    codeHash: 'supportSessions.codeHash',
  },
  remoteSessions: { id: 'remoteSessions.id', deviceId: 'remoteSessions.deviceId', status: 'remoteSessions.status' },
  devices: { id: 'devices.id', status: 'devices.status' },
}));

import { hashSupportCode } from '../../services/quickSupportCode';
import { supportSessionRoutes } from './supportSessions';

type AuthOverrides = {
  scope?: 'system' | 'partner' | 'organization';
  partnerId?: string | null;
  accessibleOrgIds?: string[] | null;
};

function buildApp(overrides: AuthOverrides = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // Partial AuthContext: these routes read only user.id, scope, partnerId and
    // accessibleOrgIds. Cast rather than construct the full context so the test
    // does not have to track unrelated middleware fields.
    c.set('auth', {
      user: { id: 'user-1', email: 't@example.com', name: 'Tech', isPlatformAdmin: false },
      scope: overrides.scope ?? 'partner',
      partnerId: overrides.partnerId === undefined ? 'partner-1' : overrides.partnerId,
      accessibleOrgIds:
        overrides.accessibleOrgIds === undefined ? ['org-a', 'qs-org'] : overrides.accessibleOrgIds,
    } as never);
    await next();
  });
  app.route('/', supportSessionRoutes);
  return app;
}

const SESSION_ROW = {
  id: 'sess-1',
  orgId: 'qs-org',
  createdByUserId: 'user-1',
  codeHash: 'never-leaks',
  codeExpiresAt: new Date('2026-08-13T10:15:00Z'),
  status: 'pending',
  hardExpiresAt: new Date('2026-08-13T18:00:00Z'),
  deviceId: null,
  attributedOrgId: null,
  attributionLabel: null,
  claimedAt: null,
  claimedFromIp: null,
  endedAt: null,
  endedReason: null,
  createdAt: new Date('2026-08-13T10:00:00Z'),
};

beforeEach(() => {
  selectResults.length = 0;
  insertedValues.length = 0;
  insertReturns.length = 0;
  vi.clearAllMocks();
  getOrCreateQuickSupportOrg.mockResolvedValue({ orgId: 'qs-org', siteId: 'qs-site' });
  getTrustedClientIp.mockReturnValue('203.0.113.7');
  process.env.PUBLIC_WEB_URL = 'https://us.2breeze.app';
});

describe('POST /support-sessions', () => {
  it('creates a session and returns the formatted code exactly once', async () => {
    insertReturns.push([SESSION_ROW]);
    const res = await buildApp().request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    // Digits 2-9 in 3-3-3 groups (234-567-892): the technician reads this down
    // a phone line, so no letters and no 0/1.
    expect(body.code).toMatch(/^[2-9]{3}-[2-9]{3}-[2-9]{3}$/);

    // The stored hash must be the sha256 of the RAW code we handed the tech.
    const raw = body.code.replace(/-/g, '');
    expect((insertedValues[0] as { codeHash: string }).codeHash).toBe(hashSupportCode(raw));
    expect(body.landingUrl).toBe(`https://us.2breeze.app/quick?code=${raw}`);
    expect((insertedValues[0] as { orgId: string }).orgId).toBe('qs-org');
  });

  it('maps partner-trust denial to a 403 without inserting', async () => {
    partnerTrustMode.mockReturnValueOnce('enforce');
    evaluateCapability.mockResolvedValueOnce({
      allow: false,
      code: 'TRUST_PROBATION',
      capability: 'remote_control',
      reason: 'probation_default_deny',
    });

    const res = await buildApp().request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(expect.objectContaining({ error: 'TRUST_PROBATION' }));
    expect(insertedValues).toHaveLength(0);
  });

  it('never returns the code hash to the caller', async () => {
    insertReturns.push([SESSION_ROW]);
    const res = await buildApp().request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(JSON.stringify(await res.json())).not.toContain('never-leaks');
  });

  it('rejects org-scope callers — the hidden org is per-partner', async () => {
    const res = await buildApp({ scope: 'organization' }).request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(getOrCreateQuickSupportOrg).not.toHaveBeenCalled();
  });

  it('rejects a system token carrying no partner context', async () => {
    const res = await buildApp({ scope: 'system', partnerId: null }).request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(getOrCreateQuickSupportOrg).not.toHaveBeenCalled();
  });

  it('rejects an attribution to an org the caller cannot access', async () => {
    const res = await buildApp().request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attributedOrgId: '99999999-9999-4999-8999-999999999999' }),
    });
    expect(res.status).toBe(403);
  });

  it('accepts an attribution to an accessible org and records the label', async () => {
    insertReturns.push([{ ...SESSION_ROW, attributionLabel: 'Contoso — CFO laptop' }]);
    const res = await buildApp({ accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'] }).request(
      '/support-sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          attributedOrgId: '11111111-1111-4111-8111-111111111111',
          attributionLabel: 'Contoso — CFO laptop',
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(insertedValues[0]).toMatchObject({
      attributedOrgId: '11111111-1111-4111-8111-111111111111',
      attributionLabel: 'Contoso — CFO laptop',
    });
  });

  it('audits the creation', async () => {
    insertReturns.push([SESSION_ROW]);
    await buildApp().request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(logSessionAudit).toHaveBeenCalledWith(
      'support_session_created',
      'user-1',
      'qs-org',
      expect.objectContaining({ sessionId: 'sess-1' }),
      '203.0.113.7',
    );
  });
});

describe('GET /support-sessions/:id', () => {
  it('derives active status from a live remote session and reports device presence', async () => {
    selectResults.push([{ ...SESSION_ROW, status: 'ready', deviceId: 'dev-1' }]); // session
    selectResults.push([{ status: 'online' }]); // device
    selectResults.push([{ id: 'rs-1' }]); // live remote session

    const res = await buildApp().request('/support-sessions/sess-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.deviceOnline).toBe(true);
    expect(body.codeHash).toBeUndefined();
  });

  it('stays ready when the device is online but no remote session is live', async () => {
    selectResults.push([{ ...SESSION_ROW, status: 'ready', deviceId: 'dev-1' }]);
    selectResults.push([{ status: 'online' }]);
    selectResults.push([]); // no live remote sessions

    const body = await (await buildApp().request('/support-sessions/sess-1')).json();
    expect(body.status).toBe('ready');
    expect(body.deviceOnline).toBe(true);
  });

  it('does not probe the device for a session that never enrolled one', async () => {
    selectResults.push([SESSION_ROW]); // pending, deviceId null

    const body = await (await buildApp().request('/support-sessions/sess-1')).json();
    expect(body.status).toBe('pending');
    expect(body.deviceOnline).toBe(false);
    // only the session lookup ran
    expect(selectResults).toHaveLength(0);
  });

  it('404s an unknown session', async () => {
    selectResults.push([]);
    const res = await buildApp().request('/support-sessions/nope');
    expect(res.status).toBe(404);
  });
});

describe('POST /support-sessions/:id/end', () => {
  function end(id = 'sess-1') {
    return buildApp().request(`/support-sessions/${id}/end`, { method: 'POST' });
  }

  it('ends a live session and audits the outcome', async () => {
    selectResults.push([{ ...SESSION_ROW, status: 'ready', deviceId: 'dev-1' }]);

    const res = await end();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(endSupportSession).toHaveBeenCalledWith('sess-1', 'tech');
    expect(logSessionAudit).toHaveBeenCalledWith(
      'support_session_ended',
      'user-1',
      'qs-org',
      expect.objectContaining({ sessionId: 'sess-1', reason: 'tech' }),
      '203.0.113.7',
    );
  });

  it('records a failed socket close in the audit instead of implying success', async () => {
    endSupportSession.mockResolvedValueOnce({
      ended: true, disconnect: 'close-failed', commandDelivered: false,
    });
    selectResults.push([{ ...SESSION_ROW, status: 'ready', deviceId: 'dev-1' }]);

    await end();
    expect(logSessionAudit).toHaveBeenCalledWith(
      'support_session_ended',
      'user-1',
      'qs-org',
      expect.objectContaining({ agentDisconnect: 'close-failed', commandDelivered: false }),
      '203.0.113.7',
    );
  });

  it('409s an already-ended session without re-running teardown', async () => {
    selectResults.push([{ ...SESSION_ROW, status: 'ended' }]);
    const res = await end();
    expect(res.status).toBe(409);
    expect(endSupportSession).not.toHaveBeenCalled();
  });

  it('409s an expired session', async () => {
    selectResults.push([{ ...SESSION_ROW, status: 'expired' }]);
    expect((await end()).status).toBe(409);
  });

  it('404s a session the caller cannot see', async () => {
    selectResults.push([]); // RLS returned nothing
    const res = await end('someone-elses');
    expect(res.status).toBe(404);
    expect(endSupportSession).not.toHaveBeenCalled();
  });

  it('ends a pending session that never enrolled a device', async () => {
    selectResults.push([SESSION_ROW]); // pending, deviceId null
    expect((await end()).status).toBe(200);
    expect(endSupportSession).toHaveBeenCalledWith('sess-1', 'tech');
  });
});

describe('GET /support-sessions', () => {
  it('lists sessions without a per-row device query', async () => {
    selectResults.push([
      { ...SESSION_ROW, id: 'sess-2', status: 'ready', deviceId: 'dev-1' },
      { ...SESSION_ROW, id: 'sess-1', status: 'ready', deviceId: 'dev-2' },
    ]);
    selectResults.push([{ id: 'dev-1', status: 'online' }, { id: 'dev-2', status: 'offline' }]);
    selectResults.push([{ deviceId: 'dev-1' }]);

    const res = await buildApp().request('/support-sessions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toMatchObject({ id: 'sess-2', status: 'active', deviceOnline: true });
    expect(body.sessions[1]).toMatchObject({ id: 'sess-1', status: 'ready', deviceOnline: false });
    // session page + one batched device query + one batched remote-session query
    expect(selectResults).toHaveLength(0);
  });

  it('never leaks code hashes in the list', async () => {
    selectResults.push([SESSION_ROW]);
    const res = await buildApp().request('/support-sessions');
    expect(JSON.stringify(await res.json())).not.toContain('never-leaks');
  });
});
