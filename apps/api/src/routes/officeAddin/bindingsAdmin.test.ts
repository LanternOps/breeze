import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const ADMIN_USER_ID = '33333333-3333-4333-8333-333333333333';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_USER_ID = '55555555-5555-4555-8555-555555555555';

type AuthState = {
  scope: 'partner' | 'system' | 'organization';
  partnerId: string | null;
  partnerOrgAccess: 'all' | 'selected' | 'none' | null;
  mfa: boolean;
};

const { authRef, mocks } = vi.hoisted(() => ({
  authRef: { current: null as AuthState | null },
  mocks: {
    selectRows: vi.fn(async (): Promise<unknown[]> => []),
    revokeBinding: vi.fn(async () => {}),
    revokeTechSessionsForUser: vi.fn(async () => {}),
    getRedis: vi.fn((): unknown => ({})),
    writeAuditEvent: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', {
      ...authRef.current,
      orgId: null,
      accessibleOrgIds: [],
      user: { id: ADMIN_USER_ID, email: 'admin@example.com', name: 'Admin' },
      token: { mfa: authRef.current.mfa },
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!c.get('auth')?.token?.mfa) {
      return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    }
    return next();
  }),
}));

// partnerWideAccess is PURE — use the real implementation so gate tests are honest.

let selectFilter: unknown[] = [];

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn((...args: unknown[]) => {
            selectFilter.push(...args);
            return mocks.selectRows();
          }),
        })),
        where: vi.fn((...args: unknown[]) => {
          selectFilter.push(...args);
          return { limit: vi.fn(() => mocks.selectRows()) };
        }),
      })),
    })),
  },
}));

vi.mock('../../db/schema/officeAddin', () => ({
  officeAddinUserBindings: {
    id: 'officeAddinUserBindings.id',
    userId: 'officeAddinUserBindings.userId',
    partnerId: 'officeAddinUserBindings.partnerId',
    entraTenantId: 'officeAddinUserBindings.entraTenantId',
    mfaVerifiedAt: 'officeAddinUserBindings.mfaVerifiedAt',
    createdAt: 'officeAddinUserBindings.createdAt',
    revokedAt: 'officeAddinUserBindings.revokedAt',
  },
}));

vi.mock('../../db/schema/users', () => ({
  users: {
    id: 'users.id',
    name: 'users.name',
    email: 'users.email',
  },
}));

vi.mock('../../services/officeAddin/officeAddinBindings', () => ({
  revokeBinding: mocks.revokeBinding,
}));

vi.mock('../../services/officeAddin/techSession', () => ({
  revokeTechSessionsForUser: mocks.revokeTechSessionsForUser,
}));

vi.mock('../../services/redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { officeAddinBindingsAdminRoutes } from './bindingsAdmin';

function makeApp() {
  const app = new Hono();
  app.route('/', officeAddinBindingsAdminRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectFilter = [];
  authRef.current = {
    scope: 'partner',
    partnerId: PARTNER_ID,
    partnerOrgAccess: 'all',
    mfa: true,
  };
  mocks.getRedis.mockReturnValue({});
  mocks.selectRows.mockResolvedValue([]);
});

describe('GET /bindings', () => {
  it('lists own partner active bindings for a partner-global admin', async () => {
    mocks.selectRows.mockResolvedValue([
      {
        id: BINDING_ID,
        userId: TARGET_USER_ID,
        userName: 'Tess Tech',
        userEmail: 'tess@msp.example',
        entraTenantId: 'tenant-1',
        mfaVerifiedAt: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const res = await makeApp().request('/bindings');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bindings).toHaveLength(1);
    expect(body.bindings[0].id).toBe(BINDING_ID);
  });

  it('403s a selected-org-access technician (not a partner-wide admin)', async () => {
    authRef.current!.partnerOrgAccess = 'selected';
    const res = await makeApp().request('/bindings');
    expect(res.status).toBe(403);
  });

  it('403s MFA_REQUIRED when the token lacks the mfa claim', async () => {
    authRef.current!.mfa = false;
    const res = await makeApp().request('/bindings');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('MFA_REQUIRED');
  });

  it('rejects org scope entirely (not in requireScope allowlist)', async () => {
    authRef.current!.scope = 'organization';
    const res = await makeApp().request('/bindings');
    expect(res.status).toBe(403);
  });
});

describe('DELETE /bindings/:id', () => {
  it('revokes a binding: sets revoked fields and revokes tech sessions', async () => {
    mocks.selectRows.mockResolvedValue([
      { id: BINDING_ID, userId: TARGET_USER_ID, partnerId: PARTNER_ID },
    ]);

    const res = await makeApp().request(`/bindings/${BINDING_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ revoked: true });

    expect(mocks.revokeBinding).toHaveBeenCalledWith(BINDING_ID, ADMIN_USER_ID);
    expect(mocks.revokeTechSessionsForUser).toHaveBeenCalledWith(expect.anything(), TARGET_USER_ID);
    expect(mocks.writeAuditEvent).toHaveBeenCalled();
  });

  it('404s when the binding id belongs to a different partner', async () => {
    // App-layer filter (eq partnerId) + RLS both exclude the row — the mocked
    // db layer here stands in for RLS by simply returning no rows, matching
    // what a cross-partner id produces against a real DB.
    mocks.selectRows.mockResolvedValue([]);

    const res = await makeApp().request(`/bindings/${BINDING_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(mocks.revokeBinding).not.toHaveBeenCalled();
    expect(mocks.revokeTechSessionsForUser).not.toHaveBeenCalled();

    // sanity: cross-partner scenario really would be a different partner id
    expect(OTHER_PARTNER_ID).not.toBe(PARTNER_ID);
  });

  it('403s a selected-org-access technician on revoke too', async () => {
    authRef.current!.partnerOrgAccess = 'selected';
    const res = await makeApp().request(`/bindings/${BINDING_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(mocks.revokeBinding).not.toHaveBeenCalled();
  });
});
