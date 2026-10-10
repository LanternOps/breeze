/**
 * §1.4 — API-key rotation must not hand a broader key's plaintext to a lesser
 * admin. Rotation regenerates the secret but leaves scopes and the delegating
 * `created_by` untouched, so the rotator walks away with the key's authority.
 * `ensureOrgAccess` only proves org membership; these tests assert the three
 * delegation-ceiling axes actually deny, and — the important half — that a
 * legitimately-superior caller still succeeds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const { authRef, permissionsRef, existingKeyRef, creatorAuthzRef, selectCalls, rotatedSet } = vi.hoisted(() => ({
  selectCalls: { count: 0 },
  rotatedSet: { current: null as any },
  authRef: { current: null as any },
  permissionsRef: { current: null as any },
  existingKeyRef: { current: null as any },
  creatorAuthzRef: { current: null as any },
}));

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            // First read: the key. Second: the creator's guarded users row.
            selectCalls.count += 1;
            return Promise.resolve(selectCalls.count === 1 ? [existingKeyRef.current] : [{ credentialEpoch: 9 }]);
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: any) => {
        rotatedSet.current = values;
        return {
        where: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.resolve([
              {
                id: KEY_ID,
                orgId: ORG_ID,
                name: 'Victim Key',
                keyPrefix: 'brz_rotated',
                scopes: existingKeyRef.current?.scopes ?? [],
                status: 'active',
              },
            ])
          ),
        })),
        };
      }),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({ apiKeys: {}, organizations: {}, users: {} }));

vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));

vi.mock('../services/tenantStatus', () => ({
  // The mutation/rotation ceiling resolves the key ORG's owning partner here
  // (mirroring middleware/apiKeyAuth.ts) before re-authorizing the creator.
  getActiveOrgTenant: vi.fn(async (orgId: string) => ({ orgId, partnerId: 'partner-1' })),
}));

vi.mock('../services/apiKeyAuthorization', () => ({
  authorizeHumanApiKeyCreator: vi.fn(async () => creatorAuthzRef.current),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    c.set('permissions', permissionsRef.current);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { apiKeyRoutes } from './apiKeys';

/** Caller: org scope, holds everything, no site restriction. */
function superiorCaller() {
  authRef.current = {
    scope: 'organization',
    partnerId: null,
    orgId: ORG_ID,
    allowedSiteIds: undefined,
    user: { id: 'boss', email: 'boss@example.com' },
    token: { aep: 4, mep: 2 },
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
  };
  permissionsRef.current = {
    permissions: [{ resource: '*', action: '*' }],
    partnerId: null,
    orgId: ORG_ID,
    roleId: 'role-admin',
    scope: 'organization',
  };
}

function rotate(app: Hono) {
  return app.request(`/api-keys/${KEY_ID}/rotate`, {
    method: 'POST',
    headers: { Authorization: 'Bearer token' },
  });
}

describe('POST /api-keys/:id/rotate — delegation ceiling (§1.4)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectCalls.count = 0;
    rotatedSet.current = null;
    superiorCaller();
    existingKeyRef.current = {
      id: KEY_ID,
      orgId: ORG_ID,
      status: 'active',
      // The rotator is the key's creator: only the creator may re-mint it
      // (non-creator cases below). The ceiling still applies to the creator.
      createdBy: 'boss',
      scopes: ['devices:read'],
      principalType: 'human',
      principalId: null,
    };
    creatorAuthzRef.current = {
      ok: true,
      permissions: {
        permissions: [{ resource: 'devices', action: 'read' }],
        partnerId: null,
        orgId: ORG_ID,
        roleId: 'role-victim',
        scope: 'organization',
      },
      allowedSiteIds: undefined,
      clampedScopes: ['devices:read'],
    };
    app = new Hono();
    app.route('/api-keys', apiKeyRoutes);
  });

  it('POSITIVE CONTROL: a caller whose authority covers the key rotates it and gets plaintext', async () => {
    const res = await rotate(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^brz_/);
  });

  it('re-binds a rotated key to the creator\'s current session and credential state', async () => {
    const res = await rotate(app);
    expect(res.status).toBe(200);
    expect(rotatedSet.current).toMatchObject({
      creatorAuthEpoch: 4,
      creatorMfaEpoch: 2,
      creatorCredentialEpoch: 9,
    });
  });

  it('refuses rotation when the session no longer matches the creator\'s live row', async () => {
    const { db } = await import('../db');
    vi.mocked(db.select).mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([existingKeyRef.current]) }) }),
    }) as any).mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }) as any);

    const res = await rotate(app);
    expect(res.status).toBe(401);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses rotation by anyone other than the key\'s creator, before any write', async () => {
    const { db } = await import('../db');
    existingKeyRef.current.createdBy = 'someone-else';

    const res = await rotate(app);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('API_KEY_CREATOR_REQUIRED');
    expect(body.key).toBeUndefined();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses rotation of a service-principal key by anyone other than its creator', async () => {
    existingKeyRef.current.createdBy = 'someone-else';
    existingKeyRef.current.principalType = 'service';
    existingKeyRef.current.principalId = 'sp-1';

    const res = await rotate(app);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('API_KEY_CREATOR_REQUIRED');
  });

  it('denies on the PERMISSION axis when the key carries a scope the rotator lacks', async () => {
    // The core §1.4 escalation: caller has organizations:write (enough to reach
    // the route) but not scripts:execute, which the victim's key confers.
    permissionsRef.current = {
      permissions: [{ resource: 'organizations', action: 'write' }],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'role-lesser',
      scope: 'organization',
    };
    existingKeyRef.current.scopes = ['scripts:execute'];

    const res = await rotate(app);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.details.violation).toBe('permission');
    expect(body.details.missingPermission).toBe('scripts:execute');
  });

  it('denies on the SCOPE axis when an org caller rotates a partner-scope credential', async () => {
    creatorAuthzRef.current.permissions.scope = 'partner';

    const res = await rotate(app);
    expect(res.status).toBe(403);
    expect((await res.json()).details.violation).toBe('scope');
  });

  it('denies on the SITE axis when a site-restricted caller rotates an unrestricted key', async () => {
    authRef.current.allowedSiteIds = ['site-1'];
    creatorAuthzRef.current.allowedSiteIds = undefined;

    const res = await rotate(app);
    expect(res.status).toBe(403);
    expect((await res.json()).details.violation).toBe('site');
  });

  it('allows a site-restricted caller to rotate a key confined to their own sites', async () => {
    authRef.current.allowedSiteIds = ['site-1', 'site-2'];
    creatorAuthzRef.current.allowedSiteIds = ['site-1'];

    const res = await rotate(app);
    expect(res.status).toBe(200);
  });

  it('denies when the key\'s delegating creator can no longer be authorized', async () => {
    creatorAuthzRef.current = { ok: false, reason: 'no_membership' };

    const res = await rotate(app);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/revoke it instead/);
  });

  it('denies when the request carries no resolved permissions at all (fail closed)', async () => {
    permissionsRef.current = undefined;

    const res = await rotate(app);
    expect(res.status).toBe(403);
  });

  it('runs the ceiling BEFORE any write — a denied rotation must not touch the row', async () => {
    const { db } = await import('../db');
    permissionsRef.current = {
      permissions: [{ resource: 'organizations', action: 'write' }],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'role-lesser',
      scope: 'organization',
    };
    existingKeyRef.current.scopes = ['scripts:execute'];

    const res = await rotate(app);
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('service-principal keys skip creator resolution but still face the ceiling', async () => {
    existingKeyRef.current.principalType = 'service';
    existingKeyRef.current.principalId = 'sp-1';
    existingKeyRef.current.scopes = ['scripts:execute'];
    permissionsRef.current = {
      permissions: [{ resource: 'organizations', action: 'write' }],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'role-lesser',
      scope: 'organization',
    };

    const { authorizeHumanApiKeyCreator } = await import('../services/apiKeyAuthorization');
    const res = await rotate(app);

    expect(res.status).toBe(403);
    expect(authorizeHumanApiKeyCreator).not.toHaveBeenCalled();
  });
});
