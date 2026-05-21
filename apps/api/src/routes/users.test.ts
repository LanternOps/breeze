import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Set the avatar storage dir to a per-test-run tmp path BEFORE importing the
// service (the service reads process.env.AVATAR_STORAGE_PATH at module load).
const TMP_AVATAR_DIR = mkdtempSync(join(tmpdir(), 'breeze-avatar-test-'));
process.env.AVATAR_STORAGE_PATH = TMP_AVATAR_DIR;

import { userRoutes } from './users';

const {
  sendInviteMock,
  sendEmailChangedMock,
  createAuditLogAsyncMock,
  resolveUserAuditOrgIdMock,
  requireCurrentPasswordStepUpMock,
  isPasswordAuthDisabledBySsoMock,
  hasSatisfiedMfaMock,
  captureExceptionMock,
  getEmailServiceMock
} = vi.hoisted(() => ({
  sendInviteMock: vi.fn().mockResolvedValue(undefined),
  sendEmailChangedMock: vi.fn().mockResolvedValue(undefined),
  createAuditLogAsyncMock: vi.fn().mockResolvedValue(undefined),
  resolveUserAuditOrgIdMock: vi.fn().mockResolvedValue(null),
  captureExceptionMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
  // Default: step-up succeeds (returns null). Tests override to return a
  // Response to simulate a wrong password / rate-limit / Redis-down outcome.
  requireCurrentPasswordStepUpMock: vi.fn().mockResolvedValue(null),
  // Default: org does NOT enforce SSO.
  isPasswordAuthDisabledBySsoMock: vi.fn().mockResolvedValue(false),
  // Default: MFA is considered satisfied. Tests override to false.
  hasSatisfiedMfaMock: vi.fn().mockReturnValue(true)
}));

vi.mock('../services/permissions', () => ({
  clearPermissionCache: vi.fn(),
  getUserPermissions: vi.fn().mockResolvedValue({
    permissions: [{ resource: '*', action: '*' }],
    partnerId: 'partner-123',
    orgId: null,
    roleId: 'role-admin',
    scope: 'partner'
  }),
  hasPermission: vi.fn((userPerms: any, resource: string, action: string) =>
    userPerms.permissions.some((p: any) =>
      (p.resource === resource || p.resource === '*') &&
      (p.action === action || p.action === '*')
    )
  ),
  isAssignablePermission: vi.fn((permission: any) =>
    permission.resource !== '*' &&
    permission.action !== '*' &&
    ['users:read', 'users:invite', 'users:write', 'users:delete', 'devices:read', 'devices:write', 'devices:execute']
      .includes(`${permission.resource}:${permission.action}`)
  ),
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
    USERS_INVITE: { resource: 'users', action: 'invite' },
    USERS_WRITE: { resource: 'users', action: 'write' },
    USERS_DELETE: { resource: 'users', action: 'delete' },
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
    ADMIN_ALL: { resource: '*', action: '*' }
  }
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    transaction: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  users: {},
  partnerUsers: {},
  organizationUsers: {},
  roles: {},
  permissions: {},
  rolePermissions: {},
  organizations: {},
  patchPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'unknown'] },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      partnerId: 'partner-123',
      orgId: null,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  hasSatisfiedMfa: hasSatisfiedMfaMock
}));

vi.mock('./auth/ssoPolicy', () => ({
  isPasswordAuthDisabledBySso: isPasswordAuthDisabledBySsoMock
}));

vi.mock('../services/email', () => ({
  getEmailService: getEmailServiceMock
}));

vi.mock('../services/sentry', () => ({
  captureException: captureExceptionMock
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: createAuditLogAsyncMock
}));

vi.mock('../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => undefined)
}));

vi.mock('./auth/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth/helpers')>();
  return {
    ...actual,
    resolveUserAuditOrgId: resolveUserAuditOrgIdMock,
    requireCurrentPasswordStepUp: requireCurrentPasswordStepUpMock
  };
});

vi.mock('../services/tokenRevocation', () => ({
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/userSuspension', () => ({
  revokeUserAccess: vi.fn().mockResolvedValue({
    grantsRevoked: 0,
    refreshTokensRevoked: 0,
    jtisRevoked: 0,
  })
}));

vi.mock('../services/remoteSessionTeardown', () => ({
  terminateUserRemoteSessions: vi.fn().mockResolvedValue(0),
  TEARDOWN_FAILED: -1,
}));

import { db } from '../db';
import { clearPermissionCache, getUserPermissions } from '../services/permissions';
import { authMiddleware } from '../middleware/auth';
import { revokeAllUserTokens } from '../services/tokenRevocation';
import { terminateUserRemoteSessions } from '../services/remoteSessionTeardown';

describe('user routes', () => {
  let app: Hono;

  afterAll(() => {
    if (existsSync(TMP_AVATAR_DIR)) {
      rmSync(TMP_AVATAR_DIR, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks only clears call history — it does NOT drain queued
    // mockReturnValueOnce implementations or reset mockReturnValue. Re-seed the
    // db builders to safe defaults so each test starts from a clean chain and is
    // order-independent (prevents leftover select/update mocks from one test
    // poisoning the next, e.g. POST /users/:id/role).
    vi.mocked(db.select).mockReset().mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    } as any);
    vi.mocked(db.update).mockReset().mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    } as any);
    // Re-establish the step-up defaults each test: SSO off, MFA satisfied,
    // password step-up passes.
    requireCurrentPasswordStepUpMock.mockResolvedValue(null);
    isPasswordAuthDisabledBySsoMock.mockResolvedValue(false);
    hasSatisfiedMfaMock.mockReturnValue(true);
    sendEmailChangedMock.mockResolvedValue(undefined);
    // Default: email service is configured. Tests override to null to exercise
    // the "not configured" warning path.
    getEmailServiceMock.mockReturnValue({
      sendInvite: sendInviteMock,
      sendEmailChanged: sendEmailChangedMock
    });
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        orgId: null,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    app = new Hono();
    app.route('/users', userRoutes);
  });

  describe('GET /users', () => {
    it('should list partner users', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  id: '11111111-1111-1111-1111-111111111111',
                  email: 'user@example.com',
                  name: 'Partner User',
                  status: 'active',
                  roleId: 'role-1',
                  roleName: 'Admin',
                  orgAccess: 'all',
                  orgIds: null
                }
              ])
            })
          })
        })
      } as any);

      const res = await app.request('/users', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer token'
        }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].email).toBe('user@example.com');
    });

    it('should reject missing partner/org context', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'system',
          partnerId: null,
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });

      const res = await app.request('/users', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer token'
        }
      });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /users/invite', () => {
    it('should invite a partner user with selected orgs', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: '22222222-2222-2222-2222-222222222222',
                scope: 'partner',
                name: 'Admin',
                description: null,
                isSystem: true,
                partnerId: null,
                orgId: null
              }
            ])
          })
        })
      } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ parentRoleId: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const txSelect = vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        });

      const txInsert = vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'invitee@example.com',
                name: 'Invitee',
                status: 'invited'
              }
            ])
          })
        })
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'link-1' }])
          })
        });

      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ select: txSelect, insert: txInsert } as any);
      });

      const res = await app.request('/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invitee@example.com',
          name: 'Invitee',
          roleId: '22222222-2222-2222-2222-222222222222',
          orgAccess: 'selected',
          orgIds: ['33333333-3333-3333-3333-333333333333']
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.email).toBe('invitee@example.com');
      expect(body.status).toBe('invited');
      expect(clearPermissionCache).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('should require orgIds when orgAccess is selected', async () => {
      const res = await app.request('/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'invitee@example.com',
          name: 'Invitee',
          roleId: '22222222-2222-2222-2222-222222222222',
          orgAccess: 'selected'
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('orgIds');
    });
  });

  describe('POST /users/resend-invite', () => {
    it('should resend an invite for invited users', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: '11111111-1111-1111-1111-111111111111',
                    email: 'invitee@example.com',
                    name: 'Invitee',
                    status: 'invited',
                    roleId: 'role-1',
                    roleName: 'Admin',
                    orgAccess: 'all',
                    orgIds: null
                  }
                ])
              })
            })
          })
        })
      } as any);

      const res = await app.request('/users/resend-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: '11111111-1111-1111-1111-111111111111'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('PATCH /users/me validation', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId: 'org-1',
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
      // The handler loads the caller's own row first; provide it so body-level
      // validation (e.g. the preferences-size guard) is reached. Zod-rejected
      // cases short-circuit before the handler and are unaffected.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ email: 'test@example.com', passwordHash: 'hash' }])
          })
        })
      } as any);
    });

    it('rejects invalid email format', async () => {
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'not-an-email' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects unknown top-level fields (strict schema)', async () => {
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'ok', role: 'admin' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects huge preferences payload (>64KB)', async () => {
      // build ~70KB blob
      const big = 'x'.repeat(70 * 1024);
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ preferences: { blob: big } })
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /users/me audit coverage (SOC2)', () => {
    // Every successful self-profile change MUST produce an audit_logs row,
    // regardless of caller scope. Partner-scope callers have orgId === null,
    // so the audit must resolve an attribution org via resolveUserAuditOrgId
    // rather than being skipped entirely (the SOC2 coverage gap).

    // Builds a select(...) chain node that resolves to `rows`.
    const selectNode = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    });

    function mockProfileUpdateReturning(
      row: Record<string, unknown>,
      self: { email: string; passwordHash: string | null } = {
        email: 'test@example.com',
        passwordHash: 'hash'
      }
    ) {
      // The handler now issues db.select twice when the email changes:
      //   1) load the caller's own row ({ email, passwordHash })
      //   2) email uniqueness check (no conflicting row → [])
      // Name-only changes only issue (1). Fall through default returns [] so the
      // uniqueness check (when reached) never reports a conflict.
      vi.mocked(db.select)
        .mockReturnValueOnce(selectNode([self]) as any)
        .mockReturnValue(selectNode([]) as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([row])
          })
        })
      } as any);
    }

    it('audits a partner-scope self-profile change (orgId resolved via resolveUserAuditOrgId)', async () => {
      // Partner-scope caller: auth.orgId === null. Pre-fix the handler skips
      // the audit because it is guarded by `if (auth.orgId)`. This asserts the
      // audit fires with an org resolved from the user's membership.
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
      resolveUserAuditOrgIdMock.mockResolvedValueOnce('resolved-org-1');
      mockProfileUpdateReturning({
        id: 'user-123',
        email: 'test@example.com',
        name: 'New Partner Name',
        avatarUrl: null,
        status: 'active',
        mfaEnabled: false,
        preferences: null
      });

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New Partner Name' })
      });

      expect(res.status).toBe(200);
      expect(resolveUserAuditOrgIdMock).toHaveBeenCalledWith('user-123');
      expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'resolved-org-1',
          actorId: 'user-123',
          action: 'user.profile.update',
          resourceType: 'user',
          resourceId: 'user-123',
          result: 'success',
          details: expect.objectContaining({ changedFields: ['name'] })
        })
      );
    });

    it('audits a partner-scope self profile change (non-email, no step-up)', async () => {
      // Previously this test PATCHed { email } with no password. The email-change
      // step-up now requires currentPassword, so the email-change audit behavior
      // moved into the dedicated "email change step-up" describe below. This test
      // preserves the original INTENT — partner-scope self-changes are audited as
      // user.profile.update — by exercising a non-email field (name). (avatarUrl
      // is no longer a PATCH /me field; avatars are managed via /users/me/avatar.)
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          orgId: null,
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
      resolveUserAuditOrgIdMock.mockResolvedValueOnce('resolved-org-2');
      mockProfileUpdateReturning({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Renamed User',
        avatarUrl: null,
        status: 'active',
        mfaEnabled: false,
        preferences: null
      });

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Renamed User' })
      });

      expect(res.status).toBe(200);
      // No email change → no step-up of any kind.
      expect(requireCurrentPasswordStepUpMock).not.toHaveBeenCalled();
      expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'resolved-org-2',
          action: 'user.profile.update',
          details: expect.objectContaining({ changedFields: ['name'] })
        })
      );
    });

    it('still audits an org-scope self-profile change (no regression, no resolve needed)', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId: 'org-1',
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
      mockProfileUpdateReturning({
        id: 'user-123',
        email: 'test@example.com',
        name: 'New Org Name',
        avatarUrl: null,
        status: 'active',
        mfaEnabled: false,
        preferences: null
      });

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New Org Name' })
      });

      expect(res.status).toBe(200);
      // Org context is present, so no fallback resolution is required.
      expect(resolveUserAuditOrgIdMock).not.toHaveBeenCalled();
      expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-1',
          action: 'user.profile.update',
          details: expect.objectContaining({ changedFields: ['name'] })
        })
      );
    });
  });

  describe('PATCH /users/me email-change step-up (ATO hardening)', () => {
    // Account-takeover step-up: changing the account email requires re-proving
    // identity. Mirrors change-password — SSO-enforced orgs are blocked (managed
    // at the IdP), local-password users must supply currentPassword, passwordless
    // users must have satisfied MFA. On success the OLD address is notified.
    const selectNode = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    });

    const updateReturning = (row: Record<string, unknown>) => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([row])
          })
        })
      } as any);
    };

    // First select = self load ({ email, passwordHash }); second select (only
    // reached past the step-up gate) = email-uniqueness check.
    const mockSelfAndUniqueness = (
      self: { email: string; passwordHash: string | null },
      uniqueness: unknown[] = []
    ) => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectNode([self]) as any)
        .mockReturnValue(selectNode(uniqueness) as any);
    };

    const orgScopeAuth = () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId: 'org-1',
          user: { id: 'user-123', email: 'old@example.com' }
        });
        return next();
      });
    };

    const updatedRow = (email: string) => ({
      id: 'user-123',
      email,
      name: 'Test User',
      avatarUrl: null,
      status: 'active',
      mfaEnabled: false,
      preferences: null
    });

    it('case 1: email change with NO currentPassword ⇒ 400, email not updated', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning(updatedRow('new@example.com'));

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'new@example.com' })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/current password is required/i);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
      expect(requireCurrentPasswordStepUpMock).not.toHaveBeenCalled();
      expect(sendEmailChangedMock).not.toHaveBeenCalled();
    });

    it('case 2: email change with correct currentPassword ⇒ 200, audited, old address notified', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning(updatedRow('new@example.com'));
      requireCurrentPasswordStepUpMock.mockResolvedValueOnce(null);

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'new@example.com', currentPassword: 'correct-horse' })
      });

      expect(res.status).toBe(200);
      expect(requireCurrentPasswordStepUpMock).toHaveBeenCalledWith(
        expect.anything(),
        'user-123',
        'correct-horse',
        'email-change:pwd'
      );
      // Dedicated email-change audit fired with stepUp === 'password'.
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.email.change',
          resourceId: 'user-123',
          orgId: 'org-1',
          details: expect.objectContaining({
            previousEmail: 'old@example.com',
            newEmail: 'new@example.com',
            stepUp: 'password'
          })
        })
      );
      // Both audits: the generic profile-update + the dedicated email-change.
      const actions = createAuditLogAsyncMock.mock.calls.map((c: any[]) => c[0].action);
      expect(actions).toContain('user.profile.update');
      expect(actions).toContain('user.email.change');
      // Notify the OLD address.
      expect(sendEmailChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'old@example.com', newEmail: 'new@example.com' })
      );
    });

    it('case 3: email change with wrong password ⇒ 401, not updated, no email-change audit/notice', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning(updatedRow('new@example.com'));
      // Simulate a wrong-password step-up: helper returns a 401 Response.
      requireCurrentPasswordStepUpMock.mockImplementationOnce(async (c: any) =>
        c.json({ error: 'Invalid credentials' }, 401)
      );

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'new@example.com', currentPassword: 'wrong' })
      });

      expect(res.status).toBe(401);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
      const actions = createAuditLogAsyncMock.mock.calls.map((c: any[]) => c[0].action);
      expect(actions).not.toContain('user.email.change');
      expect(sendEmailChangedMock).not.toHaveBeenCalled();
    });

    it('case 4a: passwordless user WITHOUT satisfied MFA ⇒ 403, not updated', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: null });
      updateReturning(updatedRow('new@example.com'));
      hasSatisfiedMfaMock.mockReturnValue(false);

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'new@example.com' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/mfa/i);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
      // Passwordless → password step-up must not be attempted.
      expect(requireCurrentPasswordStepUpMock).not.toHaveBeenCalled();
      expect(sendEmailChangedMock).not.toHaveBeenCalled();
    });

    it('case 4b: passwordless user WITH satisfied MFA ⇒ 200, audited stepUp === mfa', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: null });
      updateReturning(updatedRow('new@example.com'));
      hasSatisfiedMfaMock.mockReturnValue(true);

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'new@example.com' })
      });

      expect(res.status).toBe(200);
      expect(requireCurrentPasswordStepUpMock).not.toHaveBeenCalled();
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.email.change',
          orgId: 'org-1',
          details: expect.objectContaining({
            previousEmail: 'old@example.com',
            newEmail: 'new@example.com',
            stepUp: 'mfa'
          })
        })
      );
      expect(sendEmailChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'old@example.com', newEmail: 'new@example.com' })
      );
    });

    it('case 5: enforce-SSO org ⇒ 403, email not updated', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning(updatedRow('new@example.com'));
      isPasswordAuthDisabledBySsoMock.mockResolvedValue(true);

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'new@example.com', currentPassword: 'correct-horse' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/sso/i);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
      expect(requireCurrentPasswordStepUpMock).not.toHaveBeenCalled();
      expect(sendEmailChangedMock).not.toHaveBeenCalled();
    });

    it('case 6: name-only change ⇒ 200, no step-up invoked, audited as user.profile.update', async () => {
      orgScopeAuth();
      // Only the self-load select runs for a name-only change.
      vi.mocked(db.select).mockReturnValue(
        selectNode([{ email: 'old@example.com', passwordHash: 'hash' }]) as any
      );
      updateReturning({
        id: 'user-123',
        email: 'old@example.com',
        name: 'Renamed',
        avatarUrl: null,
        status: 'active',
        mfaEnabled: false,
        preferences: null
      });

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Renamed' })
      });

      expect(res.status).toBe(200);
      expect(requireCurrentPasswordStepUpMock).not.toHaveBeenCalled();
      expect(isPasswordAuthDisabledBySsoMock).not.toHaveBeenCalled();
      expect(sendEmailChangedMock).not.toHaveBeenCalled();
      const actions = createAuditLogAsyncMock.mock.calls.map((c: any[]) => c[0].action);
      expect(actions).toContain('user.profile.update');
      expect(actions).not.toContain('user.email.change');
    });

    it('case 7: same-email "change" ⇒ no step-up required, 200', async () => {
      orgScopeAuth();
      // body.email === current email (after normalization) → not a real change.
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning(updatedRow('old@example.com'));

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'OLD@example.com' })
      });

      expect(res.status).toBe(200);
      // No real email change → no step-up gate, no notification, no dedicated audit.
      expect(requireCurrentPasswordStepUpMock).not.toHaveBeenCalled();
      expect(isPasswordAuthDisabledBySsoMock).not.toHaveBeenCalled();
      expect(sendEmailChangedMock).not.toHaveBeenCalled();
      const actions = createAuditLogAsyncMock.mock.calls.map((c: any[]) => c[0].action);
      expect(actions).not.toContain('user.email.change');
    });

    it('case 8: PARTNER-scope email change resolves an attribution org for both audits', async () => {
      // Partner-scope caller: auth.orgId === null, so the audit org must be
      // resolved from the user's membership via resolveUserAuditOrgId — for the
      // dedicated email-change audit too, not just the profile-update.
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          orgId: null,
          user: { id: 'user-123', email: 'old@example.com' }
        });
        return next();
      });
      resolveUserAuditOrgIdMock.mockResolvedValueOnce('resolved-org-x');
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning(updatedRow('new@example.com'));
      requireCurrentPasswordStepUpMock.mockResolvedValueOnce(null);

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ email: 'new@example.com', currentPassword: 'correct-horse' })
      });

      expect(res.status).toBe(200);
      expect(resolveUserAuditOrgIdMock).toHaveBeenCalledWith('user-123');
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'user.email.change',
          orgId: 'resolved-org-x',
          details: expect.objectContaining({
            previousEmail: 'old@example.com',
            newEmail: 'new@example.com',
            stepUp: 'password'
          })
        })
      );
    });

    it('case 9: MIXED name+email change ⇒ profile.update lists BOTH fields AND email.change also fires', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning({
        id: 'user-123',
        email: 'new@example.com',
        name: 'New',
        avatarUrl: null,
        status: 'active',
        mfaEnabled: false,
        preferences: null
      });
      // Org scope, step-up passes (null).
      requireCurrentPasswordStepUpMock.mockResolvedValueOnce(null);

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New', email: 'new@example.com', currentPassword: 'correct' })
      });

      expect(res.status).toBe(200);
      const calls = createAuditLogAsyncMock.mock.calls.map((c: any[]) => c[0]);
      const profileUpdate = calls.find((a) => a.action === 'user.profile.update');
      expect(profileUpdate).toBeDefined();
      expect(profileUpdate.details.changedFields).toEqual(
        expect.arrayContaining(['name', 'email'])
      );
      const actions = calls.map((a) => a.action);
      expect(actions).toContain('user.email.change');
    });

    it('case 10a: email service NOT configured ⇒ warns, does not attempt send, still 200', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning(updatedRow('new@example.com'));
      requireCurrentPasswordStepUpMock.mockResolvedValueOnce(null);
      getEmailServiceMock.mockReturnValue(null);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const res = await app.request('/users/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ email: 'new@example.com', currentPassword: 'correct-horse' })
        });

        expect(res.status).toBe(200);
        expect(sendEmailChangedMock).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Email service not configured')
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('case 10b: sendEmailChanged throws ⇒ console.error + captureException, request still 200', async () => {
      orgScopeAuth();
      mockSelfAndUniqueness({ email: 'old@example.com', passwordHash: 'hash' });
      updateReturning(updatedRow('new@example.com'));
      requireCurrentPasswordStepUpMock.mockResolvedValueOnce(null);
      const boom = new Error('smtp down');
      sendEmailChangedMock.mockRejectedValueOnce(boom);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const res = await app.request('/users/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ email: 'new@example.com', currentPassword: 'correct-horse' })
        });

        expect(res.status).toBe(200);
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to send email-change security notice'),
          boom
        );
        expect(captureExceptionMock).toHaveBeenCalledWith(boom);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('PATCH /users/:id (admin update)', () => {
    it('rejects unknown top-level fields including roleId (strict schema)', async () => {
      // The Edit dialog historically sent { email, name, roleId } and roleId was
      // silently dropped because updateUserSchema lacked .strict(). After the
      // hardening, the extra field must surface as 400 instead of a no-op 200.
      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New Name', roleId: '22222222-2222-2222-2222-222222222222' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects an arbitrary extra field (strict schema, defense in depth)', async () => {
      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'New Name', mysteryField: 'oops' })
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /users/:id/role', () => {
    it('should assign a partner role', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: '44444444-4444-4444-4444-444444444444',
                  scope: 'partner',
                  name: 'Operator',
                  description: null,
                  isSystem: false,
                  parentRoleId: null,
                  partnerId: 'partner-123',
                  orgId: null
                }
              ])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ parentRoleId: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'link-1' }])
          })
        })
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roleId: '44444444-4444-4444-4444-444444444444'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(clearPermissionCache).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('rejects self role assignment', async () => {
      const res = await app.request('/users/user-123/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roleId: '44444444-4444-4444-4444-444444444444'
        })
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('rejects assigning roles broader than the caller', async () => {
      vi.mocked(getUserPermissions).mockResolvedValueOnce({
        permissions: [{ resource: 'users', action: 'write' }],
        partnerId: 'partner-123',
        orgId: null,
        roleId: 'role-user-manager',
        scope: 'partner'
      } as any);
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: '44444444-4444-4444-4444-444444444444',
                  scope: 'partner',
                  name: 'Operator',
                  description: null,
                  isSystem: false,
                  parentRoleId: null,
                  partnerId: 'partner-123',
                  orgId: null
                }
              ])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ parentRoleId: null }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ resource: 'devices', action: 'write' }])
            })
          })
        } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roleId: '44444444-4444-4444-4444-444444444444'
        })
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /users/:id (Task 14: JWT revocation on removal)', () => {
    it('removes a partner user and revokes their JWTs', async () => {
      // partner_users delete returns a row → 200, and we expect Redis revoke
      // to fire so the ex-member's ≤15min-TTL access token stops granting
      // partner-scoped reads/writes on the very next request.
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'link-1' }])
        })
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
      expect(revokeAllUserTokens).toHaveBeenCalledTimes(1);
      expect(clearPermissionCache).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('does not revoke JWTs when no row was deleted (404)', async () => {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([])
        })
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      expect(revokeAllUserTokens).not.toHaveBeenCalled();
    });

    it('still 200s when token revocation fails (best-effort)', async () => {
      // Redis outage during revoke — the partner_users row already deleted,
      // we must not roll the response back. The ≤15min-TTL natural expiry
      // is the fallback. Operator visibility comes from the log line.
      vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'link-1' }])
        })
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('removes an organization user and revokes their JWTs', async () => {
      // Same shape for organization-scope removals — org-scoped JWTs also
      // carry an accessibleOrgIds claim that must be invalidated.
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId: 'org-456',
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });

      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'link-2' }])
        })
      } as any);

      const res = await app.request('/users/22222222-2222-2222-2222-222222222222', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(revokeAllUserTokens).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
      expect(revokeAllUserTokens).toHaveBeenCalledTimes(1);
    });
  });

  describe('PATCH /users/:id remote session teardown on deactivation', () => {
    const teardownMock = vi.mocked(terminateUserRemoteSessions);

    // getScopedUser (partner scope) → select().from().innerJoin().innerJoin().where().limit()
    // returns the existing record. Then update(users).set().where().returning()
    // returns the updated row. Seed both so the becameInactive branch runs.
    function seedPatch(
      recordStatus: 'active' | 'invited' | 'disabled',
      updatedStatus: 'active' | 'invited' | 'disabled',
    ) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: '11111111-1111-1111-1111-111111111111',
                    email: 'u@example.com',
                    name: 'User',
                    status: recordStatus,
                    roleId: 'role-1',
                    roleName: 'Admin',
                    orgAccess: 'all',
                    orgIds: null,
                  },
                ]),
              }),
            }),
          }),
        }),
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'u@example.com',
                name: 'User',
                status: updatedStatus,
              },
            ]),
          }),
        }),
      } as any);
    }

    function patchStatus(status: string) {
      return app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ status }),
      });
    }

    it('tears down remote sessions on the active→disabled transition', async () => {
      seedPatch('active', 'disabled');

      const res = await patchStatus('disabled');

      expect(res.status).toBe(200);
      expect(teardownMock).toHaveBeenCalledTimes(1);
      expect(teardownMock).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('returns 503 when teardown reports the failure sentinel', async () => {
      teardownMock.mockResolvedValueOnce(-1);
      seedPatch('active', 'disabled');

      const res = await patchStatus('disabled');

      expect(res.status).toBe(503);
      expect(teardownMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT tear down sessions on a no-op update (name only, still active)', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: '11111111-1111-1111-1111-111111111111',
                    email: 'u@example.com',
                    name: 'User',
                    status: 'active',
                    roleId: 'role-1',
                    roleName: 'Admin',
                    orgAccess: 'all',
                    orgIds: null,
                  },
                ]),
              }),
            }),
          }),
        }),
      } as any);
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'u@example.com',
                name: 'Renamed',
                status: 'active',
              },
            ]),
          }),
        }),
      } as any);

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(200);
      expect(teardownMock).not.toHaveBeenCalled();
    });

    it('does NOT tear down sessions on a reactivation (disabled→active)', async () => {
      seedPatch('disabled', 'active');

      const res = await patchStatus('active');

      expect(res.status).toBe(200);
      expect(teardownMock).not.toHaveBeenCalled();
    });
  });

  describe('avatar endpoints', () => {
    const ME_ID = 'user-123';

    // Minimal valid PNG bytes (1x1 transparent PNG)
    const PNG_BYTES = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);

    // JPEG SOI + minimal junk (FF D8 FF E0 ...). Not a real image but the
    // magic-byte check only inspects the first three bytes.
    const JPEG_BYTES = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 0),
    ]);

    // WebP RIFF header (12 bytes is enough for the sniff function).
    const WEBP_BYTES = Buffer.concat([
      Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x10, 0x00, 0x00, 0x00, // size
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]),
      Buffer.alloc(32, 0),
    ]);

    // SVG with a small XML preamble
    const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf-8');

    function makeUpdateMock(returning: unknown[]) {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(returning)
          })
        })
      } as any);
    }

    function makeMultipart(field: string, bytes: Buffer, mime: string, filename: string): { body: BodyInit; headers: HeadersInit } {
      const formData = new FormData();
      // Buffer's polymorphic ArrayBufferLike confuses the Blob constructor type;
      // copy into a fresh Uint8Array (whose buffer is a plain ArrayBuffer).
      const view = new Uint8Array(bytes.byteLength);
      view.set(bytes);
      const blob = new Blob([view], { type: mime });
      formData.append(field, blob, filename);
      return {
        body: formData,
        // Browser/undici set Content-Type with boundary automatically when we
        // pass a FormData to Request, so do NOT supply Content-Type manually.
        headers: {}
      };
    }

    describe('POST /users/me/avatar', () => {
      it('accepts a PNG upload and writes /api/v1/users/<id>/avatar to users.avatar_url', async () => {
        makeUpdateMock([{ id: ME_ID, avatarUrl: `/api/v1/users/${ME_ID}/avatar`, updatedAt: new Date() }]);

        const { body, headers } = makeMultipart('file', PNG_BYTES, 'image/png', 'a.png');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.avatarUrl).toBe(`/api/v1/users/${ME_ID}/avatar`);
        expect(data.mime).toBe('image/png');
        expect(data.size).toBe(PNG_BYTES.length);
      });

      it('accepts a JPEG upload', async () => {
        makeUpdateMock([{ id: ME_ID, avatarUrl: `/api/v1/users/${ME_ID}/avatar`, updatedAt: new Date() }]);
        const { body, headers } = makeMultipart('file', JPEG_BYTES, 'image/jpeg', 'a.jpg');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.mime).toBe('image/jpeg');
      });

      it('accepts a WebP upload', async () => {
        makeUpdateMock([{ id: ME_ID, avatarUrl: `/api/v1/users/${ME_ID}/avatar`, updatedAt: new Date() }]);
        const { body, headers } = makeMultipart('file', WEBP_BYTES, 'image/webp', 'a.webp');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.mime).toBe('image/webp');
      });

      it('rejects SVG (not in MIME allowlist and fails magic-byte sniff)', async () => {
        const { body, headers } = makeMultipart('file', SVG_BYTES, 'image/svg+xml', 'a.svg');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        expect(res.status).toBe(415);
      });

      it('rejects a file claiming image/png but containing JPEG bytes', async () => {
        const { body, headers } = makeMultipart('file', JPEG_BYTES, 'image/png', 'fake.png');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        // image/png claimed but JPEG magic → 400 content-type mismatch
        expect(res.status).toBe(400);
      });

      it('rejects empty file', async () => {
        const { body, headers } = makeMultipart('file', Buffer.alloc(0), 'image/png', 'a.png');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        expect(res.status).toBe(400);
      });

      it('rejects multipart without a file field', async () => {
        const fd = new FormData();
        fd.append('notfile', new Blob([PNG_BYTES], { type: 'image/png' }), 'a.png');
        const res = await app.request('/users/me/avatar', { method: 'POST', body: fd });
        expect(res.status).toBe(400);
      });
    });

    describe('DELETE /users/me/avatar', () => {
      it('clears avatar_url and returns avatarUrl: null', async () => {
        makeUpdateMock([{ id: ME_ID, avatarUrl: null }]);
        const res = await app.request('/users/me/avatar', { method: 'DELETE' });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.avatarUrl).toBeNull();
      });
    });

    describe('POST then GET roundtrip', () => {
      it('uploads a PNG and serves it back from GET /users/:id/avatar with image/png + cache headers', async () => {
        makeUpdateMock([{ id: ME_ID, avatarUrl: `/api/v1/users/${ME_ID}/avatar`, updatedAt: new Date() }]);

        const { body, headers } = makeMultipart('file', PNG_BYTES, 'image/png', 'a.png');
        const postRes = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        expect(postRes.status).toBe(200);

        const getRes = await app.request(`/users/${ME_ID}/avatar`, { method: 'GET' });
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get('content-type')).toBe('image/png');
        expect(getRes.headers.get('cache-control')).toBe('private, max-age=300');
        expect(getRes.headers.get('etag')).toMatch(/^W\//);
        const body2 = Buffer.from(await getRes.arrayBuffer());
        expect(body2.equals(PNG_BYTES)).toBe(true);
      });
    });
  });
});
