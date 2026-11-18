import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * Quick Support session routes.
 *
 * The load-bearing guards here are the scope checks: the hidden Quick Support
 * org is per-PARTNER, so an org-scope token (which carries a partnerId but
 * never passes breeze_has_partner_access) must not be able to mint sessions,
 * and a system token with no partner context has no org to provision into.
 */

// The sealed code is row-bound (AAD = session id), which encryptSecret only
// honours under an active key id (v3). Production and the integration env set
// both; pin them here so the row-binding assertions mean something.
vi.hoisted(() => {
  process.env.APP_ENCRYPTION_KEY ||= 'unit-test-app-encryption-key-at-least-32-chars!!';
  process.env.APP_ENCRYPTION_KEY_ID ||= 'unit-key-1';
});

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
// How many caller-scoped contexts are open, and the depth seen by each read.
const { authContext } = vi.hoisted(() => ({ authContext: { depth: 0, selectDepths: [] as number[] } }));
vi.mock('../../middleware/auth', () => ({
  withAuthDbAccessContext: async (_auth: unknown, fn: () => Promise<unknown>) => {
    authContext.depth += 1;
    try { return await fn(); } finally { authContext.depth -= 1; }
  },
}));
const insertedValues: unknown[] = [];
const insertReturns: unknown[][] = [];
const updateSets: unknown[] = [];
const updateWheres: unknown[] = [];
const updateReturns: unknown[][] = [];

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    authContext.selectDepths.push(authContext.depth);
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

  const update = vi.fn(() => ({
    set: vi.fn((values: unknown) => {
      updateSets.push(values);
      const rows = updateReturns.shift() ?? [];
      return {
        where: vi.fn((whereArg: unknown) => {
          updateWheres.push(whereArg);
          return { returning: vi.fn(() => Promise.resolve(rows)) };
        }),
      };
    }),
  }));

  return {
    db: { select, insert, update },
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
    codeEncrypted: 'supportSessions.codeEncrypted',
    codeExpiresAt: 'supportSessions.codeExpiresAt',
    hardExpiresAt: 'supportSessions.hardExpiresAt',
    claimedAt: 'supportSessions.claimedAt',
    endedReason: 'supportSessions.endedReason',
  },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', type: 'organizations.type' },
  remoteSessions: { id: 'remoteSessions.id', deviceId: 'remoteSessions.deviceId', status: 'remoteSessions.status' },
  devices: { id: 'devices.id', status: 'devices.status' },
}));

import { hashSupportCode, openSupportCode, sealSupportCode } from '../../services/quickSupportCode';
import { supportSessionRoutes } from './supportSessions';

type AuthOverrides = {
  scope?: 'system' | 'partner' | 'organization';
  partnerId?: string | null;
  accessibleOrgIds?: string[] | null;
  /** The grants the router's requirePermission gate resolved; null = gate did not run. */
  permissions?: Array<{ resource: string; action: string }> | null;
};

const REMOTE_ACCESS = { resource: 'remote', action: 'access' };

/**
 * The identifiers a drizzle `.where(...)` was built with. The mocked schema
 * columns are plain strings, so they land in the SQL AST's queryChunks as-is
 * (same walk as supportPublic.test.ts).
 */
function collectSqlLeafStrings(node: unknown, seen = new Set<unknown>(), acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (node === null || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    for (const item of queryChunks) collectSqlLeafStrings(item, seen, acc);
  }
  return acc;
}

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
    const permissions = overrides.permissions === undefined ? [REMOTE_ACCESS] : overrides.permissions;
    if (permissions) c.set('permissions', { permissions } as never);
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
  updateSets.length = 0;
  updateWheres.length = 0;
  updateReturns.length = 0;
  vi.clearAllMocks();
  getOrCreateQuickSupportOrg.mockResolvedValue({ orgId: 'qs-org', siteId: 'qs-site' });
  getTrustedClientIp.mockReturnValue('203.0.113.7');
  process.env.PUBLIC_WEB_URL = 'https://us.2breeze.app';
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// #10508: the landing URL is pasted into email/chat, so it must be absolute.
// Stock compose sets only PUBLIC_APP_URL; PUBLIC_WEB_URL is an optional override.
describe('POST /support-sessions landingUrl base', () => {
  async function createLandingUrl(): Promise<{ landingUrl: string; raw: string }> {
    insertReturns.push([SESSION_ROW]);
    const res = await buildApp().request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    return { landingUrl: body.landingUrl, raw: body.code.replace(/-/g, '') };
  }

  function stubBases(env: { PUBLIC_WEB_URL?: string; DASHBOARD_URL?: string; PUBLIC_APP_URL?: string }) {
    vi.stubEnv('PUBLIC_WEB_URL', env.PUBLIC_WEB_URL ?? '');
    vi.stubEnv('DASHBOARD_URL', env.DASHBOARD_URL ?? '');
    vi.stubEnv('PUBLIC_APP_URL', env.PUBLIC_APP_URL ?? '');
  }

  it('builds an absolute link from PUBLIC_APP_URL when that is the only base set (stock compose)', async () => {
    stubBases({ PUBLIC_APP_URL: 'https://rmm.example.com' });
    const { landingUrl, raw } = await createLandingUrl();
    expect(landingUrl).toBe(`https://rmm.example.com/quick?code=${raw}`);
  });

  it('prefers DASHBOARD_URL over PUBLIC_APP_URL, like the other dashboard links', async () => {
    stubBases({ DASHBOARD_URL: 'https://dash.example.com', PUBLIC_APP_URL: 'https://rmm.example.com' });
    const { landingUrl, raw } = await createLandingUrl();
    expect(landingUrl).toBe(`https://dash.example.com/quick?code=${raw}`);
  });

  it('honours an explicit PUBLIC_WEB_URL override first', async () => {
    stubBases({
      PUBLIC_WEB_URL: 'https://support.example.com',
      DASHBOARD_URL: 'https://dash.example.com',
      PUBLIC_APP_URL: 'https://rmm.example.com',
    });
    const { landingUrl, raw } = await createLandingUrl();
    expect(landingUrl).toBe(`https://support.example.com/quick?code=${raw}`);
  });

  it('strips trailing slashes from the base so the path has no double slash', async () => {
    stubBases({ PUBLIC_APP_URL: 'https://rmm.example.com//' });
    const { landingUrl, raw } = await createLandingUrl();
    expect(landingUrl).toBe(`https://rmm.example.com/quick?code=${raw}`);
  });

  it('skips a whitespace-only base instead of letting it shadow the next one', async () => {
    stubBases({ PUBLIC_WEB_URL: '   ', PUBLIC_APP_URL: 'https://rmm.example.com' });
    const { landingUrl, raw } = await createLandingUrl();
    expect(landingUrl).toBe(`https://rmm.example.com/quick?code=${raw}`);
  });

  it('falls back to the relative path when no base is configured (the web client resolves it)', async () => {
    stubBases({});
    const { landingUrl, raw } = await createLandingUrl();
    expect(landingUrl).toBe(`/quick?code=${raw}`);
  });
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

  it('reads the session in a short caller-scoped context and ends it with none held', async () => {
    authContext.selectDepths.length = 0;
    let depthAtEnd = -1;
    endSupportSession.mockImplementationOnce(async () => {
      depthAtEnd = authContext.depth;
      return { ended: true, disconnect: 'closed', commandDelivered: true };
    });
    selectResults.push([{ ...SESSION_ROW, status: 'ready', deviceId: 'dev-1' }]);

    expect((await end()).status).toBe(200);
    expect(authContext.selectDepths).toEqual([1]);
    expect(depthAtEnd).toBe(0);
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

// ============================================
// #11836 — the code stays readable while the session is pending
// ============================================

const LIVE_ID = '0b5e1d1a-7c55-4d0e-9b8a-2f1b3c4d5e6f';
const LIVE_CODE = '234567892';

function liveRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    ...SESSION_ROW,
    id: LIVE_ID,
    codeHash: hashSupportCode(LIVE_CODE),
    codeEncrypted: sealSupportCode(LIVE_ID, LIVE_CODE),
    codeExpiresAt: new Date(now + 10 * 60_000),
    hardExpiresAt: new Date(now + 7 * 3_600_000),
    ...overrides,
  };
}

describe('POST /support-sessions — sealed code at rest', () => {
  it('stores the code sealed under the new row id, never in plaintext', async () => {
    insertReturns.push([SESSION_ROW]);
    const res = await buildApp().request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const raw = (await res.json()).code.replace(/-/g, '');
    const inserted = insertedValues[0] as { id: string; codeEncrypted: string };
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted.codeEncrypted).not.toContain(raw);
    expect(openSupportCode(inserted.id, inserted.codeEncrypted)).toBe(raw);
    // Bound to its row: under another id it does not open.
    expect(openSupportCode(LIVE_ID, inserted.codeEncrypted)).toBeNull();
  });

  it('refuses a caller whose grants lack remote:access, before provisioning anything', async () => {
    const res = await buildApp({ permissions: [{ resource: 'devices', action: 'read' }] }).request('/support-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(getOrCreateQuickSupportOrg).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(0);
  });
});

describe('GET /support-sessions/:id — code reveal', () => {
  it('returns the formatted code and landing link for a live pending session in the caller\'s own partner', async () => {
    selectResults.push([liveRow()]);
    selectResults.push([{ id: 'qs-org' }]); // own-partner org check
    const body = await (await buildApp().request(`/support-sessions/${LIVE_ID}`)).json();
    expect(body.code).toBe('234-567-892');
    expect(body.landingUrl).toBe(`https://us.2breeze.app/quick?code=${LIVE_CODE}`);
    expect(body.canIssueNewCode).toBe(true);
    expect(body).not.toHaveProperty('codeEncrypted');
    expect(body).not.toHaveProperty('codeHash');
  });

  it('returns no code when the session org is not the caller\'s own partner\'s', async () => {
    selectResults.push([liveRow()]);
    selectResults.push([]); // org belongs to someone else
    const body = await (await buildApp({ scope: 'system' }).request(`/support-sessions/${LIVE_ID}`)).json();
    expect(body.code).toBeUndefined();
    expect(body.landingUrl).toBeUndefined();
    expect(body.canIssueNewCode).toBe(false);
  });

  it('returns no code to a caller without remote:access, an org-scope caller, or a partnerless system caller', async () => {
    for (const overrides of [
      { permissions: null },
      { permissions: [{ resource: 'devices', action: 'read' }] },
      { scope: 'organization' as const },
      { scope: 'system' as const, partnerId: null },
    ]) {
      selectResults.length = 0;
      selectResults.push([liveRow()]);
      const body = await (await buildApp(overrides).request(`/support-sessions/${LIVE_ID}`)).json();
      expect(body.code).toBeUndefined();
      expect(body.canIssueNewCode).toBe(false);
      // No org lookup was even attempted.
      expect(selectResults).toHaveLength(0);
    }
  });

  it('returns no code once code_expires_at has passed, even while still pending (reaper not run)', async () => {
    selectResults.push([liveRow({ codeExpiresAt: new Date(Date.now() - 1_000) })]);
    selectResults.push([{ id: 'qs-org' }]);
    const body = await (await buildApp().request(`/support-sessions/${LIVE_ID}`)).json();
    expect(body.status).toBe('pending');
    expect(body.code).toBeUndefined();
    // ...but the tech can mint a replacement.
    expect(body.canIssueNewCode).toBe(true);
  });

  it('returns no code for a session that is no longer pending, even if a sealed value lingered', async () => {
    for (const status of ['claimed', 'ended', 'expired'] as const) {
      selectResults.length = 0;
      selectResults.push([liveRow({ status })]);
      selectResults.push([{ id: 'qs-org' }]);
      const body = await (await buildApp().request(`/support-sessions/${LIVE_ID}`)).json();
      expect(body.code).toBeUndefined();
    }
  });

  it('shows nothing (and does not throw) when the sealed value does not open', async () => {
    selectResults.push([liveRow({ codeEncrypted: sealSupportCode('11111111-2222-4333-8444-555555555555', LIVE_CODE) })]);
    selectResults.push([{ id: 'qs-org' }]);
    const res = await buildApp().request(`/support-sessions/${LIVE_ID}`);
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBeUndefined();
  });
});

describe('GET /support-sessions — code reveal', () => {
  it('never emits the sealed value and reveals only the live pending row', async () => {
    selectResults.push([
      liveRow(),
      liveRow({ id: 'sess-old', status: 'ended', codeEncrypted: null }),
    ]);
    selectResults.push([{ id: 'qs-org' }]);
    const body = await (await buildApp().request('/support-sessions')).json();
    expect(JSON.stringify(body)).not.toContain('enc:');
    expect(body.sessions[0].code).toBe('234-567-892');
    expect(body.sessions[1].code).toBeUndefined();
  });
});

describe('POST /support-sessions/:id/code — New code', () => {
  function newCode(overrides: AuthOverrides = {}) {
    return buildApp(overrides).request(`/support-sessions/${LIVE_ID}/code`, { method: 'POST' });
  }

  it('swaps hash, sealed value and expiry in one update, returns the new code, and audits', async () => {
    selectResults.push([liveRow()]);
    selectResults.push([{ id: 'qs-org' }]);
    const hard = new Date(Date.now() + 7 * 3_600_000);
    updateReturns.push([{ id: LIVE_ID, codeExpiresAt: new Date(Date.now() + 15 * 60_000), hardExpiresAt: hard }]);

    const res = await newCode();
    expect(res.status).toBe(200);
    const body = await res.json();
    const raw = body.code.replace(/-/g, '');
    expect(body.landingUrl).toBe(`https://us.2breeze.app/quick?code=${raw}`);

    expect(updateSets).toHaveLength(1);
    const set = updateSets[0] as Record<string, unknown>;
    expect(set.codeHash).toBe(hashSupportCode(raw));
    expect(openSupportCode(LIVE_ID, set.codeEncrypted as string)).toBe(raw);
    expect(set).toMatchObject({ status: 'pending', endedAt: null, endedReason: null });
    expect(logSessionAudit).toHaveBeenCalledWith(
      'support_session_code_reissued',
      'user-1',
      'qs-org',
      { sessionId: LIVE_ID, previousStatus: 'pending' },
      '203.0.113.7',
    );
  });

  // The pre-read can go stale (a redeem may claim the session in between);
  // the UPDATE's own WHERE is what keeps a fresh code off a claimed session.
  it('re-checks unclaimed, no device, inside the hard cap and pending-or-code-expired in the UPDATE itself', async () => {
    selectResults.push([liveRow()]);
    selectResults.push([{ id: 'qs-org' }]);
    updateReturns.push([{ id: LIVE_ID, codeExpiresAt: new Date(), hardExpiresAt: new Date() }]);
    expect((await newCode()).status).toBe(200);

    const leaves = collectSqlLeafStrings(updateWheres[0]);
    for (const column of [
      'supportSessions.id',
      'supportSessions.claimedAt',
      'supportSessions.deviceId',
      'supportSessions.hardExpiresAt',
      'supportSessions.status',
      'supportSessions.endedReason',
    ]) {
      expect(leaves, column).toContain(column);
    }
    expect(leaves).toContain('pending');
    expect(leaves).toContain('expired');
  });

  it('caps the new code expiry at the session hard cap', async () => {
    const hard = new Date(Date.now() + 5 * 60_000);
    selectResults.push([liveRow({ hardExpiresAt: hard })]);
    selectResults.push([{ id: 'qs-org' }]);
    updateReturns.push([{ id: LIVE_ID, codeExpiresAt: hard, hardExpiresAt: hard }]);
    expect((await newCode()).status).toBe(200);
    expect((updateSets[0] as { codeExpiresAt: Date }).codeExpiresAt.getTime()).toBe(hard.getTime());
  });

  it('revives a session the reaper expired only because its code lapsed', async () => {
    selectResults.push([liveRow({ status: 'expired', endedReason: 'expired', codeEncrypted: null, codeExpiresAt: new Date(Date.now() - 60_000) })]);
    selectResults.push([{ id: 'qs-org' }]);
    updateReturns.push([{ id: LIVE_ID, codeExpiresAt: new Date(), hardExpiresAt: new Date() }]);
    expect((await newCode()).status).toBe(200);
    expect(logSessionAudit).toHaveBeenCalledWith(
      'support_session_code_reissued', 'user-1', 'qs-org',
      { sessionId: LIVE_ID, previousStatus: 'expired' }, '203.0.113.7',
    );
  });

  it('409s a claimed, joined, tech-ended, hard-cap-expired or past-cap session without writing', async () => {
    const past = new Date(Date.now() - 1_000);
    for (const overrides of [
      { status: 'claimed', claimedAt: new Date() },
      { status: 'ready', claimedAt: new Date(), deviceId: 'dev-1' },
      { status: 'ended', endedReason: 'tech', codeEncrypted: null },
      { status: 'expired', endedReason: 'expired', claimedAt: new Date(), codeEncrypted: null },
      { status: 'expired', endedReason: 'error', claimedAt: new Date(), codeEncrypted: null },
      { hardExpiresAt: past },
    ]) {
      selectResults.length = 0;
      selectResults.push([liveRow(overrides)]);
      selectResults.push([{ id: 'qs-org' }]);
      expect((await newCode()).status).toBe(409);
    }
    expect(updateSets).toHaveLength(0);
  });

  it('409s when the guarded update matches nothing (lost a race with redeem)', async () => {
    selectResults.push([liveRow()]);
    selectResults.push([{ id: 'qs-org' }]);
    updateReturns.push([]);
    expect((await newCode()).status).toBe(409);
    expect(logSessionAudit).not.toHaveBeenCalled();
  });

  it('404s a session the caller cannot see, or another partner\'s', async () => {
    selectResults.push([]);
    expect((await newCode()).status).toBe(404);
    selectResults.push([liveRow()]);
    selectResults.push([]); // not the caller's partner's org
    expect((await newCode({ scope: 'system' })).status).toBe(404);
    expect(updateSets).toHaveLength(0);
  });

  it('403s exactly the callers create refuses', async () => {
    for (const overrides of [
      { permissions: null },
      { permissions: [{ resource: 'devices', action: 'read' }] },
      { scope: 'organization' as const },
      { scope: 'system' as const, partnerId: null },
    ]) {
      expect((await newCode(overrides)).status).toBe(403);
    }
    expect(updateSets).toHaveLength(0);
  });
});

describe('POST /support-sessions/:id/code — partner trust', () => {
  it('applies the same partner-trust gate as create: a denied partner gets a 403 and no new code', async () => {
    partnerTrustMode.mockReturnValue('enforce');
    evaluateCapability.mockResolvedValueOnce({
      allow: false,
      code: 'TRUST_PROBATION',
      capability: 'remote_control',
      reason: 'probation_default_deny',
    });
    selectResults.push([liveRow()]);
    selectResults.push([{ id: 'qs-org' }]);

    try {
      const res = await buildApp().request(`/support-sessions/${LIVE_ID}/code`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(expect.objectContaining({ error: 'TRUST_PROBATION' }));
      expect(evaluateCapability).toHaveBeenCalledWith('remote_control', expect.objectContaining({
        partnerId: 'partner-1',
        userId: 'user-1',
        detail: { kind: 'support', reissue: true },
      }));
      expect(updateSets).toHaveLength(0);
      expect(logSessionAudit).not.toHaveBeenCalled();
    } finally {
      partnerTrustMode.mockReturnValue('off');
    }
  });
});

// A response that can carry a live join code must never be cached (#11836).
describe('code-bearing responses are Cache-Control: no-store', () => {
  it('GET /support-sessions', async () => {
    selectResults.push([liveRow()]);
    selectResults.push([{ id: 'qs-org' }]);
    const res = await buildApp().request('/support-sessions');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('GET /support-sessions/:id', async () => {
    selectResults.push([liveRow()]);
    selectResults.push([{ id: 'qs-org' }]);
    const res = await buildApp().request(`/support-sessions/${LIVE_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('POST /support-sessions/:id/code', async () => {
    selectResults.push([liveRow()]);
    selectResults.push([{ id: 'qs-org' }]);
    updateReturns.push([{
      id: LIVE_ID,
      codeExpiresAt: new Date(Date.now() + 15 * 60_000),
      hardExpiresAt: new Date(Date.now() + 7 * 3_600_000),
    }]);
    const res = await buildApp().request(`/support-sessions/${LIVE_ID}/code`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
