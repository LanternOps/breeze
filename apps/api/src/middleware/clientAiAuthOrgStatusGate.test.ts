/**
 * Org-status gate on `clientAiAuthMiddleware` (org-lifecycle Wave 2, Task 3,
 * fix round 2).
 *
 * `/client-ai` is the SECOND `portal_users` ingress: Office add-in users
 * authenticate from their own Redis namespace (`clientai:session:*`), and the
 * middleware then opens an org-scoped WRITE context. Before this gate, an
 * add-in user of an org that had been suspended, offboarded, archived, or
 * fenced into `merging` for an org merge kept inserting `ai_messages` and
 * updating `ai_sessions` — and during a merge those rows land under the loser
 * after the fence, to be stranded by the re-tenant and then destroyed by the
 * erasure.
 *
 * Mirrors `routes/portal/authOrgStatusGate.test.ts` so the two ingresses stay
 * provably symmetric.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { redisMock, getRedisMock, dbSelectMock, activeOrgResult, userRow, capturedDbContexts } =
  vi.hoisted(() => {
    const redis = {
      get: vi.fn(),
      del: vi.fn(() => Promise.resolve(1)),
      srem: vi.fn(() => Promise.resolve(1)),
      expire: vi.fn(() => Promise.resolve(1)),
    };
    return {
      redisMock: redis,
      getRedisMock: vi.fn(() => redis),
      dbSelectMock: vi.fn(),
      activeOrgResult: { current: null as { orgId: string; partnerId: string } | null },
      userRow: { current: null as Record<string, unknown> | null },
      capturedDbContexts: [] as unknown[],
    };
  });

vi.mock('../db', () => ({
  db: { select: dbSelectMock },
  withDbAccessContext: vi.fn((ctx: unknown, fn: () => unknown) => {
    capturedDbContexts.push(ctx);
    return fn();
  }),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../services/redis', () => ({ getRedis: getRedisMock }));
vi.mock('../services/clientAiPolicy', () => ({
  getOrgPolicy: vi.fn(),
  isClientUserPermitted: vi.fn(() => true),
}));

// The gate delegates the whole "is this org usable" question to the shared
// tenant-status machinery, so the test drives THAT boundary rather than
// re-implementing status rules it must never diverge from.
vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => {
    if (activeOrgResult.current === undefined) throw new Error('db exploded');
    return activeOrgResult.current;
  }),
}));

import { clientAiAuthMiddleware } from './clientAiAuth';
import { getActiveOrgTenant } from '../services/tenantStatus';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PORTAL_USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJK';

function setupUserSelect(row: object | null) {
  const limit = vi.fn(() => Promise.resolve(row ? [row] : []));
  const where = vi.fn(() => ({ limit }));
  const innerJoin2 = vi.fn(() => ({ where }));
  const innerJoin1 = vi.fn(() => ({ innerJoin: innerJoin2 }));
  dbSelectMock.mockImplementation(() => ({ from: vi.fn(() => ({ innerJoin: innerJoin1 })) }));
}

function call() {
  const app = new Hono();
  app.use('*', clientAiAuthMiddleware);
  app.get('/me', (c) => c.json({ ok: true }));
  return app.request('/me', { headers: { Authorization: `Bearer ${TOKEN}` } });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedDbContexts.length = 0;
  activeOrgResult.current = { orgId: ORG_ID, partnerId: 'partner-1' };
  userRow.current = {
    id: PORTAL_USER_ID,
    orgId: ORG_ID,
    email: 'finance.user@contoso.com',
    name: 'Finance User',
    status: 'active',
    partnerAiForOfficeEnabled: true,
  };
  setupUserSelect(userRow.current);
  redisMock.get.mockResolvedValue(
    JSON.stringify({ portalUserId: PORTAL_USER_ID, orgId: ORG_ID, createdAt: new Date().toISOString() }),
  );
});

describe('clientAiAuthMiddleware org-status gate', () => {
  it('admits an add-in session whose org is usable', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(getActiveOrgTenant).toHaveBeenCalledWith(ORG_ID);
    // The org-scoped write context is only opened once the gate passes.
    expect(capturedDbContexts).toHaveLength(1);
  });

  it("rejects a session whose org is fenced for a merge ('merging')", async () => {
    // getActiveOrgTenant returns null for any non-usable status, `merging`
    // included — that is the merge fence reaching the add-in surface.
    activeOrgResult.current = null;
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization is not available' });
  });

  it('never opens the org-scoped WRITE context for an unavailable org', async () => {
    activeOrgResult.current = null;
    await call();
    // This is the whole point: no context means no ai_messages/ai_sessions
    // write can land under the fenced org.
    expect(capturedDbContexts).toHaveLength(0);
  });

  it('purges the clientai session and its index entry so a retry cannot succeed', async () => {
    activeOrgResult.current = null;
    await call();
    expect(redisMock.del).toHaveBeenCalledWith(`clientai:session:${TOKEN}`);
    expect(redisMock.srem).toHaveBeenCalledWith(`clientai:user-sessions:${PORTAL_USER_ID}`, TOKEN);
  });

  it('does not slide the session TTL when the org is unavailable', async () => {
    activeOrgResult.current = null;
    await call();
    expect(redisMock.expire).not.toHaveBeenCalled();
  });

  it('rejects on an active portal user — the 403 is the ORG gate, not the account gate', async () => {
    activeOrgResult.current = null;
    const res = await call();
    expect(userRow.current?.status).toBe('active');
    expect(res.status).toBe(403);
    expect(await res.json()).not.toEqual({ error: 'Account is not active' });
  });

  it('still rejects a disabled portal user before consulting the org', async () => {
    userRow.current = { ...userRow.current, status: 'disabled' };
    setupUserSelect(userRow.current);
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Account is not active' });
    expect(getActiveOrgTenant).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when the org lookup throws — never admits on an unknown org state', async () => {
    // `undefined` makes the mocked getActiveOrgTenant throw.
    activeOrgResult.current = undefined as unknown as null;
    const res = await call();
    expect(res.status).toBe(500);
    expect(capturedDbContexts).toHaveLength(0);
  });
});
