import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted shared mock state
// ---------------------------------------------------------------------------

const { schema, dbState, permState } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const usersTbl = {
    id: col('id'),
    email: col('email'),
    name: col('name'),
    status: col('status'),
    isPlatformAdmin: col('is_platform_admin'),
  };
  const apiKeysTbl = { id: col('id'), status: col('status') };

  return {
    schema: { usersTbl, apiKeysTbl },
    dbState: {
      selectUsersResults: [] as unknown[][],
      selectApiKeysResults: [] as unknown[][],
    },
    permState: {
      getUserPermissions: vi.fn(),
    },
  };
});

function resultBox(getResult: () => unknown) {
  return {
    limit: vi.fn(() => Promise.resolve(getResult())),
  };
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === schema.usersTbl) {
            return resultBox(() => dbState.selectUsersResults.shift() ?? []);
          }
          if (table === schema.apiKeysTbl) {
            return resultBox(() => dbState.selectApiKeysResults.shift() ?? []);
          }
          throw new Error('unexpected select table in mock');
        }),
      })),
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema/users', () => ({ users: schema.usersTbl }));
vi.mock('../../db/schema/apiKeys', () => ({ apiKeys: schema.apiKeysTbl }));

vi.mock('../permissions', () => ({
  getUserPermissions: permState.getUserPermissions,
}));

// Mock middleware/auth wholesale rather than importing it for real: auth.ts
// pulls in jwt/tokenRevocation/tenantStatus/auditEvents/sentry/mfaPolicy/etc,
// none of which are relevant to this unit test and several of which have
// their own real-module side effects. buildOrgAccessClosures/siteAccessCheck
// themselves are covered by auth.test.ts / auth.siteAccess.test.ts — this
// test only needs to assert buildAuthContextForIntent WIRES the factories up
// correctly, so a faithful-but-independent reimplementation is sufficient.
vi.mock('../../middleware/auth', () => ({
  buildOrgAccessClosures: vi.fn((accessibleOrgIds: string[] | null) => ({
    orgCondition: vi.fn(() => ({ mock: 'orgCondition', accessibleOrgIds })),
    canAccessOrg: (orgId: string) => !!accessibleOrgIds && accessibleOrgIds.includes(orgId),
  })),
  siteAccessCheck: vi.fn(
    (allowedSiteIds?: string[]) => (siteId: string | null | undefined) => {
      if (!allowedSiteIds) return true;
      if (!siteId) return false;
      return allowedSiteIds.includes(siteId);
    },
  ),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { buildAuthContextForIntent } from './actorContext';
import type { ActionIntent } from '../../db/schema/actionIntents';

function baseIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    id: 'intent-1',
    orgId: 'org-1',
    partnerId: null,
    requestedByUserId: 'user-1',
    requestingApiKeyId: null,
    source: 'chat',
    requestingClientLabel: null,
    actionName: 'run_script',
    actionVersion: 1,
    arguments: {},
    argumentDigest: 'digest-1',
    targetSummary: 'run_script(scriptId=abc)',
    impactSummary: 'Runs a script',
    reason: null,
    riskTier: 3,
    connectionId: null,
    tenantId: null,
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    status: 'executing',
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: new Date(),
    decidedByUserId: 'approver-1',
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    executedAt: null,
    result: null,
    errorCode: null,
    ...overrides,
  } as ActionIntent;
}

const activeUser = {
  id: 'user-1',
  email: 'requester@example.com',
  name: 'Requester',
  status: 'active',
  isPlatformAdmin: false,
};

describe('buildAuthContextForIntent — user-owned intents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectUsersResults.length = 0;
    dbState.selectApiKeysResults.length = 0;
  });

  it('returns null when the user is not found', async () => {
    dbState.selectUsersResults.push([]);

    const result = await buildAuthContextForIntent(baseIntent());

    expect(result).toBeNull();
    expect(permState.getUserPermissions).not.toHaveBeenCalled();
  });

  it('returns null when the user is disabled', async () => {
    dbState.selectUsersResults.push([{ ...activeUser, status: 'disabled' }]);

    const result = await buildAuthContextForIntent(baseIntent());

    expect(result).toBeNull();
    expect(permState.getUserPermissions).not.toHaveBeenCalled();
  });

  it('returns null when the user is only invited (never completed setup)', async () => {
    dbState.selectUsersResults.push([{ ...activeUser, status: 'invited' }]);

    const result = await buildAuthContextForIntent(baseIntent());

    expect(result).toBeNull();
  });

  it('returns null when getUserPermissions returns null (lost org access since creation)', async () => {
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce(null);

    const result = await buildAuthContextForIntent(baseIntent());

    expect(result).toBeNull();
    // baseIntent() defaults partnerId to null → threaded through as
    // undefined (CRITICAL-2b).
    expect(permState.getUserPermissions).toHaveBeenCalledWith('user-1', { partnerId: undefined, orgId: 'org-1' });
  });

  it('builds an org-scoped AuthContext on the happy path', async () => {
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
      allowedSiteIds: ['site-1'],
    });

    const result = await buildAuthContextForIntent(baseIntent({ partnerId: 'partner-1' }));

    expect(result).not.toBeNull();
    expect(result!.scope).toBe('organization');
    expect(result!.orgId).toBe('org-1');
    expect(result!.partnerId).toBe('partner-1');
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
    expect(result!.canAccessOrg('org-1')).toBe(true);
    expect(result!.canAccessOrg('org-2')).toBe(false);
    expect(result!.allowedSiteIds).toEqual(['site-1']);
    expect(result!.canAccessSite!('site-1')).toBe(true);
    expect(result!.canAccessSite!('site-2')).toBe(false);
    expect(result!.user).toEqual({
      id: 'user-1',
      email: 'requester@example.com',
      name: 'Requester',
      isPlatformAdmin: false,
    });
    expect(result!.token.roleId).toBe('role-1');
    expect(result!.token.sub).toBe('user-1');
    expect(result!.token.scope).toBe('organization');
    // CRITICAL-2b: intent.partnerId is threaded into getUserPermissions so a
    // partner-scope requester's role (which lives in partner_users, not
    // organization_users) can resolve at release time.
    expect(permState.getUserPermissions).toHaveBeenCalledWith('user-1', { partnerId: 'partner-1', orgId: 'org-1' });
  });

  it('a fully unrestricted permission set (no allowedSiteIds) allows every site', async () => {
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
    });

    const result = await buildAuthContextForIntent(baseIntent());

    expect(result!.allowedSiteIds).toBeUndefined();
    expect(result!.canAccessSite!('any-site')).toBe(true);
  });
});

describe('buildAuthContextForIntent — api-key-owned intents (Plan 2 not implemented)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectUsersResults.length = 0;
    dbState.selectApiKeysResults.length = 0;
  });

  it('returns null even when the api key is active — Plan 2 completes this branch', async () => {
    dbState.selectApiKeysResults.push([{ id: 'key-1', status: 'active' }]);

    const result = await buildAuthContextForIntent(
      baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1' }),
    );

    expect(result).toBeNull();
    expect(permState.getUserPermissions).not.toHaveBeenCalled();
  });

  it('returns null when the api key is revoked', async () => {
    dbState.selectApiKeysResults.push([{ id: 'key-1', status: 'revoked' }]);

    const result = await buildAuthContextForIntent(
      baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1' }),
    );

    expect(result).toBeNull();
  });

  it('returns null when the api key is not found', async () => {
    dbState.selectApiKeysResults.push([]);

    const result = await buildAuthContextForIntent(
      baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1' }),
    );

    expect(result).toBeNull();
  });
});

describe('buildAuthContextForIntent — malformed intent (neither actor set)', () => {
  it('returns null and never queries the DB', async () => {
    const result = await buildAuthContextForIntent(
      baseIntent({ requestedByUserId: null, requestingApiKeyId: null }),
    );

    expect(result).toBeNull();
  });
});
