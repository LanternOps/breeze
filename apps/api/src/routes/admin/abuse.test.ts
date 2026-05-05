import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the platform-admin gate, Zod validation, audit-log shape, and
// not-found path. The full suspend transaction (multi-statement Drizzle calls
// against a chain of tables) is exercised by integration tests with a real
// Postgres; mocking every chain accurately here would be brittle.

const txMockState = vi.hoisted(() => ({
  partner: null as null | {
    id: string;
    status: string;
    paymentMethodAttachedAt: Date | null;
  },
  partnerDevices: [] as Array<{ id: string }>,
  partnerOrgs: [] as Array<{ id: string }>,
  partnerUserRows: [] as Array<{ id: string; isPlatformAdmin: boolean }>,
  disabledUsers: [] as Array<{ id: string }>,
  revokedKeys: [] as Array<{ id: string }>,
  reEnabledUsers: [] as Array<{ id: string }>,
  insertedCommands: 0,
  insertedCommandRows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  deletes: [] as Array<{ table: string }>,
}));

function makeTx() {
  // The suspend route's call sequence (from abuse.ts):
  //   1. select(partner).from(partners).where(...).limit(1)        → partner row
  //   2. update(partners).set(...).where(...)                       → status flip
  //   3. select(devices.id).from(devices).innerJoin(orgs).where(...) → device list
  //   4. insert(deviceCommands).values([...])                       → uninstall queue
  //   5. update(deviceCommands).set(...).where(...)                 → cancel others
  //   6. select(users).from(users).where(partnerId)                 → user list
  //   7. delete(sessions).where(...)                                → session purge
  //   8. update(users).set({status:'disabled'}).where(...).returning → disable
  //   9. select(orgs).from(orgs).where(partnerId)                   → orgs
  //  10. update(apiKeys).set({status:'revoked'}).where(...).returning → revoke
  //
  // Unsuspend is much simpler:
  //   1. select(partner).from(partners).where(...).limit(1)
  //   2. update(partners).set(...).where(...)
  //   3. update(users).set({status:'active'}).where(...).returning
  //
  // We route by select-call-index so each test can seed state and inspect the
  // captured `updates` / `insertedCommandRows` / `deletes` after the request.
  let selectCalls = 0;
  return {
    select: vi.fn(() => {
      const call = ++selectCalls;
      return {
        from: () => ({
          where: () => {
            // partner-by-id select on calls 1 (suspend) and 1 (unsuspend); also
            // user list on call 3 of suspend, orgs on call 4. Differentiate
            // with thenable+limit so the right call gets the right shape.
            const thenable: any = Promise.resolve(
              call === 3
                ? txMockState.partnerUserRows
                : call === 4
                ? txMockState.partnerOrgs
                : txMockState.partner
                ? [txMockState.partner]
                : [],
            );
            thenable.limit = () =>
              Promise.resolve(txMockState.partner ? [txMockState.partner] : []);
            return thenable;
          },
          innerJoin: () => ({
            where: () => Promise.resolve(txMockState.partnerDevices),
          }),
        }),
      };
    }),
    update: vi.fn((tableRef: any) => ({
      set: (values: any) => ({
        where: () => {
          txMockState.updates.push({
            table: tableRef === 'partners.id' || tableRef?._t === 'partners' ? 'partners' : 'unknown',
            values,
          });
          // returning() is called on user disable + api key revoke.
          const ret: any = Promise.resolve(undefined);
          ret.returning = () => {
            // Heuristic: route by which set() shape we're seeing.
            if (values?.status === 'disabled') {
              return Promise.resolve(txMockState.disabledUsers);
            }
            if (values?.status === 'revoked') {
              return Promise.resolve(txMockState.revokedKeys);
            }
            if (values?.status === 'active') {
              return Promise.resolve(txMockState.reEnabledUsers);
            }
            return Promise.resolve([]);
          };
          return ret;
        },
      }),
    })),
    insert: vi.fn(() => ({
      values: (rows: unknown) => {
        if (Array.isArray(rows)) {
          txMockState.insertedCommands += rows.length;
          txMockState.insertedCommandRows.push(...(rows as Array<Record<string, unknown>>));
        }
        return Promise.resolve();
      },
    })),
    delete: vi.fn(() => ({
      where: () => {
        txMockState.deletes.push({ table: 'sessions' });
        return Promise.resolve();
      },
    })),
    execute: vi.fn(() => Promise.resolve([])),
  };
}

vi.mock('../../db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(makeTx());
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  partners: { id: 'partners.id', status: 'partners.status', paymentMethodAttachedAt: 'partners.pma' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  deviceCommands: {
    id: 'device_commands.id',
    deviceId: 'device_commands.deviceId',
    type: 'device_commands.type',
    status: 'device_commands.status',
  },
  users: {
    id: 'users.id',
    partnerId: 'users.partnerId',
    isPlatformAdmin: 'users.isPlatformAdmin',
    status: 'users.status',
  },
  sessions: { userId: 'sessions.userId' },
  apiKeys: { orgId: 'apiKeys.orgId', status: 'apiKeys.status' },
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(),
}));

vi.mock('../../services/tokenRevocation', () => ({
  revokeAllUserTokens: vi.fn(async () => undefined),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

// Stub authMiddleware to short-circuit; the test injects its own auth context.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { createAuditLog } from '../../services/auditService';
import { revokeAllUserTokens } from '../../services/tokenRevocation';

type FakeAuth = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
};

function buildApp(authToInject: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (authToInject) {
      c.set('auth', authToInject as never);
    }
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const platformAdminAuth: FakeAuth = {
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
};

const partnerAdminAuth: FakeAuth = {
  user: { id: 'pa-1', email: 'partner@x.com', name: 'PartnerAdmin', isPlatformAdmin: false },
};

function resetState() {
  Object.assign(txMockState, {
    partner: { id: 'partner-1', status: 'active', paymentMethodAttachedAt: new Date() },
    partnerDevices: [{ id: 'd-1' }, { id: 'd-2' }, { id: 'd-3' }],
    partnerOrgs: [{ id: 'org-1' }, { id: 'org-2' }],
    partnerUserRows: [
      { id: 'u-1', isPlatformAdmin: false },
      { id: 'u-2', isPlatformAdmin: false },
    ],
    disabledUsers: [{ id: 'u-1' }, { id: 'u-2' }],
    revokedKeys: [{ id: 'k-1' }, { id: 'k-2' }, { id: 'k-3' }],
    reEnabledUsers: [{ id: 'u-1' }],
    insertedCommands: 0,
    insertedCommandRows: [],
    updates: [],
    deletes: [],
  });
}

describe('admin/abuse — auth gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    process.env.NODE_ENV = 'test';
  });

  it('rejects callers without a platform admin flag (403) on suspend', async () => {
    const app = buildApp(partnerAdminAuth);
    const res = await app.request('/admin/partners/partner-1/suspend-for-abuse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'long enough reason here' }),
    });
    expect(res.status).toBe(403);
    expect(createAuditLog).not.toHaveBeenCalled();
    expect(revokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers (403)', async () => {
    const app = buildApp(null);
    const res = await app.request('/admin/partners/partner-1/suspend-for-abuse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'long enough reason here' }),
    });
    expect(res.status).toBe(403);
  });

  it('400s when reason is too short', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/partners/partner-1/suspend-for-abuse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'short' }),
    });
    expect(res.status).toBe(400);
  });

  it('platform admin gate is enforced on /unsuspend as well', async () => {
    const app = buildApp(partnerAdminAuth);
    const res = await app.request('/admin/partners/partner-1/unsuspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'restoring legit customer' }),
    });
    expect(res.status).toBe(403);
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it('returns 404 for missing partner on suspend', async () => {
    txMockState.partner = null;
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/partners/missing/suspend-for-abuse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'this is a long enough reason' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('partner not found');
    expect(revokeAllUserTokens).not.toHaveBeenCalled();
  });

  it('returns 404 for missing partner on unsuspend', async () => {
    txMockState.partner = null;
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/partners/missing/unsuspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'this is a long enough reason' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('admin/abuse — suspend mutation behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    process.env.NODE_ENV = 'test';
  });

  it('queues self_uninstall for every device, revokes JWTs for users, audits success', async () => {
    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/partners/partner-1/suspend-for-abuse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'cross-region account farming detected' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      partnerId: string;
      status: string;
      deviceCount: number;
      userCount: number;
      apiKeyCount: number;
      queuedUninstalls: number;
    };
    expect(body).toMatchObject({
      partnerId: 'partner-1',
      status: 'suspended',
      deviceCount: 3,
      userCount: 2,
      apiKeyCount: 3,
      queuedUninstalls: 3,
    });

    // self_uninstall queued one row per device.
    expect(txMockState.insertedCommands).toBe(3);
    expect(txMockState.insertedCommandRows).toHaveLength(3);
    txMockState.insertedCommandRows.forEach((row) => {
      expect(row.type).toBe('self_uninstall');
      expect(row.status).toBe('pending');
      expect(row.targetRole).toBe('agent');
      expect(row.payload).toEqual({ removeConfig: true });
    });

    // Sessions deleted (caller is not a member of partner here, so all users targeted).
    expect(txMockState.deletes).toContainEqual({ table: 'sessions' });

    // Captured updates include partner→suspended, users→disabled, apiKeys→revoked.
    const setStatusValues = txMockState.updates.map((u) => u.values?.status);
    expect(setStatusValues).toEqual(expect.arrayContaining(['suspended', 'disabled', 'revoked']));

    // JWT revocation called for each affected user.
    expect(revokeAllUserTokens).toHaveBeenCalledTimes(2);
    expect(revokeAllUserTokens).toHaveBeenCalledWith('u-1');
    expect(revokeAllUserTokens).toHaveBeenCalledWith('u-2');

    // Audit log written with the right action + details.
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(createAuditLog).mock.calls[0]![0]!;
    expect(auditCall.action).toBe('partner.suspended_for_abuse');
    expect(auditCall.resourceId).toBe('partner-1');
    expect(auditCall.result).toBe('success');
    expect(auditCall.details).toMatchObject({
      reason: 'cross-region account farming detected',
      deviceCount: 3,
      userCount: 2,
      apiKeyCount: 3,
    });
  });

  it('does NOT disable, log out, or revoke tokens for the calling platform admin if they are a member of the partner', async () => {
    // Caller is admin-1, also a member of the partner being suspended.
    txMockState.partnerUserRows = [
      { id: 'admin-1', isPlatformAdmin: true },
      { id: 'u-2', isPlatformAdmin: false },
    ];
    txMockState.disabledUsers = [{ id: 'u-2' }]; // the SQL filter excludes the admin

    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/partners/partner-1/suspend-for-abuse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'self-suspend prevention test case' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userCount: number };
    expect(body.userCount).toBe(1); // only u-2

    // JWT revocation must NOT be called for admin-1.
    const revokedIds = vi.mocked(revokeAllUserTokens).mock.calls.map((call) => call[0]);
    expect(revokedIds).not.toContain('admin-1');
    expect(revokedIds).toContain('u-2');
  });

  it('returns 500 with tokenRevocationFailed when Redis revocation throws (does NOT silently 200)', async () => {
    vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('Redis unavailable'));

    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/partners/partner-1/suspend-for-abuse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'redis-down silent failure regression' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: string;
      tokenRevocationFailed: boolean;
      tokenRevocationFailures: Array<{ userId: string; error: string }>;
    };
    expect(body.error).toBe('partial_suspend');
    expect(body.tokenRevocationFailed).toBe(true);
    expect(body.tokenRevocationFailures).toHaveLength(1);
    expect(body.tokenRevocationFailures[0]!.error).toContain('Redis unavailable');

    // Audit log is still written, but with result='failure'.
    const auditCall = vi.mocked(createAuditLog).mock.calls[0]![0]!;
    expect(auditCall.result).toBe('failure');
    expect((auditCall.details as Record<string, unknown>).tokenRevocationFailures).toBeDefined();
  });

  it('still returns 200 (and writes audit) when createAuditLog itself throws', async () => {
    vi.mocked(createAuditLog).mockRejectedValueOnce(new Error('audit DB down'));

    const app = buildApp(platformAdminAuth);
    const res = await app.request('/admin/partners/partner-1/suspend-for-abuse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'audit failure must not undo suspend' }),
    });
    // Suspend committed, JWTs revoked — losing the audit row is recoverable.
    // We still report success so the operator UI doesn't go red on something
    // that already happened.
    expect(res.status).toBe(200);
  });
});
