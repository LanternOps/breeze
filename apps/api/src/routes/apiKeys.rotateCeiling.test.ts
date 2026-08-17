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

const { authRef, permissionsRef, existingKeyRef, creatorAuthzRef } = vi.hoisted(() => ({
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
          limit: vi.fn(() => Promise.resolve([existingKeyRef.current])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
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
      })),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({ apiKeys: {}, organizations: {} }));

vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));

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
    superiorCaller();
    existingKeyRef.current = {
      id: KEY_ID,
      orgId: ORG_ID,
      status: 'active',
      createdBy: 'victim',
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
    expect(body.error).toMatch(/revoke it instead of rotating it/);
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
