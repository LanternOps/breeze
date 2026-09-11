/**
 * API-key mutations must not let a site-restricted administrator reshape or
 * revoke a live credential whose effective authority reaches broader sites.
 * The key's creator is resolved live because API keys inherit that authority;
 * org membership alone is not an org-wide key-management capability.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OWNER_PARTNER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const {
  authRef,
  permissionsRef,
  existingKeyRef,
  creatorAuthzRef,
  ownerTenantRef,
  updateMock,
} = vi.hoisted(() => ({
  authRef: { current: null as any },
  permissionsRef: { current: null as any },
  existingKeyRef: { current: null as any },
  // Either a fixed result, or a function of the resolver INPUT so a test can
  // prove which partner axis the route passed down.
  creatorAuthzRef: { current: null as any },
  ownerTenantRef: { current: null as any },
  updateMock: vi.fn(),
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
    update: updateMock,
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));
vi.mock('../db/schema', () => ({ apiKeys: {}, organizations: {} }));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../services/apiKeyAuthorization', () => ({
  authorizeHumanApiKeyCreator: vi.fn(async (input: any) =>
    typeof creatorAuthzRef.current === 'function'
      ? creatorAuthzRef.current(input)
      : creatorAuthzRef.current,
  ),
}));
vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ownerTenantRef.current),
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

import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { authorizeHumanApiKeyCreator } from '../services/apiKeyAuthorization';
import { getActiveOrgTenant } from '../services/tenantStatus';
import { apiKeyRoutes } from './apiKeys';

function request(app: Hono, method: 'PATCH' | 'DELETE', body?: Record<string, unknown>) {
  return app.request(`/api-keys/${KEY_ID}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('PATCH/DELETE /api-keys/:id — live delegation ceiling', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = {
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      allowedSiteIds: ['site-a'],
      user: { id: 'lesser-admin', email: 'lesser@example.com' },
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
    };
    permissionsRef.current = {
      permissions: [
        { resource: 'organizations', action: 'write' },
        { resource: 'devices', action: 'read' },
      ],
      partnerId: null,
      orgId: ORG_ID,
      roleId: 'restricted-admin',
      scope: 'organization',
    };
    existingKeyRef.current = {
      id: KEY_ID,
      orgId: ORG_ID,
      name: 'Broad key',
      status: 'active',
      createdBy: 'unrestricted-owner',
      scopes: ['devices:read'],
      principalType: 'human',
      principalId: null,
    };
    ownerTenantRef.current = { orgId: ORG_ID, partnerId: OWNER_PARTNER_ID };
    creatorAuthzRef.current = {
      ok: true,
      permissions: {
        permissions: [{ resource: 'devices', action: 'read' }],
        scope: 'organization',
      },
      allowedSiteIds: undefined,
      clampedScopes: ['devices:read'],
    };
    updateMock.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{
            ...existingKeyRef.current,
            keyPrefix: 'brz_example',
            status: 'revoked',
          }]),
        })),
      })),
    });
    app = new Hono();
    app.route('/api-keys', apiKeyRoutes);
  });

  it.each([
    ['rename', { name: 'Disrupted' }],
    ['throttle', { rateLimit: 1 }],
    ['scope change the caller otherwise holds', { scopes: ['devices:read'] }],
  ])('denies a site-restricted caller attempting %s with zero write/audit', async (_label, body) => {
    const res = await request(app, 'PATCH', body);

    expect(res.status).toBe(403);
    expect((await res.json()).details.violation).toBe('site');
    expect(db.update).not.toHaveBeenCalled();
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('denies revoking a live unrestricted key with zero write/audit', async () => {
    const res = await request(app, 'DELETE');

    expect(res.status).toBe(403);
    expect((await res.json()).details.violation).toBe('site');
    expect(db.update).not.toHaveBeenCalled();
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('treats an empty site allowlist as restricted rather than unrestricted', async () => {
    authRef.current.allowedSiteIds = [];

    const res = await request(app, 'DELETE');

    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('denies a site-restricted caller mutating an org-wide service-principal key', async () => {
    existingKeyRef.current.principalType = 'service';
    existingKeyRef.current.principalId = 'principal-1';

    const res = await request(app, 'PATCH', { rateLimit: 10 });

    expect(res.status).toBe(403);
    expect((await res.json()).details.violation).toBe('site');
    expect(authorizeHumanApiKeyCreator).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('denies on the permission axis before changing the key', async () => {
    authRef.current.allowedSiteIds = undefined;
    permissionsRef.current.permissions = [{ resource: 'organizations', action: 'write' }];

    const res = await request(app, 'PATCH', { rateLimit: 10 });

    expect(res.status).toBe(403);
    expect((await res.json()).details).toMatchObject({
      violation: 'permission',
      missingPermission: 'devices:read',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('denies on the scope axis before revoking the key', async () => {
    authRef.current.allowedSiteIds = undefined;
    creatorAuthzRef.current.permissions.scope = 'partner';

    const res = await request(app, 'DELETE');

    expect(res.status).toBe(403);
    expect((await res.json()).details.violation).toBe('scope');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('allows mutation when the key creator is confined to a subset of the caller sites', async () => {
    authRef.current.allowedSiteIds = ['site-a', 'site-b'];
    creatorAuthzRef.current.allowedSiteIds = ['site-a'];

    expect((await request(app, 'PATCH', { rateLimit: 25 })).status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('allows revocation when the key creator is confined to the caller site', async () => {
    creatorAuthzRef.current.allowedSiteIds = ['site-a'];

    const res = await request(app, 'DELETE');

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('denies updating a key whose human creator can no longer be authorized', async () => {
    creatorAuthzRef.current = { ok: false, reason: 'no_membership' };

    const res = await request(app, 'PATCH', { name: 'Orphan' });

    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('still permits revoking an already-dead orphan key', async () => {
    creatorAuthzRef.current = { ok: false, reason: 'no_membership' };

    const res = await request(app, 'DELETE');

    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('fails closed when request permissions were not resolved', async () => {
    permissionsRef.current = undefined;

    const res = await request(app, 'PATCH', { rateLimit: 25 });

    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  /**
   * A key minted by a Partner Admin has NO `organization_users` row, so it only
   * resolves on the partner axis. Org-session JWTs deliberately carry
   * partnerId = null, so resolving the creator with the CALLER's partnerId
   * leaves that axis unresolved and reports a live, working partner-admin key
   * as `no_membership` — which used to hand the DELETE recovery carve-out an
   * org-wide credential. The route must resolve the KEY ORG's owning partner,
   * exactly as the request path does (middleware/apiKeyAuth.ts).
   */
  describe('partner-admin-created keys under an org-scoped caller', () => {
    // Resolves only when handed the owning partner — the shape
    // `getUserPermissions` actually has for a Partner Admin.
    const partnerAdminCreator = (input: { partnerId: string | null }) =>
      input.partnerId === OWNER_PARTNER_ID
        ? {
            ok: true,
            permissions: {
              permissions: [{ resource: 'devices', action: 'read' }],
              scope: 'partner',
            },
            allowedSiteIds: undefined,
            clampedScopes: ['devices:read'],
          }
        : { ok: false, reason: 'no_membership' };

    beforeEach(() => {
      creatorAuthzRef.current = partnerAdminCreator;
    });

    it('resolves the creator against the key org owning partner, not the caller', async () => {
      await request(app, 'DELETE');

      expect(getActiveOrgTenant).toHaveBeenCalledWith(ORG_ID);
      expect(authorizeHumanApiKeyCreator).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, partnerId: OWNER_PARTNER_ID }),
      );
    });

    it('denies a site-restricted org caller revoking a LIVE partner-admin key', async () => {
      const res = await request(app, 'DELETE');

      expect(res.status).toBe(403);
      expect((await res.json()).details.violation).toBe('scope');
      expect(db.update).not.toHaveBeenCalled();
      expect(createAuditLogAsync).not.toHaveBeenCalled();
    });

    it('denies an UNRESTRICTED org caller revoking a LIVE partner-admin key', async () => {
      authRef.current.allowedSiteIds = undefined;

      const res = await request(app, 'DELETE');

      expect(res.status).toBe(403);
      expect((await res.json()).details.violation).toBe('scope');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('denies an org caller PATCHing a live partner-admin key as a ceiling violation, not a dead owner', async () => {
      authRef.current.allowedSiteIds = undefined;

      const res = await request(app, 'PATCH', { name: 'Renamed' });
      const body = await res.json();

      expect(res.status).toBe(403);
      // The old axis bug reported this healthy key as an unauthorizable owner.
      expect(body.details.violation).toBe('scope');
      expect(body.error).not.toMatch(/can no longer be authorized/);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('lets an unrestricted partner caller PATCH a partner-admin key', async () => {
      authRef.current = {
        ...authRef.current,
        scope: 'partner',
        partnerId: OWNER_PARTNER_ID,
        allowedSiteIds: undefined,
      };

      const res = await request(app, 'PATCH', { rateLimit: 25 });

      expect(res.status).toBe(200);
      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });

  it('does not extend the revocation carve-out to a creator whose scopes were reduced', async () => {
    creatorAuthzRef.current = { ok: false, reason: 'scope_exceeds_current_permissions' };

    const res = await request(app, 'DELETE');

    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not apply the revocation carve-out when the creator lookup itself failed', async () => {
    // The owning tenant resolves, so `ownerTenantResolved` is true and only the
    // creator read failed. `authorizeHumanApiKeyCreator` catches its own DB/RLS
    // fault and reports `lookup_error` (it does not reject), and that reason
    // establishes NOTHING about the creator — so a transient DB/Redis blip must
    // not be read as "provably dead" and authorize revoking a LIVE credential.
    creatorAuthzRef.current = { ok: false, reason: 'lookup_error' };

    const res = await request(app, 'DELETE');

    expect(res.status).toBe(403);
    expect((await res.json()).details.reason).toBe('lookup_error');
    expect(db.update).not.toHaveBeenCalled();
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('does not apply the revocation carve-out when the owning tenant cannot be resolved', async () => {
    ownerTenantRef.current = null;
    creatorAuthzRef.current = { ok: false, reason: 'no_membership' };

    const res = await request(app, 'DELETE');

    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });
});
