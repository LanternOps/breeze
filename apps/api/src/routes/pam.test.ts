/**
 * PAM admin route tests (#1163) — CAS guards on respond/revoke, the
 * no-criteria rule refine, and runAction-compatible bodies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const authMocks = vi.hoisted(() => ({
  authMiddlewareMock: vi.fn(),
  requireScopeMock: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfaMock: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: authMocks.authMiddlewareMock,
  requireScope: authMocks.requireScopeMock,
  requirePermission: authMocks.requirePermissionMock,
  requireMfa: authMocks.requireMfaMock,
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', hostname: 'hostname' },
  sites: { id: 'id', name: 'name' },
  elevationRequests: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    deviceId: 'deviceId',
    flowType: 'flowType',
    status: 'status',
    requestedAt: 'requestedAt',
    approvedAt: 'approvedAt',
    expiresAt: 'expiresAt',
  },
  elevationAudit: { id: 'id' },
  pamRules: {
    id: 'id',
    orgId: 'orgId',
    priority: 'priority',
    createdAt: 'createdAt',
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

const busMocks = vi.hoisted(() => ({ publishEvent: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: busMocks.publishEvent }));

vi.mock('./softwarePolicies', () => ({
  resolveOrgIdForWrite: vi.fn((auth: { orgId?: string }, orgId?: string) =>
    orgId ? { orgId } : { orgId: auth?.orgId ?? undefined },
  ),
}));

import { db } from '../db';
import { pamRoutes } from './pam';

const ORG_ID = '7b41c9a2-0000-4000-8000-000000000001';
const REQ_ID = '7b41c9a2-0000-4000-8000-000000000002';
const USER_ID = '7b41c9a2-0000-4000-8000-000000000003';

function setAuth() {
  authMocks.authMiddlewareMock.mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: USER_ID, email: 't@example.com' },
      scope: 'organization',
      orgId: ORG_ID,
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => undefined,
    });
    c.set('permissions', undefined); // no site restriction
    return next();
  });
}

interface TxRigOptions {
  row?: Record<string, unknown> | null;
  casWins?: boolean;
}

function rigTransaction(opts: TxRigOptions) {
  const updateSetCalls: unknown[] = [];
  const auditInserts: unknown[] = [];
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(opts.row ? [opts.row] : []),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((setArg: unknown) => {
          updateSetCalls.push(setArg);
          return {
            where: vi.fn(() => ({
              returning: vi
                .fn()
                .mockResolvedValue(
                  opts.casWins ? [{ id: REQ_ID, status: 'approved' }] : [],
                ),
            })),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((v: unknown) => {
          auditInserts.push(v);
          return Promise.resolve();
        }),
      })),
    };
    return fn(tx);
  });
  return { updateSetCalls, auditInserts };
}

function app(): Hono {
  const a = new Hono();
  a.route('/pam', pamRoutes);
  return a;
}

const activeRow = {
  id: REQ_ID,
  orgId: ORG_ID,
  siteId: null,
  deviceId: 'dev-1',
  flowType: 'uac_intercept',
  status: 'pending',
};

describe('POST /pam/elevation-requests/:id/respond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    busMocks.publishEvent.mockResolvedValue('evt');
  });

  it('approves a pending request (CAS wins) and emits elevation.approved', async () => {
    const { updateSetCalls, auditInserts } = rigTransaction({ row: activeRow, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', durationMinutes: 30 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const set = updateSetCalls[0] as { status: string; approvedByUserId: string; expiresAt: Date };
    expect(set.status).toBe('approved');
    expect(set.approvedByUserId).toBe(USER_ID);
    expect(set.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(auditInserts.length).toBe(1);
    expect(busMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.approved',
      ORG_ID,
      expect.objectContaining({ elevationRequestId: REQ_ID }),
      'pam-admin',
    );
  });

  it('denies with reason', async () => {
    const { updateSetCalls } = rigTransaction({ row: activeRow, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny', reason: 'nope' }),
    });

    expect(res.status).toBe(200);
    const set = updateSetCalls[0] as { status: string; denialReason: string };
    expect(set.status).toBe('denied');
    expect(set.denialReason).toBe('nope');
  });

  it('409s when the CAS loses (request no longer pending)', async () => {
    rigTransaction({ row: { ...activeRow, status: 'denied' }, casWins: false });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(busMocks.publishEvent).not.toHaveBeenCalled();
  });

  it('404s for a row outside the caller org (canAccessOrg false)', async () => {
    rigTransaction({ row: { ...activeRow, orgId: 'other-org' }, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(res.status).toBe(404);
  });
});

describe('POST /pam/elevation-requests/:id/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    busMocks.publishEvent.mockResolvedValue('evt');
  });

  it('revokes an active elevation and emits elevation.revoked', async () => {
    const { updateSetCalls } = rigTransaction({
      row: { ...activeRow, status: 'approved' },
      casWins: true,
    });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'compromised' }),
    });

    expect(res.status).toBe(200);
    const set = updateSetCalls[0] as { status: string; revokedReason: string };
    expect(set.status).toBe('revoked');
    expect(set.revokedReason).toBe('compromised');
    expect(busMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.revoked',
      ORG_ID,
      expect.objectContaining({ elevationRequestId: REQ_ID }),
      'pam-admin',
    );
  });

  it('409s when the request is not in an active status', async () => {
    rigTransaction({ row: { ...activeRow, status: 'pending' }, casWins: false });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'nope' }),
    });

    expect(res.status).toBe(409);
  });

  it('requires a reason', async () => {
    rigTransaction({ row: { ...activeRow, status: 'approved' }, casWins: true });

    const res = await app().request(`/pam/elevation-requests/${REQ_ID}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /pam/rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
  });

  it('rejects a rule with no executable criterion (400)', async () => {
    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'naked rule',
        verdict: 'auto_approve',
        timeWindow: { start: '00:00', end: '23:59' },
      }),
    });
    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('creates a rule with a criterion and lowercases the hash', async () => {
    const returning = vi.fn().mockResolvedValue([
      { id: 'rule-1', name: 'allow tool', verdict: 'auto_approve', priority: 100 },
    ]);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({ returning })),
    } as any);

    const res = await app().request('/pam/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'allow tool',
        verdict: 'auto_approve',
        matchHash: 'A'.repeat(64),
      }),
    });

    expect(res.status).toBe(201);
    const valuesArg = (vi.mocked(db.insert).mock.results[0]!.value.values as any).mock
      .calls[0][0] as { matchHash: string; orgId: string };
    expect(valuesArg.matchHash).toBe('a'.repeat(64));
    expect(valuesArg.orgId).toBe(ORG_ID);
  });
});
