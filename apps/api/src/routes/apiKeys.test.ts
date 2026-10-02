import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { apiKeyRoutes } from './apiKeys';

// Valid UUID constants for tests
const KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }))
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

vi.mock('../services/tenantStatus', () => ({
  // The mutation/rotation ceiling resolves the key ORG's owning partner here
  // (mirroring middleware/apiKeyAuth.ts) before re-authorizing the creator.
  getActiveOrgTenant: vi.fn(async (orgId: string) => ({ orgId, partnerId: 'partner-1' })),
}));

vi.mock('../db/schema', () => ({
  apiKeys: {},
  organizations: {},
  // Sentinel columns so the mint guard's WHERE predicate can be inspected.
  users: {
    id: { col: 'users.id' },
    status: { col: 'users.status' },
    authEpoch: { col: 'users.auth_epoch' },
    mfaEpoch: { col: 'users.mfa_epoch' },
    credentialEpoch: { col: 'users.credential_epoch' },
  }
}));

// The §1.4 rotation delegation ceiling resolves the key's delegating creator
// through this service. Default it to "creator is an ordinary org user with no
// site restriction" so the happy-path rotate test still exercises the handler;
// the ceiling's own denials are covered in apiKeys.rotateCeiling.test.ts.
vi.mock('../services/apiKeyAuthorization', () => ({
  authorizeHumanApiKeyCreator: vi.fn(async () => ({
    ok: true,
    permissions: {
      permissions: [{ resource: '*', action: '*' }],
      partnerId: null,
      orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      roleId: 'role-1',
      scope: 'organization'
    },
    allowedSiteIds: undefined,
    clampedScopes: []
  }))
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      partnerId: null,
      orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      token: { mfa: true },
      user: { id: 'user-123', email: 'test@example.com' },
      canAccessOrg: (orgId: string) => orgId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    });
    c.set('permissions', {
      permissions: [{ resource: '*', action: '*' }],
      partnerId: null,
      orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      roleId: 'role-1',
      scope: 'organization'
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
  // AuthZ/MFA gates are tested elsewhere; keep these route tests focused on handler behavior.
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

describe('api keys routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: ORG_ID,
        user: { id: 'user-123', email: 'test@example.com' },
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      c.set('permissions', {
        permissions: [{ resource: '*', action: '*' }],
        partnerId: null,
        orgId: ORG_ID,
        roleId: 'role-1',
        scope: 'organization'
      });
      return next();
    });
    app = new Hono();
    app.route('/api-keys', apiKeyRoutes);
  });

  it('should list API keys', async () => {
    const keys = [
      {
        id: KEY_ID,
        orgId: ORG_ID,
        name: 'Primary Key',
        keyPrefix: 'brz_abc12345',
        scopes: ['read'],
        expiresAt: null,
        lastUsedAt: null,
        usageCount: 0,
        rateLimit: 1000,
        createdBy: 'user-123',
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'active'
      }
    ];

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(keys)
              })
            })
          })
        })
      } as any);

    const res = await app.request('/api-keys?page=1&limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
  });

  it.skip('should create an API key', async () => {
    // Skipped: Requires crypto mock for key generation
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: KEY_ID,
          orgId: ORG_ID,
          name: 'Primary Key',
          keyPrefix: 'brz_abc12345',
          scopes: ['read'],
          expiresAt: null,
          rateLimit: 1000,
          createdBy: 'user-123',
          createdAt: new Date(),
          status: 'active'
        }])
      })
    } as any);

    const res = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: ORG_ID,
        name: 'Primary Key',
        scopes: ['read'],
        rateLimit: 1000
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^brz_/);
    expect(body.warning).toBeDefined();
  });

  describe('creator epoch snapshot at mint (#7489)', () => {
    function mockInsertCapture() {
      const captured: { values?: Record<string, unknown> } = {};
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn((values: Record<string, unknown>) => {
          captured.values = values;
          return {
            returning: vi.fn().mockResolvedValue([{
              id: KEY_ID,
              orgId: ORG_ID,
              name: 'Primary Key',
              keyPrefix: 'brz_abc12345',
              scopes: [],
              expiresAt: null,
              rateLimit: 1000,
              createdBy: 'user-123',
              createdAt: new Date(),
              status: 'active'
            }])
          };
        })
      } as any);
      return captured;
    }

    function mockLiveCreatorRow(rows: Array<Record<string, unknown>>) {
      const captured: { where?: unknown } = {};
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn((predicate: unknown) => {
            captured.where = predicate;
            return { limit: vi.fn(() => Promise.resolve(rows)) };
          })
        }))
      } as any);
      return captured;
    }

    // Flatten a drizzle SQL tree into its leaf chunks (columns + bound values).
    function sqlLeaves(node: unknown, out: unknown[] = []): unknown[] {
      const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
      if (!chunks) {
        out.push(node);
        return out;
      }
      for (const chunk of chunks) sqlLeaves(chunk, out);
      return out;
    }

    // `eq(col, value)` renders as [col, " = ", value]: find the value bound to col.
    function boundValue(leaves: unknown[], col: string): unknown {
      const i = leaves.findIndex((l) => (l as { col?: string } | null)?.col === col);
      if (i < 0) return undefined;
      const rest = leaves.slice(i + 1).find((l) => {
        const text = (l as { value?: unknown } | null)?.value;
        return !(Array.isArray(text) && text.every((t) => typeof t === 'string'));
      });
      return rest;
    }

    function authWithToken(token: Record<string, unknown>) {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId: ORG_ID,
          token,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        c.set('permissions', {
          permissions: [{ resource: '*', action: '*' }],
          partnerId: null,
          orgId: ORG_ID,
          roleId: 'role-1',
          scope: 'organization'
        });
        return next();
      });
    }

    function createKey() {
      return app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID, name: 'Primary Key', scopes: [], rateLimit: 1000 })
      });
    }

    it('stamps the creator live credential epoch (plus the token auth/mfa epochs) onto a newly minted key', async () => {
      const captured = mockInsertCapture();
      authWithToken({ aep: 5, mep: 2 });
      const guard = mockLiveCreatorRow([{ credentialEpoch: 3 }]);

      const res = await createKey();

      expect(res.status).toBe(201);
      // The live read is guarded on this session's validated epochs and an
      // active creator — without those conditions it could stamp a credential
      // epoch newer than the minting session, or mint for a disabled user.
      const leaves = sqlLeaves(guard.where);
      expect(boundValue(leaves, 'users.id')).toBe('user-123');
      expect(boundValue(leaves, 'users.status')).toBe('active');
      expect(boundValue(leaves, 'users.auth_epoch')).toBe(5);
      expect(boundValue(leaves, 'users.mfa_epoch')).toBe(2);
      expect(captured.values).toMatchObject({
        creatorAuthEpoch: 5,
        creatorMfaEpoch: 2,
        creatorCredentialEpoch: 3,
      });
    });

    it('refuses to mint when the session epochs no longer match the creator live row', async () => {
      // The guarded read matched no row: the creator's auth/mfa epoch moved
      // (or they were disabled) after authMiddleware validated this request.
      mockInsertCapture();
      authWithToken({ aep: 5, mep: 2 });
      mockLiveCreatorRow([]);

      const res = await createKey();

      expect(res.status).toBe(401);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('refuses to mint an unbound key when the request token carries no epoch claims', async () => {
      mockInsertCapture();
      authWithToken({ mfa: true });

      const res = await createKey();

      expect(res.status).toBe(401);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  it('rejects wildcard scopes on API key creation', async () => {
    const res = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: ORG_ID,
        name: 'Wildcard Key',
        scopes: ['*'],
        rateLimit: 1000
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Wildcard API key scopes are not supported');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects unknown scopes on API key creation', async () => {
    const res = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: ORG_ID,
        name: 'Unknown Scope Key',
        scopes: ['devices:read', 'not:a-real-scope'],
        rateLimit: 1000
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Unsupported API key scope: not:a-real-scope');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects delegated scopes the creator does not hold', async () => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: ORG_ID,
        user: { id: 'user-123', email: 'test@example.com' },
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      c.set('permissions', {
        permissions: [{ resource: 'organizations', action: 'write' }],
        partnerId: null,
        orgId: ORG_ID,
        roleId: 'limited-role',
        scope: 'organization'
      });
      return next();
    });

    const res = await app.request('/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: ORG_ID,
        name: 'Overdelegated Key',
        scopes: ['devices:execute'],
        rateLimit: 1000
      })
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Cannot delegate API key scope "devices:execute" without devices.execute');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('should fetch an API key by id', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: KEY_ID,
            orgId: ORG_ID,
            name: 'Primary Key',
            keyPrefix: 'brz_abc12345',
            scopes: ['read'],
            expiresAt: null,
            lastUsedAt: null,
            usageCount: 0,
            rateLimit: 1000,
            createdBy: 'user-123',
            createdAt: new Date(),
            updatedAt: new Date(),
            status: 'active'
          }])
        })
      })
    } as any);

    const res = await app.request(`/api-keys/${KEY_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(KEY_ID);
    expect(body.orgId).toBe(ORG_ID);
  });

  it('should update an API key', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: KEY_ID,
            orgId: ORG_ID,
            name: 'Primary Key',
            status: 'active'
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: KEY_ID,
            orgId: ORG_ID,
            name: 'Updated Key',
            keyPrefix: 'brz_abc12345',
            scopes: ['devices:read', 'devices:write'],
            expiresAt: null,
            lastUsedAt: null,
            usageCount: 0,
            rateLimit: 2000,
            createdBy: 'user-123',
            createdAt: new Date(),
            updatedAt: new Date(),
            status: 'active'
          }])
        })
      })
    } as any);

    const res = await app.request(`/api-keys/${KEY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Updated Key',
        scopes: ['devices:read', 'devices:write'],
        rateLimit: 2000
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Updated Key');
    expect(body.rateLimit).toBe(2000);
  });

  it('rejects wildcard scopes on API key update', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: KEY_ID,
            orgId: ORG_ID,
            name: 'Primary Key',
            status: 'active'
          }])
        })
      })
    } as any);

    const res = await app.request(`/api-keys/${KEY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: ['*'] })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Wildcard API key scopes are not supported');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('should revoke an API key', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: KEY_ID,
            orgId: ORG_ID,
            status: 'active'
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: KEY_ID,
            name: 'Primary Key',
            keyPrefix: 'brz_abc12345',
            status: 'revoked',
            updatedAt: new Date()
          }])
        })
      })
    } as any);

    const res = await app.request(`/api-keys/${KEY_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.apiKey.status).toBe('revoked');
  });

  it('should rotate an API key', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: KEY_ID,
            orgId: ORG_ID,
            status: 'active'
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: KEY_ID,
            orgId: ORG_ID,
            name: 'Primary Key',
            keyPrefix: 'brz_rotated',
            scopes: ['read'],
            expiresAt: null,
            rateLimit: 1000,
            createdBy: 'user-123',
            createdAt: new Date(),
            updatedAt: new Date(),
            status: 'active'
          }])
        })
      })
    } as any);

    const res = await app.request(`/api-keys/${KEY_ID}/rotate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^brz_/);
    expect(body.warning).toBeDefined();
  });
});
