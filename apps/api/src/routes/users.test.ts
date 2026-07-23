import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Avatars are stored as a bytea blob on the user row via avatarStorage, which
// hits the DB. The DB is fully mocked here, so back the I/O functions with a
// tiny in-memory store that mimics the POST→GET round-trip. The pure helpers
// (sniffImageMime, weakEtagFor, MAX_AVATAR_SIZE_BYTES, …) stay real so upload
// validation is exercised for real.
const { avatarStore } = vi.hoisted(() => ({
  avatarStore: new Map<string, { mime: 'image/png' | 'image/jpeg' | 'image/webp'; data: Buffer }>(),
}));

vi.mock('../services/avatarStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/avatarStorage')>();
  const FIXED_MTIME = 1_700_000_000_000;
  return {
    ...actual,
    writeAvatar: vi.fn(async (userId: string, mime: 'image/png' | 'image/jpeg' | 'image/webp', data: Buffer) => {
      avatarStore.set(userId, { mime, data });
      return { ext: actual.extForMime(mime), size: data.length, avatarUrl: `/api/v1/users/${userId}/avatar`, updatedAt: new Date() };
    }),
    statAvatar: vi.fn(async (userId: string) => {
      const a = avatarStore.get(userId);
      return a ? { mime: a.mime, size: a.data.length, mtimeMs: FIXED_MTIME } : null;
    }),
    readAvatarBuffer: vi.fn(async (userId: string) => {
      const a = avatarStore.get(userId);
      return a ? { buffer: a.data, mime: a.mime, size: a.data.length, mtimeMs: FIXED_MTIME } : null;
    }),
    deleteAvatar: vi.fn(async (userId: string) => {
      avatarStore.delete(userId);
      return true;
    }),
  };
});

import { userRoutes } from './users';

const {
  sendInviteMock,
  sendEmailChangedMock,
  sendVerificationEmailMock,
  createAuditLogAsyncMock,
  resolveUserAuditOrgIdMock,
  requireCurrentPasswordStepUpMock,
  enforceExistingFactorStepUpMock,
  userIsMfaProtectedMock,
  getEffectiveMfaPolicyMock,
  requestPendingEmailChangeMock,
  isPasswordAuthDisabledBySsoMock,
  hasSatisfiedMfaMock,
  captureExceptionMock,
  getEmailServiceMock
} = vi.hoisted(() => ({
  sendInviteMock: vi.fn().mockResolvedValue(undefined),
  sendEmailChangedMock: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmailMock: vi.fn().mockResolvedValue(undefined),
  createAuditLogAsyncMock: vi.fn().mockResolvedValue(undefined),
  resolveUserAuditOrgIdMock: vi.fn().mockResolvedValue(null),
  captureExceptionMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
  // Default: step-up succeeds (returns null). Tests override to return a
  // Response to simulate a wrong password / rate-limit / Redis-down outcome.
  requireCurrentPasswordStepUpMock: vi.fn().mockResolvedValue(null),
  // SR2-18: default fresh-factor step-up passes (returns null — no-op for an
  // account with no factor). Tests override to a 403 Response for a protected
  // account lacking a fresh grant.
  enforceExistingFactorStepUpMock: vi.fn().mockResolvedValue(null),
  // SR2-18: default the account is NOT MFA-protected. Tests override to true.
  userIsMfaProtectedMock: vi.fn().mockResolvedValue(false),
  // SR2-18: default MFA policy is NOT required. Tests override to required.
  getEffectiveMfaPolicyMock: vi.fn().mockResolvedValue({
    required: false,
    allowedMethods: { totp: true, sms: true, passkey: true },
    source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: true }
  }),
  // SR2-17: default the pending-email service succeeds and returns a raw token.
  requestPendingEmailChangeMock: vi.fn().mockResolvedValue({ rawToken: 'raw-token-mock', emailEpoch: 5 }),
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
  partners: { id: { __column: 'partners.id' }, settings: { __column: 'partners.settings' } },
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

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(actual.eq),
  };
});

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
    requireCurrentPasswordStepUp: requireCurrentPasswordStepUpMock,
    enforceExistingFactorStepUp: enforceExistingFactorStepUpMock,
    userIsMfaProtected: userIsMfaProtectedMock
  };
});

vi.mock('../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: getEffectiveMfaPolicyMock
}));

vi.mock('../services/pendingEmail', () => ({
  requestPendingEmailChange: requestPendingEmailChangeMock
}));

vi.mock('../services/tokenRevocation', () => ({
  revokeAllUserTokens: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/remoteSessionTeardown', () => ({
  terminateUserRemoteSessions: vi.fn().mockResolvedValue(0),
  TEARDOWN_FAILED: -1,
}));

// advanceUserEpochs/revokeAllRefreshFamilies stay REAL so tests can assert on
// the tx-shaped `users`/`refresh_token_families` updates they issue.
// runPostCommitCleanup is mocked so tests control the post-commit outcome
// (redisOk/permissionCacheOk/oauthOk) without exercising the real Redis/OAuth
// side effects it wraps.
vi.mock('../services/authLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/authLifecycle')>();
  return {
    ...actual,
    runPostCommitCleanup: vi.fn().mockResolvedValue({
      redisOk: true,
      permissionCacheOk: true,
      oauthOk: true,
      oauthResult: { grantsRevoked: 0, refreshTokensRevoked: 0, jtisRevoked: 0 },
    })
  };
});

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { eq } from 'drizzle-orm';
import { clearPermissionCache, getUserPermissions } from '../services/permissions';
import { authMiddleware } from '../middleware/auth';
import { runPostCommitCleanup } from '../services/authLifecycle';
import { terminateUserRemoteSessions } from '../services/remoteSessionTeardown';
// Mocked above — imported to drive failure paths via mockResolvedValueOnce.
import { writeAvatar, deleteAvatar, readAvatarBuffer } from '../services/avatarStorage';

describe('user routes', () => {
  let app: Hono;

  function authAsSystem() {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'system',
        partnerId: null,
        partnerOrgAccess: null,
        orgId: null,
        user: {
          id: 'platform-admin',
          email: 'platform@example.com',
          isPlatformAdmin: true,
        },
      });
      return next();
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    avatarStore.clear();
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
    // password step-up passes, fresh-factor step-up passes, account not
    // MFA-protected, MFA policy not required, pending-email service succeeds.
    requireCurrentPasswordStepUpMock.mockResolvedValue(null);
    enforceExistingFactorStepUpMock.mockResolvedValue(null);
    userIsMfaProtectedMock.mockResolvedValue(false);
    getEffectiveMfaPolicyMock.mockResolvedValue({
      required: false,
      allowedMethods: { totp: true, sms: true, passkey: true },
      source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: true }
    });
    requestPendingEmailChangeMock.mockResolvedValue({ rawToken: 'raw-token-mock', emailEpoch: 5 });
    isPasswordAuthDisabledBySsoMock.mockResolvedValue(false);
    hasSatisfiedMfaMock.mockReturnValue(true);
    sendEmailChangedMock.mockResolvedValue(undefined);
    sendVerificationEmailMock.mockResolvedValue(undefined);
    // Default: email service is configured. Tests override to null to exercise
    // the "not configured" warning path.
    getEmailServiceMock.mockReturnValue({
      sendInvite: sendInviteMock,
      sendEmailChanged: sendEmailChangedMock,
      sendVerificationEmail: sendVerificationEmailMock
    });
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        partnerId: 'partner-123',
        partnerOrgAccess: 'all',
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

  describe('GET /users/me', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          orgId: null,
          user: { id: 'user-123', email: 'admin@example.com' }
        });
        return next();
      });
    });

    // The web sidebar gates platform-admin-only nav (account-deletion-requests)
    // and skips its badge fetch off this flag; if it ever stops being returned,
    // that fetch starts 403-spamming the console for every ordinary user again.
    it('returns isPlatformAdmin so the web can gate platform-admin-only nav', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'admin@example.com',
              name: 'Admin',
              avatarUrl: null,
              status: 'active',
              mfaEnabled: false,
              isPlatformAdmin: true,
              createdAt: new Date(),
              lastLoginAt: new Date(),
              setupCompletedAt: new Date(),
              passwordChangedAt: new Date(),
              preferences: {}
            }])
          })
        })
      } as any);

      const res = await app.request('/users/me', {
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { isPlatformAdmin?: boolean };
      expect(body.isPlatformAdmin).toBe(true);
    });

    // The web app hides billing nav and action buttons off this list. If /me
    // stops surfacing the user's grants, gated controls would render for users
    // who lack the permission (server still 403s, but it's a UX regression).
    it('returns the user permission grants for client-side UI gating', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'admin@example.com',
              name: 'Admin',
              avatarUrl: null,
              status: 'active',
              mfaEnabled: false,
              isPlatformAdmin: false,
              createdAt: new Date(),
              lastLoginAt: new Date(),
              setupCompletedAt: new Date(),
              passwordChangedAt: new Date(),
              preferences: {}
            }])
          })
        })
      } as any);

      const res = await app.request('/users/me', {
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { permissions?: { resource: string; action: string }[] };
      // Mocked getUserPermissions returns the admin wildcard grant.
      expect(body.permissions).toEqual([{ resource: '*', action: '*' }]);
    });

    it('returns the authenticated partner default locale', async () => {
      const user = {
        id: 'user-123',
        email: 'admin@example.com',
        name: 'Admin',
        avatarUrl: null,
        status: 'active',
        mfaEnabled: false,
        isPlatformAdmin: false,
        createdAt: new Date(),
        lastLoginAt: new Date(),
        setupCompletedAt: new Date(),
        passwordChangedAt: new Date(),
        preferences: {},
      };
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([user]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ settings: { language: 'pt-BR' } }]),
            }),
          }),
        } as any);

      // A client-supplied selector must not influence which partner is read.
      const res = await app.request('/users/me?partnerId=other-partner', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ partnerDefaultLocale: 'pt-BR' });
      expect(vi.mocked(db.select).mock.calls[1]?.[0]).toEqual({
        settings: { __column: 'partners.settings' },
      });
      expect(eq).toHaveBeenCalledWith({ __column: 'partners.id' }, 'partner-123');
      expect(eq).not.toHaveBeenCalledWith({ __column: 'partners.id' }, 'other-partner');
    });

    it.each([
      ['missing partner row', []],
      ['missing language', [{ settings: {} }]],
      ['unsupported stored language', [{ settings: { language: 'fr' } }]],
    ])('normalizes partner default locale to null for %s', async (_case, partnerRows) => {
      const user = {
        id: 'user-123',
        email: 'admin@example.com',
        name: 'Admin',
        avatarUrl: null,
        status: 'active',
        mfaEnabled: false,
        isPlatformAdmin: false,
        createdAt: new Date(),
        lastLoginAt: new Date(),
        setupCompletedAt: new Date(),
        passwordChangedAt: new Date(),
        preferences: {},
      };
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([user]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(partnerRows),
            }),
          }),
        } as any);

      const res = await app.request('/users/me', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ partnerDefaultLocale: null });
    });

    it('does not query partner settings when the authenticated context has no partner', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          orgId: 'org-1',
          user: { id: 'user-123', email: 'admin@example.com' },
        });
        return next();
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'admin@example.com',
              preferences: {},
            }]),
          }),
        }),
      } as any);

      const res = await app.request('/users/me?partnerId=other-partner');

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ partnerDefaultLocale: null });
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('returns the partner default locale for an org-scoped session via a system DB context', async () => {
      // Regression test: org-scoped sessions get accessiblePartnerIds = []
      // (computeAccessiblePartnerIds in middleware/auth.ts), so reading
      // `partners` under the ambient (org-scoped) request context would be
      // filtered to zero rows by RLS. The handler must escalate to a system
      // context via runOutsideDbContext + withSystemDbAccessContext, exactly
      // like removeMembershipForScope elsewhere in this file.
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: 'partner-123',
          orgId: 'org-1',
          user: { id: 'user-123', email: 'admin@example.com' },
        });
        return next();
      });

      const user = {
        id: 'user-123',
        email: 'admin@example.com',
        name: 'Admin',
        avatarUrl: null,
        status: 'active',
        mfaEnabled: false,
        isPlatformAdmin: false,
        createdAt: new Date(),
        lastLoginAt: new Date(),
        setupCompletedAt: new Date(),
        passwordChangedAt: new Date(),
        preferences: {},
      };
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([user]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ settings: { language: 'pt-BR' } }]),
            }),
          }),
        } as any);

      const res = await app.request('/users/me', {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ partnerDefaultLocale: 'pt-BR' });
      expect(eq).toHaveBeenCalledWith({ __column: 'partners.id' }, 'partner-123');
      expect(runOutsideDbContext).toHaveBeenCalled();
      expect(withSystemDbAccessContext).toHaveBeenCalled();
    });

    it('includes mfaMethod so the web can pick the register re-auth tier (#2707)', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'admin@example.com',
              name: 'Admin',
              avatarUrl: null,
              status: 'active',
              mfaEnabled: true,
              mfaMethod: 'totp',
              isPlatformAdmin: false,
              createdAt: new Date(),
              lastLoginAt: new Date(),
              setupCompletedAt: new Date(),
              passwordChangedAt: new Date(),
              preferences: {}
            }])
          })
        })
      } as any);

      const res = await app.request('/users/me', {
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { mfaMethod?: unknown };
      expect(body.mfaMethod).toBe('totp');
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

    it.each([
      ['theme', 'sepia', /Invalid theme value/i],
      ['density', 'tiny', /Invalid density value/i],
      ['font', 'comic-sans', /Invalid font value/i],
      ['timeFormat', 'military-ish', /Invalid timeFormat value/i],
    ])('rejects invalid %s appearance preference', async (key, value, message) => {
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ preferences: { [key]: value } })
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(message);
    });

    it('rejects an invalid locale preference', async () => {
      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ preferences: { locale: 'klingon' } })
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
'Invalid locale value. Must be en, pt-BR, es-419, fr-FR, fr-CA, de-DE, or it-IT.'
      'accepts and merges the %s locale preference',
      async (locale) => {
        const existingPreferences = { theme: 'dark' };
        const mergedPreferences = { ...existingPreferences, locale };
        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                email: 'test@example.com',
                passwordHash: 'hash',
                preferences: existingPreferences,
              }]),
            }),
          }),
        } as any);
        const setMock = vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'user-123',
              email: 'test@example.com',
              name: 'Test User',
              avatarUrl: null,
              status: 'active',
              mfaEnabled: false,
              preferences: mergedPreferences,
            }]),
          }),
        });
        vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

        const res = await app.request('/users/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ preferences: { locale } }),
        });

        expect(res.status).toBe(200);
        expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
          preferences: mergedPreferences,
        }));
        expect(await res.json()).toMatchObject({ preferences: { locale } });
      },
    );

    it('merges partial preference updates instead of clobbering existing keys', async () => {
      const existingPreferences = {
        theme: 'dark',
        density: 'compact',
        timeFormat: '12h',
        customKey: 'preserve-me'
      };
      const mergedPreferences = {
        ...existingPreferences,
        font: 'system',
        timeFormat: '24h'
      };
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              email: 'test@example.com',
              passwordHash: 'hash',
              preferences: existingPreferences
            }])
          })
        })
      } as any);

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'user-123',
            email: 'test@example.com',
            name: 'Test User',
            avatarUrl: null,
            status: 'active',
            mfaEnabled: false,
            preferences: mergedPreferences
          }])
        })
      });
      vi.mocked(db.update).mockReturnValue({
        set: setMock
      } as any);

      const res = await app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ preferences: { font: 'system', timeFormat: '24h' } })
      });

      expect(res.status).toBe(200);
      expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
        preferences: mergedPreferences
      }));
      const body = await res.json();
      expect(body.preferences).toEqual(mergedPreferences);
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

  describe('PATCH /users/me email change → PENDING address (SR2-17, SR2-18)', () => {
    // SR2-17/18: an authenticated email change must NOT move the live identity
    // (users.email) until the new address is PROVEN. The request records a
    // pending address behind a recovery-grade step-up (password + a fresh
    // existing-factor grant for MFA-protected accounts) and mints an
    // email_change verification token. The commit (Task 8) does the swap +
    // sign-out. requestPendingEmailChange is mocked here (unit-tested in
    // services/pendingEmail.test.ts); these tests own the ROUTE contract.
    const GRANT = '11111111-1111-4111-8111-111111111111';

    const selectNode = (rows: unknown[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows)
        })
      })
    });

    // SET payloads passed to the single profile db.update. The killer assertion
    // for SR2-17 is that `email` is NEVER among them.
    let updateSetCalls: Array<Record<string, unknown>> = [];
    const mockUpdate = (row: Record<string, unknown>) => {
      updateSetCalls = [];
      vi.mocked(db.update).mockReturnValue({
        set: (values: Record<string, unknown>) => {
          updateSetCalls.push(values);
          return {
            where: () => ({ returning: () => Promise.resolve([row]) })
          };
        }
      } as any);
    };

    // The route selects the caller's own row exactly ONCE (self load). There is
    // deliberately no second uniqueness select — that would be an enumeration
    // oracle (SR2 property 3).
    const mockSelf = (self: { email: string; passwordHash: string | null; partnerId?: string }) => {
      vi.mocked(db.select).mockReturnValue(
        selectNode([{ preferences: null, partnerId: 'partner-abc', ...self }]) as any
      );
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

    // The row the profile write returns. `email` is the OLD (unchanged) address —
    // the write never touches it.
    const updatedRow = () => ({
      id: 'user-123',
      email: 'old@example.com',
      name: 'Test User',
      avatarUrl: null,
      status: 'active',
      mfaEnabled: false,
      preferences: null
    });

    const patchMe = (payload: Record<string, unknown>) =>
      app.request('/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify(payload)
      });

    it('SR2-17: does NOT move users.email; records a pending address instead', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash', partnerId: 'p1' });
      mockUpdate(updatedRow());

      const res = await patchMe({ email: 'new@corp.com', currentPassword: 'pw' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.email).toBe('old@example.com'); // unchanged!
      expect(body.pendingEmail).toBe('new@corp.com');
      expect(body.verificationSent).toBe(true);
      // The killer assertion: no db.update ever set `email`.
      expect(updateSetCalls.length).toBeGreaterThan(0);
      expect(updateSetCalls.every((s) => !('email' in s))).toBe(true);
      // The pending write was delegated to the service, scoped to the user's
      // OWN partner (read off the row, not the null org-scope token).
      expect(requestPendingEmailChangeMock).toHaveBeenCalledWith({
        userId: 'user-123',
        partnerId: 'p1',
        newEmail: 'new@corp.com'
      });
    });

    it('SR2-17: does NOT sign the user out at initiation (no revoke, no post-commit cleanup)', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' });

      expect(res.status).toBe(200);
      // The email_epoch bump lives inside the (mocked) pending-email service; the
      // ROUTE must not run the sign-out machinery: no transaction (families
      // revoke), no post-commit OAuth/Redis sweep.
      expect(requestPendingEmailChangeMock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
      expect(runPostCommitCleanup).not.toHaveBeenCalled();
    });

    it('SR2-17: no enumeration oracle — the route makes NO cross-account uniqueness probe', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());

      const res = await patchMe({ email: 'someone-elses@corp.com', currentPassword: 'pw' });

      expect(res.status).toBe(200);
      // Exactly ONE select (the self load). A second select would be the
      // uniqueness probe whose 409 leaks that the address is taken — the
      // response must be uniform whether or not it collides (collision fails
      // closed at COMMIT as 23505, Task 8).
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    });

    it('SR2-18: an MFA-protected user with NO fresh step-up grant is refused (nothing written)', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());
      userIsMfaProtectedMock.mockResolvedValue(true);
      enforceExistingFactorStepUpMock.mockImplementationOnce(async (c: any) =>
        c.json({ error: 'existing_factor_step_up_required', stepUpUrl: '/auth/mfa/step-up' }, 403)
      );

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' }); // no grant

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'existing_factor_step_up_required' });
      expect(requestPendingEmailChangeMock).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('SR2-18: an MFA-protected user WITH a valid fresh grant succeeds (grant consumed)', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());
      userIsMfaProtectedMock.mockResolvedValue(true);
      enforceExistingFactorStepUpMock.mockResolvedValue(null); // fresh grant validates + consumes

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw', stepUpGrantId: GRANT });

      expect(res.status).toBe(200);
      expect((await res.json()).pendingEmail).toBe('new@example.com');
      expect(enforceExistingFactorStepUpMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        GRANT,
        { consume: true }
      );
    });

    it('SR2-18: a forced-enrollment user (policy required, unenrolled) cannot move the recovery address', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());
      getEffectiveMfaPolicyMock.mockResolvedValue({
        required: true,
        allowedMethods: { totp: true, sms: true, passkey: true },
        source: { roleForceMfa: true, settingsRequireMfa: false, killSwitchOff: true }
      });
      userIsMfaProtectedMock.mockResolvedValue(false);

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'mfa_enrollment_required' });
      expect(requestPendingEmailChangeMock).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('SR2-18: a passwordless, factor-less account is refused outright (no vacuous mfa=true pass)', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: null });
      mockUpdate(updatedRow());
      userIsMfaProtectedMock.mockResolvedValue(false);
      getEffectiveMfaPolicyMock.mockResolvedValue({
        required: false,
        allowedMethods: { totp: true, sms: true, passkey: true },
        source: { roleForceMfa: false, settingsRequireMfa: false, killSwitchOff: true }
      });

      const res = await patchMe({ email: 'new@example.com' });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/cannot change its email/i);
      expect(requestPendingEmailChangeMock).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('SR2-18: a passwordless MFA-PROTECTED account with a grant succeeds and audits stepUp=mfa', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: null });
      mockUpdate(updatedRow());
      userIsMfaProtectedMock.mockResolvedValue(true);
      enforceExistingFactorStepUpMock.mockResolvedValue(null);

      const res = await patchMe({ email: 'new@example.com', stepUpGrantId: GRANT });

      expect(res.status).toBe(200);
      const requested = createAuditLogAsyncMock.mock.calls
        .map((c: any[]) => c[0])
        .find((a: any) => a.action === 'user.email.change.requested');
      expect(requested.details).toMatchObject({ stepUp: 'mfa', pendingEmail: 'new@example.com' });
    });

    it('local-password user WITHOUT currentPassword ⇒ 400, nothing written', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());

      const res = await patchMe({ email: 'new@example.com' });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/current password is required/i);
      expect(requestPendingEmailChangeMock).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('local-password user with WRONG password ⇒ 401, nothing written', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());
      requireCurrentPasswordStepUpMock.mockImplementationOnce(async (c: any) =>
        c.json({ error: 'Invalid credentials' }, 401)
      );

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'wrong' });

      expect(res.status).toBe(401);
      expect(requestPendingEmailChangeMock).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('SSO-enforced org ⇒ 403, nothing written', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());
      isPasswordAuthDisabledBySsoMock.mockResolvedValue(true);

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/sso/i);
      expect(requestPendingEmailChangeMock).not.toHaveBeenCalled();
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('notifies the OLD address that a change was REQUESTED and sends verification to the NEW address', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' });

      expect(res.status).toBe(200);
      // Security notice to the OLD (still-authoritative) address, pending:true.
      expect(sendEmailChangedMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'old@example.com', newEmail: 'new@example.com', pending: true })
      );
      // Verification link to the NEW address, carrying the minted token.
      expect(sendVerificationEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'new@example.com',
          verificationUrl: expect.stringContaining('raw-token-mock')
        })
      );
    });

    it('audits user.email.change.requested with {previousEmail, pendingEmail, stepUp} and NO revocation fields', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' });

      expect(res.status).toBe(200);
      const calls = createAuditLogAsyncMock.mock.calls.map((c: any[]) => c[0]);
      const actions = calls.map((a) => a.action);
      expect(actions).toContain('user.profile.update');
      expect(actions).toContain('user.email.change.requested');
      // The old committed-change action must NOT fire at initiation.
      expect(actions).not.toContain('user.email.change');
      const requested = calls.find((a) => a.action === 'user.email.change.requested');
      expect(requested.details).toMatchObject({
        previousEmail: 'old@example.com',
        pendingEmail: 'new@example.com',
        stepUp: 'password'
      });
      // Nothing is revoked at initiation — those fields belong to the commit.
      expect(requested.details).not.toHaveProperty('sessionsRevoked');
      expect(requested.details).not.toHaveProperty('oauthGrantsRevokedOk');
    });

    it('PARTNER-scope request resolves an attribution org for the requested audit', async () => {
      // Partner-scope caller: auth.orgId === null → resolve via resolveUserAuditOrgId.
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          orgId: null,
          user: { id: 'user-123', email: 'old@example.com' }
        });
        return next();
      });
      resolveUserAuditOrgIdMock.mockResolvedValue('resolved-org-x');
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());

      const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' });

      expect(res.status).toBe(200);
      expect(resolveUserAuditOrgIdMock).toHaveBeenCalledWith('user-123');
      const requested = createAuditLogAsyncMock.mock.calls
        .map((c: any[]) => c[0])
        .find((a: any) => a.action === 'user.email.change.requested');
      expect(requested.orgId).toBe('resolved-org-x');
    });

    it('name-only PATCH still works and records NO pending change, NO step-up', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate({ ...updatedRow(), name: 'Renamed' });

      const res = await patchMe({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(requestPendingEmailChangeMock).not.toHaveBeenCalled();
      expect(requireCurrentPasswordStepUpMock).not.toHaveBeenCalled();
      expect(getEffectiveMfaPolicyMock).not.toHaveBeenCalled();
      const actions = createAuditLogAsyncMock.mock.calls.map((c: any[]) => c[0].action);
      expect(actions).toContain('user.profile.update');
      expect(actions).not.toContain('user.email.change.requested');
    });

    it('same-address PATCH ⇒ 200, no pending change, no step-up gate', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());

      const res = await patchMe({ email: 'OLD@example.com' });

      expect(res.status).toBe(200);
      expect(requestPendingEmailChangeMock).not.toHaveBeenCalled();
      expect(getEffectiveMfaPolicyMock).not.toHaveBeenCalled();
      expect(isPasswordAuthDisabledBySsoMock).not.toHaveBeenCalled();
    });

    it('mixed name+email: profile.update lists only WRITTEN fields (name); the pending email is on the requested audit', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate({ ...updatedRow(), name: 'New' });

      const res = await patchMe({ name: 'New', email: 'new@example.com', currentPassword: 'pw' });

      expect(res.status).toBe(200);
      const calls = createAuditLogAsyncMock.mock.calls.map((c: any[]) => c[0]);
      const profileUpdate = calls.find((a) => a.action === 'user.profile.update');
      expect(profileUpdate.details.changedFields).toContain('name');
      // email is NOT a committed field change, so it must not appear here.
      expect(profileUpdate.details.changedFields).not.toContain('email');
      expect(calls.map((a) => a.action)).toContain('user.email.change.requested');
    });

    it('email service NOT configured ⇒ warns, records the pending change, still 200', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());
      getEmailServiceMock.mockReturnValue(null);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' });
        expect(res.status).toBe(200);
        expect((await res.json()).pendingEmail).toBe('new@example.com');
        expect(sendVerificationEmailMock).not.toHaveBeenCalled();
        expect(sendEmailChangedMock).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Email service not configured')
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('fails closed ⇒ 500 when the pending-email write throws (0-row / RLS), no verification sent', async () => {
      orgScopeAuth();
      mockSelf({ email: 'old@example.com', passwordHash: 'hash' });
      mockUpdate(updatedRow());
      requestPendingEmailChangeMock.mockRejectedValueOnce(
        new Error('requestPendingEmailChange: pending email write matched 0 rows for user-123')
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const res = await patchMe({ email: 'new@example.com', currentPassword: 'pw' });
        expect(res.status).toBe(500);
        expect(sendVerificationEmailMock).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('PATCH /users/:id (admin update)', () => {
    it.each([
      { field: 'name', value: 'Cross-tenant rename' },
      { field: 'status', value: 'disabled' },
    ])('rejects organization-scoped global identity update for $field before lookup', async ({ field, value }) => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'organization',
          partnerId: null,
          partnerOrgAccess: null,
          orgId: 'org-a',
          user: { id: 'org-admin', email: 'admin-a@example.com' },
        });
        return next();
      });

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ [field]: value }),
      });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(runPostCommitCleanup).not.toHaveBeenCalled();
    });

    it.each(['selected', 'all'] as const)(
      'rejects a partner admin with orgAccess=%s before any global identity lookup or side effect',
      async (partnerOrgAccess) => {
        vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
          c.set('auth', {
            scope: 'partner',
            partnerId: 'partner-123',
            partnerOrgAccess,
            orgId: null,
            user: { id: 'partner-admin', email: 'admin@example.com' },
          });
          return next();
        });

        const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ name: 'Cross-partner rename' }),
        });

        expect(res.status).toBe(403);
        expect(db.select).not.toHaveBeenCalled();
        expect(db.transaction).not.toHaveBeenCalled();
        expect(withSystemDbAccessContext).not.toHaveBeenCalled();
        expect(runPostCommitCleanup).not.toHaveBeenCalled();
      }
    );

    it('allows system authority to update a global identity', async () => {
      authAsSystem();
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: '11111111-1111-1111-1111-111111111111',
              email: 'u@example.com',
              name: 'User',
              status: 'active',
            }]),
          }),
        }),
      } as any);
      vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{
                id: '11111111-1111-1111-1111-111111111111',
                email: 'u@example.com',
                name: 'Renamed by platform admin',
                status: 'active',
              }]),
            })),
          })),
        })),
      }));

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Renamed by platform admin' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Renamed by platform admin',
      });
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(runPostCommitCleanup).not.toHaveBeenCalled();
    });

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

    // Task 9: the status update, the auth-epoch advance, and the durable
    // refresh-family revoke must all land in the SAME db.transaction, with
    // the lifecycle service's post-commit cleanup running exactly once after
    // it commits (epoch).
    it('advances the auth epoch and revokes refresh-token families in the same transaction, then runs post-commit cleanup (epoch)', async () => {
      authAsSystem();
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'u@example.com',
                name: 'User',
                status: 'active',
              },
            ]),
          }),
        }),
      } as any);

      // Minimal `tx` stub: routes .returning() by the SET shape.
      // advanceUserEpochs sets `authEpoch`; anything else is the main users
      // update. revokeAllRefreshFamilies never calls .returning().
      const capturedUpdates: Array<Record<string, unknown>> = [];
      const txUpdate = vi.fn((_table: any) => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          return {
            where: () => ({
              returning: () =>
                'authEpoch' in values
                  ? Promise.resolve([{ authEpoch: 1, mfaEpoch: 0, emailEpoch: 0, passwordResetEpoch: 0 }])
                  : Promise.resolve([
                      {
                        id: '11111111-1111-1111-1111-111111111111',
                        email: 'u@example.com',
                        name: 'User',
                        status: 'disabled',
                      },
                    ])
            })
          };
        }
      }));
      vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({ update: txUpdate }));

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ status: 'disabled' })
      });

      expect(res.status).toBe(200);
      // advanceUserEpochs-shaped update on `users` (auth_epoch increment).
      expect(capturedUpdates.some((v) => 'authEpoch' in v)).toBe(true);
      // revokeAllRefreshFamilies-shaped update on `refresh_token_families`
      // (revoked_at/revoked_reason via COALESCE).
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(runPostCommitCleanup).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
      expect(runPostCommitCleanup).toHaveBeenCalledTimes(1);
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

  describe('DELETE /users/:id (Task 9/14: epoch bump + refresh-family revoke + post-commit cleanup on removal)', () => {
    // removeMembershipForScope now runs the membership delete + orphan
    // neutralization + advanceUserEpochs + revokeAllRefreshFamilies in ONE
    // db.transaction (system context). Build a minimal `tx` stub: `select`
    // backs the orphan check (hasOtherMembership controls whether it finds a
    // remaining link and short-circuits neutralize), `update` captures every
    // `.set()` call's values so tests can assert the epoch/family-revoke
    // shapes fired, and routes .returning() by whether the values look like
    // an epoch bump (mirrors advanceUserEpochs' real SET shape).
    function mockRemoveMembershipTx(opts: { deletedRows: Array<{ id: string }>; hasOtherMembership?: boolean }) {
      const { deletedRows, hasOtherMembership = true } = opts;
      const capturedUpdates: Array<Record<string, unknown>> = [];
      const txDelete = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(deletedRows)
        })
      });
      const txSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(hasOtherMembership ? [{ id: 'other-link' }] : [])
          })
        })
      });
      const txUpdate = vi.fn((_table: any) => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          return {
            where: () => {
              const ret: any = Promise.resolve(undefined);
              ret.returning = () =>
                values && 'authEpoch' in values
                  ? Promise.resolve([{ authEpoch: 1, mfaEpoch: 0, emailEpoch: 0, passwordResetEpoch: 0 }])
                  : Promise.resolve([]);
              return ret;
            }
          };
        }
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn: any) =>
        fn({ delete: txDelete, select: txSelect, update: txUpdate })
      );
      return { txDelete, txSelect, txUpdate, capturedUpdates };
    }

    it('removes a partner user, advances their epoch + revokes refresh families in-tx, then runs post-commit cleanup', async () => {
      const { capturedUpdates } = mockRemoveMembershipTx({ deletedRows: [{ id: 'link-1' }] });

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      // advanceUserEpochs-shaped update (auth_epoch increment).
      expect(capturedUpdates.some((v) => 'authEpoch' in v)).toBe(true);
      // revokeAllRefreshFamilies-shaped update (revoked_at/revoked_reason).
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(runPostCommitCleanup).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
      expect(runPostCommitCleanup).toHaveBeenCalledTimes(1);
    });

    it('does not run post-commit cleanup when no row was deleted (404)', async () => {
      mockRemoveMembershipTx({ deletedRows: [] });

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      expect(runPostCommitCleanup).not.toHaveBeenCalled();
    });

    it('still 200s even when post-commit cleanup reports a partial failure (best-effort, never throws)', async () => {
      vi.mocked(runPostCommitCleanup).mockResolvedValueOnce({
        redisOk: false,
        permissionCacheOk: true,
        oauthOk: true
      });
      mockRemoveMembershipTx({ deletedRows: [{ id: 'link-1' }] });

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
    });

    it('removes an organization user, advances their epoch + revokes refresh families, then runs post-commit cleanup', async () => {
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

      const { capturedUpdates } = mockRemoveMembershipTx({ deletedRows: [{ id: 'link-2' }] });

      const res = await app.request('/users/22222222-2222-2222-2222-222222222222', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(capturedUpdates.some((v) => 'authEpoch' in v)).toBe(true);
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(runPostCommitCleanup).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
      expect(runPostCommitCleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /users/:id/mfa/reset (admin recovery: clear factor + invalidate assurance)', () => {
    const TARGET = '11111111-1111-1111-1111-111111111111';

    // getScopedUser (partner scope) reads partnerUsers ⋈ users ⋈ roles; return a
    // membership so the target resolves inside the caller's tenant.
    function mockScopedUser(found: boolean) {
      return {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(
                  found ? [{ id: TARGET, email: 'target@example.com', name: 'Target', status: 'active', roleId: 'r1', roleName: 'Tech' }] : []
                )
              })
            })
          })
        })
      } as any;
    }

    // The MFA-state probe: select({mfaEnabled,mfaMethod}).from(users).where().limit(1).
    function mockMfaState(row: { mfaEnabled: boolean; mfaMethod: string | null } | null) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(row ? [row] : [])
          })
        })
      } as any;
    }

    // tx stub for invalidateMfaAssuranceAfterFactorChange: the clear update takes
    // no .returning(); advanceUserEpochs({mfa}) sets `mfaEpoch` and RETURNs the
    // epoch row; revokeAllRefreshFamilies sets revoked_at/revoked_reason.
    function mockFactorChangeTx() {
      const capturedUpdates: Array<Record<string, unknown>> = [];
      const txUpdate = vi.fn((_table: any) => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          return {
            where: () => {
              const ret: any = Promise.resolve(undefined);
              ret.returning = () =>
                values && 'mfaEpoch' in values
                  ? Promise.resolve([{ authEpoch: 0, mfaEpoch: 7, emailEpoch: 0, passwordResetEpoch: 0 }])
                  : Promise.resolve([]);
              return ret;
            }
          };
        }
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ update: txUpdate }));
      return { capturedUpdates };
    }

    it('clears the factor, bumps mfa_epoch + revokes families in-tx (system context), then post-commit cleanup', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockScopedUser(true))
        .mockReturnValueOnce(mockMfaState({ mfaEnabled: true, mfaMethod: 'totp' }));
      const { capturedUpdates } = mockFactorChangeTx();

      const res = await app.request(`/users/${TARGET}/mfa/reset`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      // Cross-user write went through the system-context escape.
      expect(runOutsideDbContext).toHaveBeenCalled();
      expect(withSystemDbAccessContext).toHaveBeenCalled();
      // Factor cleared (mfaEnabled:false) + mfa_epoch bumped + families revoked.
      expect(capturedUpdates.some((v) => v.mfaEnabled === false && v.mfaSecret === null)).toBe(true);
      expect(capturedUpdates.some((v) => 'mfaEpoch' in v)).toBe(true);
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(runPostCommitCleanup).toHaveBeenCalledWith(TARGET);
      // Audit records the admin action against the target.
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.mfa_reset', resourceId: TARGET, actorId: 'user-123' })
      );
    });

    it('refuses to reset the caller’s own MFA (must use self-service disable)', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', { scope: 'partner', partnerId: 'partner-123', orgId: null, user: { id: TARGET, email: 'target@example.com' } });
        return next();
      });

      const res = await app.request(`/users/${TARGET}/mfa/reset`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    });

    it('404s for a target outside the caller’s tenant (no cross-tenant reset)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockScopedUser(false));

      const res = await app.request(`/users/${TARGET}/mfa/reset`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    });

    it('400s when the target has no MFA enabled (nothing to reset)', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockScopedUser(true))
        .mockReturnValueOnce(mockMfaState({ mfaEnabled: false, mfaMethod: null }));

      const res = await app.request(`/users/${TARGET}/mfa/reset`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /users/:id remote session teardown on deactivation', () => {
    const teardownMock = vi.mocked(terminateUserRemoteSessions);

    beforeEach(() => authAsSystem());

    // The status PATCH mutation now runs update(users) + advanceUserEpochs +
    // revokeAllRefreshFamilies in ONE db.transaction. Build a minimal `tx`
    // stub whose `update` routes .returning() by the SET shape: an
    // advanceUserEpochs call sets `authEpoch`, so anything else is the main
    // users update and gets `updatedRow`. revokeAllRefreshFamilies never
    // calls .returning() so its result is unused.
    function mockPatchTx(updatedRow: { id: string; email: string; name: string; status: string } | null) {
      const capturedUpdates: Array<Record<string, unknown>> = [];
      const txUpdate = vi.fn((_table: any) => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          return {
            where: () => ({
              returning: () =>
                'authEpoch' in values
                  ? Promise.resolve([{ authEpoch: 1, mfaEpoch: 0, emailEpoch: 0, passwordResetEpoch: 0 }])
                  : Promise.resolve(updatedRow ? [updatedRow] : [])
            })
          };
        }
      }));
      vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({ update: txUpdate }));
      return { txUpdate, capturedUpdates };
    }

    // The system-authority identity lookup returns the existing record.
    // seedPatch also wires the transaction to
    // return the post-mutation row so the becameInactive branch runs.
    function seedPatch(
      recordStatus: 'active' | 'invited' | 'disabled',
      updatedStatus: 'active' | 'invited' | 'disabled',
    ) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'u@example.com',
                name: 'User',
                status: recordStatus,
              },
            ]),
          }),
        }),
      } as any);

      return mockPatchTx({
        id: '11111111-1111-1111-1111-111111111111',
        email: 'u@example.com',
        name: 'User',
        status: updatedStatus,
      });
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
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: '11111111-1111-1111-1111-111111111111',
                email: 'u@example.com',
                name: 'User',
                status: 'active',
              },
            ]),
          }),
        }),
      } as any);
      const { capturedUpdates } = mockPatchTx({
        id: '11111111-1111-1111-1111-111111111111',
        email: 'u@example.com',
        name: 'Renamed',
        status: 'active',
      });

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(200);
      expect(teardownMock).not.toHaveBeenCalled();
      // A name-only edit is NOT an authentication-state change: it must not
      // advance epochs (that would sign the user out everywhere), revoke
      // refresh-token families, or run post-commit cleanup.
      expect(capturedUpdates.some((v) => 'authEpoch' in v)).toBe(false);
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(false);
      expect(runPostCommitCleanup).not.toHaveBeenCalled();
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

        const { body, headers } = makeMultipart('file', PNG_BYTES, 'image/png', 'a.png');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.avatarUrl).toBe(`/api/v1/users/${ME_ID}/avatar`);
        expect(data.mime).toBe('image/png');
        expect(data.size).toBe(PNG_BYTES.length);
      });

      it('accepts a JPEG upload', async () => {
        const { body, headers } = makeMultipart('file', JPEG_BYTES, 'image/jpeg', 'a.jpg');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.mime).toBe('image/jpeg');
      });

      it('accepts a WebP upload', async () => {
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
        const res = await app.request('/users/me/avatar', { method: 'DELETE' });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.avatarUrl).toBeNull();
      });
    });

    describe('POST then GET roundtrip', () => {
      it('uploads a PNG and serves it back from GET /users/:id/avatar with image/png + cache headers', async () => {

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

      it('answers a conditional GET with 304 when If-None-Match matches, and 200 when it does not', async () => {
        const { body, headers } = makeMultipart('file', PNG_BYTES, 'image/png', 'a.png');
        await app.request('/users/me/avatar', { method: 'POST', body, headers });

        const first = await app.request(`/users/${ME_ID}/avatar`, { method: 'GET' });
        const etag = first.headers.get('etag')!;

        const hit = await app.request(`/users/${ME_ID}/avatar`, {
          method: 'GET',
          headers: { 'If-None-Match': etag },
        });
        expect(hit.status).toBe(304);
        expect(hit.headers.get('etag')).toBe(etag);
        expect((await hit.arrayBuffer()).byteLength).toBe(0);

        const miss = await app.request(`/users/${ME_ID}/avatar`, {
          method: 'GET',
          headers: { 'If-None-Match': 'W/"somethingelse"' },
        });
        expect(miss.status).toBe(200);
      });
    });

    describe('avatar storage failure paths', () => {
      it('POST returns 500 when the write matches no row (deleted/RLS-invisible user)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(writeAvatar).mockResolvedValueOnce(null);

        const { body, headers } = makeMultipart('file', PNG_BYTES, 'image/png', 'a.png');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        expect(res.status).toBe(500);
      });

      it('DELETE returns 500 when the clear matches no row', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(deleteAvatar).mockResolvedValueOnce(false);

        const res = await app.request('/users/me/avatar', { method: 'DELETE' });
        expect(res.status).toBe(500);
      });

      it('GET returns 500 (not 404) when the read fails after a successful stat', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { body, headers } = makeMultipart('file', PNG_BYTES, 'image/png', 'a.png');
        await app.request('/users/me/avatar', { method: 'POST', body, headers });

        // statAvatar succeeds (avatar exists); the subsequent read races a
        // delete (or hits corrupted mime) and returns null.
        vi.mocked(readAvatarBuffer).mockResolvedValueOnce(null);

        const res = await app.request(`/users/${ME_ID}/avatar`, { method: 'GET' });
        expect(res.status).toBe(500);
      });
    });

    describe('GET /users/:id/avatar — cross-tenant authorization', () => {
      const OTHER_ID = 'other-456';

      function authAs(userId: string, partnerId: string) {
        vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
          c.set('auth', {
            scope: 'partner',
            partnerId,
            orgId: null,
            user: { id: userId, email: `${userId}@example.com` },
          });
          return next();
        });
      }

      // getScopedUser (partner scope) resolves :id via
      // select().from().innerJoin().innerJoin().where().limit(). Force the
      // resolved row so we control "in scope" vs "not in scope".
      function mockScopedUser(rows: unknown[]) {
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue(rows),
                }),
              }),
            }),
          }),
        } as any);
      }

      async function uploadAvatarFor(userId: string, partnerId: string) {
        authAs(userId, partnerId);
        const { body, headers } = makeMultipart('file', PNG_BYTES, 'image/png', 'a.png');
        const res = await app.request('/users/me/avatar', { method: 'POST', body, headers });
        expect(res.status).toBe(200);
      }

      it('blocks a cross-tenant read — another user not in the caller\'s scope returns 404 even though the avatar exists', async () => {
        // An avatar is stored for other-456 (in the in-memory backing store).
        await uploadAvatarFor(OTHER_ID, 'partner-999');

        // Caller is in a DIFFERENT partner; getScopedUser resolves to nothing.
        authAs(ME_ID, 'partner-123');
        mockScopedUser([]);

        const res = await app.request(`/users/${OTHER_ID}/avatar`, { method: 'GET' });
        // Same 404 as "no avatar" — never reveals that other-456 exists.
        expect(res.status).toBe(404);
      });

      it('serves another user\'s avatar when getScopedUser resolves them within the caller\'s scope', async () => {
        await uploadAvatarFor(OTHER_ID, 'partner-123');

        authAs(ME_ID, 'partner-123');
        mockScopedUser([
          { id: OTHER_ID, email: 'other-456@example.com', name: 'Other', status: 'active', roleId: 'r1', roleName: 'Admin', orgAccess: 'all', orgIds: null },
        ]);

        const res = await app.request(`/users/${OTHER_ID}/avatar`, { method: 'GET' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.equals(PNG_BYTES)).toBe(true);
      });

      it('serves the caller\'s OWN avatar without a scope lookup (top bar must work without USERS_READ)', async () => {
        await uploadAvatarFor(ME_ID, 'partner-123');

        authAs(ME_ID, 'partner-123');
        // Force getScopedUser to resolve to nothing — it must NOT be consulted
        // for a self read, so the avatar still serves.
        mockScopedUser([]);

        const res = await app.request(`/users/${ME_ID}/avatar`, { method: 'GET' });
        expect(res.status).toBe(200);
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.equals(PNG_BYTES)).toBe(true);
      });
    });
  });

  // Regression: partner-wide user management must be gated on the caller's
  // partnerUsers.orgAccess === 'all'. Inferring it from accessibleOrgIds (which
  // is filtered to active/trial orgs, and narrowed by RLS when the org list is
  // read under the request context) both false-denies legit full-access admins
  // (any suspended/soft-deleted or zero orgs) and vacuously passes a
  // 'selected'/'none' admin. orgAccess is the authoritative, status-independent
  // signal.
  describe('full partner access gate (orgAccess===all)', () => {
    // The FIRST db.select() is the gate membership lookup (.from().where().limit());
    // later selects belong to the GET /users handler — back them with [].
    function seedMembership(orgAccess: 'all' | 'selected' | 'none' | null) {
      const gateLimit = vi.fn(() => Promise.resolve(orgAccess === null ? [] : [{ orgAccess }]));
      const gateWhere = vi.fn(() => ({ limit: gateLimit }));
      const handlerWhere = vi.fn(() => Promise.resolve([]));
      let firstCall = true;
      vi.mocked(db.select).mockReset().mockImplementation(() => {
        const isGate = firstCall;
        firstCall = false;
        return {
          from: vi.fn(() => ({
            where: isGate ? gateWhere : handlerWhere,
            innerJoin: vi.fn(() => ({
              innerJoin: vi.fn(() => ({ where: handlerWhere })),
              where: handlerWhere,
            })),
          })),
        } as any;
      });
    }

    function authAsPartner() {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          scope: 'partner',
          partnerId: 'partner-123',
          orgId: null,
          accessibleOrgIds: [],
          user: { id: 'user-123', email: 'test@example.com' }
        });
        return next();
      });
    }

    it("denies a 'selected' partner-admin (403)", async () => {
      seedMembership('selected');
      authAsPartner();

      const res = await app.request('/users', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });

    it("denies a 'none' partner-admin (403)", async () => {
      seedMembership('none');
      authAsPartner();

      const res = await app.request('/users', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });

    it('denies when no partner membership row resolves (403)', async () => {
      seedMembership(null);
      authAsPartner();

      const res = await app.request('/users', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
    });

    it("allows an 'all' partner-admin regardless of suspended/zero active orgs (200)", async () => {
      // orgAccess==='all' is authoritative — no false denial when the partner
      // has suspended/soft-deleted orgs (or none yet), the bug the set-compare
      // approach introduced.
      seedMembership('all');
      authAsPartner();

      const res = await app.request('/users', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
    });

    it('exempts self-service GET /me from the management gate for non-all admins', async () => {
      // A 'selected'/'none' partner admin (accessibleOrgIds IS an array, so the
      // shape early-return does NOT fire) must still reach their own profile —
      // the gate governs partner-wide MANAGEMENT only. Without the self-service
      // exemption this route would 403 (regression the cross-org fix introduced).
      authAsPartner();
      const userRow = {
        id: 'user-123', email: 'test@example.com', name: 'Test', avatarUrl: null,
        status: 'active', mfaEnabled: false, isPlatformAdmin: false,
        createdAt: new Date(), lastLoginAt: null, setupCompletedAt: new Date(),
        passwordChangedAt: null, preferences: {},
      };
      // Gate must NOT issue a partnerUsers membership query for a self-service
      // path; the only select is the /me user lookup.
      vi.mocked(db.select).mockReset().mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([userRow])) })) })),
      } as any);

      const res = await app.request('/users/me', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
    });
  });
});
