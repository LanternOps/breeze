import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redis, guardedTx } = vi.hoisted(() => ({
  redis: {
    get: vi.fn(async () => 'user-1'),
    del: vi.fn(async () => 1),
  },
  guardedTx: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../db', () => ({
  db: guardedTx,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  users: {
    id: 'users.id',
    email: 'users.email',
    name: 'users.name',
    status: 'users.status',
  },
  partners: { id: 'partners.id', name: 'partners.name' },
  organizations: { id: 'organizations.id', name: 'organizations.name' },
}));

vi.mock('../../services', () => ({
  AuthBindingRotationRequiredError: class AuthBindingRotationRequiredError extends Error {
    constructor(readonly replacement: { kind: 'browser'; value: string }) { super(); }
  },
  AuthBindingUnavailableError: class AuthBindingUnavailableError extends Error {},
  AuthIssuanceCapabilityError: class AuthIssuanceCapabilityError extends Error {},
  AuthIssuanceConflictError: class AuthIssuanceConflictError extends Error {},
  beginAuthIssuance: vi.fn(async () => ({
    transitionId: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    operationId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(Date.now() + 120_000),
  })),
  finishAuthIssuance: vi.fn(async (_capability: unknown, callback: (tx: unknown) => Promise<unknown>) =>
    callback(guardedTx)),
  cancelAuthIssuance: vi.fn(async () => true),
  bindIssuedUserSession: vi.fn(async () => undefined),
  getRedis: vi.fn(() => redis),
  hashPassword: vi.fn(async () => 'hashed-password'),
  isPasswordStrong: vi.fn(() => ({ valid: true, errors: [] })),
  issueUserSession: vi.fn(async () => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    refreshJti: 'refresh-jti',
    expiresInSeconds: 900,
    familyId: 'family-1',
  })),
  issueUserSessionLegacyDuringTransition: vi.fn(),
  rateLimiter: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../../services/authLifecycle', () => ({
  advanceUserSecurityState: vi.fn(async () => ({ authEpoch: 2 })),
  revokeAllUserSessionFamilies: vi.fn(async () => 1),
}));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<typeof import('./helpers')>('./helpers');
  return {
    ...actual,
    getClientRateLimitKey: vi.fn(() => 'test-client'),
    getCookieValue: vi.fn(() => 'a'.repeat(64)),
    rotateCsrfBindingCookie: vi.fn(),
    hashInviteToken: vi.fn(() => 'invite-hash'),
    inviteRedisKey: vi.fn((hash: string) => `invite:${hash}`),
    inviteUserRedisKey: vi.fn((userId: string) => `invite-user:${userId}`),
    resolveCurrentUserTokenContext: vi.fn(async () => ({
      roleId: 'role-1',
      orgId: 'org-1',
      partnerId: 'partner-1',
      scope: 'organization' as const,
    })),
    resolveUserAuditOrgId: vi.fn(async () => 'org-1'),
    setRefreshTokenCookie: vi.fn(),
    toPublicTokens: vi.fn((tokens: { accessToken: string; expiresInSeconds: number }) => ({
      accessToken: tokens.accessToken,
      expiresInSeconds: tokens.expiresInSeconds,
    })),
    writeAuthAudit: vi.fn(),
  };
});

import { inviteRoutes } from './invite';
import {
  beginAuthIssuance,
  bindIssuedUserSession,
  finishAuthIssuance,
  issueUserSession,
} from '../../services';
import {
  advanceUserSecurityState,
  revokeAllUserSessionFamilies,
} from '../../services/authLifecycle';
import {
  resolveCurrentUserTokenContext,
  setRefreshTokenCookie,
  writeAuthAudit,
} from './helpers';

function selectRows(rows: unknown[]) {
  const limited = Object.assign(Promise.resolve(rows), {
    for: vi.fn().mockResolvedValue(rows),
  });
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue(limited),
      }),
    }),
  };
}

function successfulUpdate() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'user-1' }]),
      }),
    }),
  };
}

async function acceptInvite() {
  return inviteRoutes.request('/accept-invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `breeze_csrf_token=${'a'.repeat(64)}`,
    },
    body: JSON.stringify({ token: 'raw-invite', password: 'Sup3rSecure!' }),
  });
}

describe('/accept-invite durable issuance ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.get.mockResolvedValue('user-1');
    guardedTx.select.mockReturnValue(selectRows([{
      id: 'user-1',
      email: 'invitee@example.com',
      name: 'Invitee',
      status: 'invited',
    }]) as any);
    guardedTx.update.mockReturnValue(successfulUpdate() as any);
  });

  it('leaves account, epochs, families, invite keys, cookie, and success audits untouched when logout wins', async () => {
    vi.mocked(finishAuthIssuance).mockRejectedValueOnce(new Error('logout pending'));

    const response = await acceptInvite();

    expect(response.status).toBe(500);
    expect(beginAuthIssuance).toHaveBeenCalledOnce();
    expect(finishAuthIssuance).toHaveBeenCalledOnce();
    expect(guardedTx.update).not.toHaveBeenCalled();
    expect(advanceUserSecurityState).not.toHaveBeenCalled();
    expect(revokeAllUserSessionFamilies).not.toHaveBeenCalled();
    expect(issueUserSession).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(setRefreshTokenCookie).not.toHaveBeenCalled();
    expect(writeAuthAudit).not.toHaveBeenCalled();
  });

  it('commits invite activation, invalidation, and its new family in the guarded transaction before post-commit effects', async () => {
    const response = await acceptInvite();

    expect(response.status).toBe(200);
    expect(resolveCurrentUserTokenContext).toHaveBeenCalledWith('user-1');
    expect(advanceUserSecurityState).toHaveBeenCalledWith(guardedTx, 'user-1');
    expect(revokeAllUserSessionFamilies).toHaveBeenCalledWith(
      guardedTx,
      'user-1',
      'invite-accepted',
    );
    expect(issueUserSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', amr: ['password'] }),
      expect.objectContaining({ tx: guardedTx }),
    );
    expect(bindIssuedUserSession).toHaveBeenCalledWith(expect.objectContaining({ familyId: 'family-1' }));
    expect(redis.del).toHaveBeenCalledWith('invite:invite-hash');
    expect(redis.del).toHaveBeenCalledWith('invite-user:user-1');
    expect(setRefreshTokenCookie).toHaveBeenCalledWith(expect.anything(), 'refresh-token');
    expect(writeAuthAudit).toHaveBeenCalledTimes(2);
  });

  it('returns tokens:null only after a committed invite when post-commit cache binding fails', async () => {
    vi.mocked(bindIssuedUserSession).mockRejectedValueOnce(new Error('redis unavailable'));

    const response = await acceptInvite();

    expect(response.status).toBe(200);
    expect(guardedTx.update).toHaveBeenCalledOnce();
    expect(issueUserSession).toHaveBeenCalledOnce();
    expect(redis.del).toHaveBeenCalledTimes(2);
    expect(setRefreshTokenCookie).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ tokens: null });
  });
});
