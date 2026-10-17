import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { normalizeMcpDomainsInput } from '@breeze/shared';
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
  apiKeys: { mcpDomains: { col: 'api_keys.mcp_domains' } },
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

vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));

// The delegation ceiling (same permission set as scope delegation) is covered in
// apiKeys.mutationCeiling.test.ts; stub it so the widening re-check below is the
// only thing that can deny a PATCH.
vi.mock('../services/delegationCeiling', async (importActual) => ({
  ...(await importActual<typeof import('../services/delegationCeiling')>()),
  checkDelegationCeiling: vi.fn(() => ({ ok: true })),
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { createAuditLogAsync } from '../services/auditService';

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
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        partnerId: null,
        orgId: ORG_ID,
        token: { mfa: true, aep: 1, mep: 1 },
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
    const selectReturning = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    } as any);
    vi.mocked(db.select)
      // The key, rotated by its own creator...
      .mockReturnValueOnce(selectReturning([{
        id: KEY_ID,
        orgId: ORG_ID,
        status: 'active',
        createdBy: 'user-123'
      }]))
      // ...then the creator's guarded users row.
      .mockReturnValueOnce(selectReturning([{ credentialEpoch: 1 }]));
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

  describe('mcpDomains (#6156)', () => {
    const selectReturning = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    } as any);

    function asFullAccess() {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization', partnerId: null, orgId: ORG_ID,
          token: { aep: 1, mep: 1 },
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        c.set('permissions', {
          permissions: [{ resource: '*', action: '*' }],
          partnerId: null, orgId: ORG_ID, roleId: 'role-1', scope: 'organization'
        });
        return next();
      });
    }

    function mockCreate() {
      const captured: { values?: Record<string, any> } = {};
      asFullAccess();
      vi.mocked(db.select).mockReturnValueOnce(selectReturning([{ credentialEpoch: 1 }]));
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn((values: Record<string, unknown>) => {
          captured.values = values;
          return {
            returning: vi.fn(() => Promise.resolve([{
              id: KEY_ID, orgId: ORG_ID, name: 'K', keyPrefix: 'brz_abc12345',
              scopes: values.scopes, mcpDomains: values.mcpDomains ?? null,
              expiresAt: null, rateLimit: 1000, createdBy: 'user-123',
              createdAt: new Date(), status: 'active'
            }]))
          };
        })
      } as any);
      return captured;
    }

    const createWith = (extra: Record<string, unknown>, scopes: string[] = ['ai:read']) =>
      app.request('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID, name: 'K', scopes, rateLimit: 1000, ...extra })
      });

    function mockPatch(existing: Record<string, unknown>, updatedExtra: Record<string, unknown> = {}) {
      const captured: { set?: Record<string, unknown>; returningArg?: Record<string, unknown> } = {};
      vi.mocked(db.select).mockReturnValue(selectReturning([{
        id: KEY_ID, orgId: ORG_ID, name: 'K', status: 'active', createdBy: 'user-123', ...existing
      }]));
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn((set: Record<string, unknown>) => {
          captured.set = set;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn((arg?: Record<string, unknown>) => {
                captured.returningArg = arg;
                return Promise.resolve([{
                  id: KEY_ID, orgId: ORG_ID, name: 'K', scopes: existing.scopes ?? [],
                  mcpDomains: existing.mcpDomains ?? null, rateLimit: 1000, status: 'active',
                  ...updatedExtra
                }]);
              })
            })
          };
        })
      } as any);
      return captured;
    }

    const patch = (body: Record<string, unknown>) =>
      app.request(`/api-keys/${KEY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

    it('create without mcpDomains stores null', async () => {
      const captured = mockCreate();
      const res = await createWith({});
      expect(res.status).toBe(201);
      expect(captured.values).toHaveProperty('mcpDomains', null);
      expect((await res.json()).mcpDomains).toBeNull();
    });

    it('create with ["tickets","devices"] stores the normalized order', async () => {
      const captured = mockCreate();
      const res = await createWith({ mcpDomains: ['tickets', 'devices', 'tickets'] });
      expect(res.status).toBe(201);
      const stored = captured.values?.mcpDomains as string[];
      expect(stored).toHaveLength(2);
      expect(new Set(stored)).toEqual(new Set(['tickets', 'devices']));
      expect(stored).toEqual(normalizeMcpDomainsInput(['tickets', 'devices'] as any));
      expect((await res.json()).mcpDomains).toEqual(stored);
    });

    it('create rejects core / [] / unknown with 400', async () => {
      for (const bad of [['core'], [], ['not-a-domain']]) {
        asFullAccess();
        const res = await createWith({ mcpDomains: bad });
        expect(res.status).toBe(400);
      }
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('patch null widens to unrestricted; patch omitted leaves it', async () => {
      const cleared = mockPatch({ scopes: ['ai:read'], mcpDomains: ['tickets'] }, { mcpDomains: null });
      const res1 = await patch({ mcpDomains: null });
      expect(res1.status).toBe(200);
      expect(cleared.set).toHaveProperty('mcpDomains', null);

      const untouched = mockPatch({ scopes: ['ai:read'], mcpDomains: ['tickets'] });
      const res2 = await patch({ name: 'Renamed' });
      expect(res2.status).toBe(200);
      expect(untouched.set).not.toHaveProperty('mcpDomains');
    });

    it('list and get return mcpDomains', async () => {
      const row = {
        id: KEY_ID, orgId: ORG_ID, name: 'K', keyPrefix: 'brz_abc12345', scopes: ['ai:read'],
        mcpDomains: ['tickets'], status: 'active'
      };
      const listSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ offset: vi.fn().mockResolvedValue([row]) })
            })
          })
        })
      });
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 1 }]) })
        } as any)
        .mockImplementationOnce(listSelect as any);
      const listRes = await app.request('/api-keys', { method: 'GET' });
      expect((await listRes.json()).data[0].mcpDomains).toEqual(['tickets']);
      expect(listSelect.mock.calls[0]?.[0]).toHaveProperty('mcpDomains');

      const getSelect = vi.fn().mockReturnValue(selectReturning([row]));
      vi.mocked(db.select).mockImplementationOnce(getSelect as any);
      const getRes = await app.request(`/api-keys/${KEY_ID}`, { method: 'GET' });
      expect((await getRes.json()).mcpDomains).toEqual(['tickets']);
      expect(getSelect.mock.calls[0]?.[0]).toHaveProperty('mcpDomains');
    });

    it('patch returning columns include mcpDomains', async () => {
      const patched = mockPatch({ scopes: ['ai:read'] });
      await patch({ name: 'x' });
      expect(patched.returningArg).toHaveProperty('mcpDomains');
    });

    it('rotate keeps mcpDomains', async () => {
      asFullAccess();
      vi.mocked(db.select)
        .mockReturnValueOnce(selectReturning([{
          id: KEY_ID, orgId: ORG_ID, status: 'active', createdBy: 'user-123',
          scopes: ['ai:read'], mcpDomains: ['tickets']
        }]))
        .mockReturnValueOnce(selectReturning([{ credentialEpoch: 1 }]));
      let setArg: Record<string, unknown> | undefined;
      let returningArg: Record<string, unknown> | undefined;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn((s: Record<string, unknown>) => {
          setArg = s;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn((arg: Record<string, unknown>) => {
                returningArg = arg;
                return Promise.resolve([{
                  id: KEY_ID, orgId: ORG_ID, name: 'K', keyPrefix: 'brz_rotated',
                  scopes: ['ai:read'], mcpDomains: ['tickets'], status: 'active'
                }]);
              })
            })
          };
        })
      } as any);

      const res = await app.request(`/api-keys/${KEY_ID}/rotate`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await res.json()).mcpDomains).toEqual(['tickets']);
      expect(setArg).not.toHaveProperty('mcpDomains'); // in-place rotation never rewrites it
      expect(returningArg).toHaveProperty('mcpDomains');
    });

    it('mcpDomains is accepted without ai:* scopes but is inert', async () => {
      const captured = mockCreate();
      const res = await createWith({ mcpDomains: ['tickets'] }, ['devices:read']);
      expect(res.status).toBe(201);
      expect(captured.values?.mcpDomains).toEqual(['tickets']);
    });

    it("widening domains runs scope delegation for the updater against the key's current scopes", async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization', partnerId: null, orgId: ORG_ID,
          user: { id: 'user-123', email: 'test@example.com' },
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        c.set('permissions', {
          permissions: [{ resource: 'organizations', action: 'write' }],
          partnerId: null, orgId: ORG_ID, roleId: 'limited', scope: 'organization'
        });
        return next();
      });

      // widen ['tickets'] -> null on an ai:execute key: denied
      mockPatch({ scopes: ['ai:execute'], mcpDomains: ['tickets'] });
      const denied = await patch({ mcpDomains: null });
      expect(denied.status).toBe(403);
      expect((await denied.json()).error).toMatch(/Cannot delegate API key scope "ai:execute"/);
      expect(db.update).not.toHaveBeenCalled();

      // adding a domain also widens: denied
      const addDenied = await patch({ mcpDomains: ['tickets', 'devices'] });
      expect(addDenied.status).toBe(403);

      // narrowing to a subset: allowed
      mockPatch({ scopes: ['ai:execute'], mcpDomains: ['tickets', 'devices'] });
      const narrowed = await patch({ mcpDomains: ['tickets'] });
      expect(narrowed.status).toBe(200);
    });

    it('update audit carries previous and new mcpDomains', async () => {
      mockPatch({ scopes: ['ai:read'], mcpDomains: ['tickets', 'devices'] }, { mcpDomains: ['tickets'] });
      const res = await patch({ mcpDomains: ['tickets'] });
      expect(res.status).toBe(200);
      const call = vi.mocked(createAuditLogAsync).mock.calls.find((c) => c[0].action === 'api_key.update');
      expect(call?.[0].details).toMatchObject({
        mcpDomains: { previous: ['tickets', 'devices'], next: ['tickets'] }
      });
    });

    it('create audit carries mcpDomains', async () => {
      mockCreate();
      await createWith({ mcpDomains: ['tickets'] });
      const call = vi.mocked(createAuditLogAsync).mock.calls.find((c) => c[0].action === 'api_key.create');
      expect(call?.[0].details).toMatchObject({ mcpDomains: ['tickets'] });
    });
  });
});
