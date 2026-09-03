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
  const aiAgentRunsTbl = {
    id: col('id'),
    agentId: col('agent_id'),
    orgId: col('org_id'),
    deviceId: col('device_id'),
  };
  const aiAgentsTbl = {
    id: col('id'),
    orgId: col('org_id'),
    partnerId: col('partner_id'),
    name: col('name'),
    kind: col('kind'),
  };
  const organizationsTbl = { id: col('id'), partnerId: col('partner_id') };
  const devicesTbl = { id: col('id'), siteId: col('site_id') };
  const ticketsTbl = {
    id: col('id'),
    orgId: col('org_id'),
    status: col('status'),
    deletedAt: col('deleted_at'),
  };

  return {
    schema: { usersTbl, apiKeysTbl, aiAgentRunsTbl, aiAgentsTbl, organizationsTbl, devicesTbl, ticketsTbl },
    dbState: {
      selectUsersResults: [] as unknown[][],
      selectApiKeysResults: [] as unknown[][],
      selectAgentRunsResults: [] as unknown[][],
      selectAgentsResults: [] as unknown[][],
      selectOrgsResults: [] as unknown[][],
      selectDevicesResults: [] as unknown[][],
      selectTicketsResults: [] as unknown[][],
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
          if (table === schema.aiAgentRunsTbl) {
            return resultBox(() => dbState.selectAgentRunsResults.shift() ?? []);
          }
          if (table === schema.aiAgentsTbl) {
            return resultBox(() => dbState.selectAgentsResults.shift() ?? []);
          }
          if (table === schema.organizationsTbl) {
            return resultBox(() => dbState.selectOrgsResults.shift() ?? []);
          }
          if (table === schema.devicesTbl) {
            return resultBox(() => dbState.selectDevicesResults.shift() ?? []);
          }
          if (table === schema.ticketsTbl) {
            return resultBox(() => dbState.selectTicketsResults.shift() ?? []);
          }
          throw new Error('unexpected select table in mock');
        }),
      })),
    })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema/users', () => ({ users: schema.usersTbl }));
vi.mock('../../db/schema/apiKeys', () => ({ apiKeys: schema.apiKeysTbl }));
vi.mock('../../db/schema/aiAgents', () => ({
  aiAgentRuns: schema.aiAgentRunsTbl,
  aiAgents: schema.aiAgentsTbl,
}));
vi.mock('../../db/schema/orgs', () => ({ organizations: schema.organizationsTbl }));
vi.mock('../../db/schema/devices', () => ({ devices: schema.devicesTbl }));
vi.mock('../../db/schema/portal', () => ({ tickets: schema.ticketsTbl }));

vi.mock('../permissions', () => ({
  getUserPermissions: permState.getUserPermissions,
  // Faithful reimplementation of the real canAccessOrg (permissions.ts) — the
  // release-time org-access gate. org-scope perms match their own org; partner-
  // scope perms honor all/none/selected; system scope is unrestricted.
  canAccessOrg: (perms: {
    scope: string;
    orgId?: string | null;
    orgAccess?: 'all' | 'selected' | 'none';
    allowedOrgIds?: string[];
  }, orgId: string) => {
    if (perms.scope === 'organization') return perms.orgId === orgId;
    if (perms.scope === 'partner') {
      if (perms.orgAccess === 'all') return true;
      if (perms.orgAccess === 'none') return false;
      if (perms.orgAccess === 'selected') return perms.allowedOrgIds?.includes(orgId) ?? false;
      return false;
    }
    return true;
  },
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

import { buildAuthContextForIntent, originPrincipalFor } from './actorContext';
import { IntentScopeLostError } from './intentTargetScope';
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

  it('returns null when a partner requester lost selected access to intent.orgId', async () => {
    // The bug this guards: getUserPermissions resolves the PARTNER axis for a
    // partner-scope requester (they have no organization_users row), returning
    // a non-null perms object carrying orgAccess='selected' + allowedOrgIds
    // that NO LONGER includes intent.orgId. A non-null perms alone must NOT
    // authorize release — canAccessOrg re-applies the selected-org gate.
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'partner',
      orgAccess: 'selected',
      allowedOrgIds: ['org-99'], // org-1 was removed
    });

    const result = await buildAuthContextForIntent(baseIntent({ partnerId: 'partner-1' }));

    expect(result).toBeNull();
  });

  it('builds a partner-scoped AuthContext when selected access still covers intent.orgId', async () => {
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'partner',
      orgAccess: 'selected',
      allowedOrgIds: ['org-1', 'org-99'],
    });

    const result = await buildAuthContextForIntent(baseIntent({ partnerId: 'partner-1' }));

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
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
    expect(result!.token!.roleId).toBe('role-1');
    expect(result!.token!.sub).toBe('user-1');
    expect(result!.token!.scope).toBe('organization');
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

describe('buildAuthContextForIntent — #4650 tenant-mutation target-org widening (user-owned)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectUsersResults.length = 0;
    dbState.selectOrgsResults.length = 0;
  });

  const moveOrgIntent = (overrides: Partial<ActionIntent> = {}) => baseIntent({
    partnerId: 'partner-1',
    actionName: 'manage_tickets',
    arguments: { action: 'move_org', ticketId: 'ticket-1', targetOrgId: 'org-2' },
    ...overrides,
  } as Partial<ActionIntent>);

  it('widens accessibleOrgIds to the recorded target org when the requester (partner, orgAccess: all) can reach it AND the target shares the intent\'s partner', async () => {
    dbState.selectUsersResults.push([activeUser]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]); // target org — SAME partner as intent.partnerId
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'partner',
      orgAccess: 'all',
    });

    const result = await buildAuthContextForIntent(moveOrgIntent());

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1', 'org-2']);
    expect(result!.canAccessOrg('org-1')).toBe(true);
    expect(result!.canAccessOrg('org-2')).toBe(true);
    expect(result!.canAccessOrg('org-3')).toBe(false);
    // The AuthContext's own "home" org is unchanged — only accessibleOrgIds
    // widens, same as a live partner-scope request.
    expect(result!.orgId).toBe('org-1');
  });

  it('does NOT widen when orgAccess:all would pass but the recorded target org belongs to a DIFFERENT partner (independent tenancy check, not permsCanAccessOrg alone)', async () => {
    // permsCanAccessOrg('all') returns true for ANY org id — it never checks
    // tenancy. This is the regression case a permsCanAccessOrg-only bound
    // would have missed: the requester's own partner grants blanket org
    // access, but the RECORDED target belongs to someone else's partner.
    dbState.selectUsersResults.push([activeUser]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-2' }]); // target org — DIFFERENT partner
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'partner',
      orgAccess: 'all',
    });

    const result = await buildAuthContextForIntent(moveOrgIntent());

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
    expect(result!.canAccessOrg('org-2')).toBe(false);
  });

  it('does NOT widen when intent.partnerId is null (defensive — a partner-scope intent should always carry one)', async () => {
    dbState.selectUsersResults.push([activeUser]);
    dbState.selectOrgsResults.push([{ partnerId: null }]); // target org's own partner (irrelevant — comparand is null)
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'partner',
      orgAccess: 'all',
    });

    const result = await buildAuthContextForIntent(moveOrgIntent({ partnerId: null }));

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
  });

  it('does NOT widen when the requester (partner, orgAccess: selected) cannot reach the recorded target org — the tool gate refuses for the RIGHT reason', async () => {
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'partner',
      orgAccess: 'selected',
      allowedOrgIds: ['org-1'], // org-2 (the recorded target) is NOT selected
    });

    const result = await buildAuthContextForIntent(moveOrgIntent());

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
    expect(result!.canAccessOrg('org-2')).toBe(false);
  });

  it('never widens for an org-scoped requester, even when they can reach intent.orgId', async () => {
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
    });

    const result = await buildAuthContextForIntent(moveOrgIntent());

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
    expect(result!.canAccessOrg('org-2')).toBe(false);
  });

  it('does NOT widen a tool/action pair outside the allowlist, even one carrying a same-shaped "targetOrgId" argument', async () => {
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'partner',
      orgAccess: 'all', // would reach org-2 easily IF the widening ran
    });

    const result = await buildAuthContextForIntent(
      moveOrgIntent({
        actionName: 'manage_tickets',
        arguments: { action: 'assign', ticketId: 'ticket-1', targetOrgId: 'org-2' },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
  });

  it('does NOT widen manage_tickets:move_org missing a recorded targetOrgId (defensive — createActionIntent always requires one)', async () => {
    dbState.selectUsersResults.push([activeUser]);
    permState.getUserPermissions.mockResolvedValueOnce({
      permissions: [],
      partnerId: 'partner-1',
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'partner',
      orgAccess: 'all',
    });

    const result = await buildAuthContextForIntent(
      moveOrgIntent({ arguments: { action: 'move_org', ticketId: 'ticket-1' } }),
    );

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
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

describe('buildAuthContextForIntent — agent-owned intents (wave 3b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectAgentRunsResults.length = 0;
    dbState.selectAgentsResults.length = 0;
    dbState.selectOrgsResults.length = 0;
    dbState.selectDevicesResults.length = 0;
  });

  const agentIntent = (overrides: Partial<ActionIntent> = {}) => baseIntent({
    requestedByUserId: null,
    requestingApiKeyId: null,
    requestingAgentRunId: 'run-1',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: 'agent-1',
    source: 'ai_agent',
    ...overrides,
  } as Partial<ActionIntent>);

  const runRow = { id: 'run-1', agentId: 'agent-1', orgId: 'org-1', deviceId: 'dev-1' };
  const agentRow = { id: 'agent-1', orgId: null, partnerId: 'partner-1', name: 'Alert Triage', kind: 'triage' };

  it('builds an ai_agent context pinned to the run org and the device site', async () => {
    dbState.selectAgentRunsResults.push([runRow]);
    dbState.selectAgentsResults.push([agentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);
    dbState.selectDevicesResults.push([{ siteId: 'site-1' }]);

    const result = await buildAuthContextForIntent(agentIntent());

    expect(result).not.toBeNull();
    expect(result!.principal).toEqual({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' });
    expect(result!.orgId).toBe('org-1');
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
    expect(result!.canAccessOrg('org-1')).toBe(true);
    expect(result!.canAccessOrg('org-2')).toBe(false);
    // Spec §3.2: a device-bound run is pinned to the device's CURRENT site.
    expect(result!.allowedSiteIds).toEqual(['site-1']);
    expect(result!.canAccessSite!('site-1')).toBe(true);
    expect(result!.canAccessSite!('site-2')).toBe(false);
    // No user token is ever minted for an agent; RBAC paths must keep denying it.
    expect(result!.token).toBeNull();
    expect(permState.getUserPermissions).not.toHaveBeenCalled();
  });

  it('returns null when the run is missing', async () => {
    dbState.selectAgentRunsResults.push([]);

    expect(await buildAuthContextForIntent(agentIntent())).toBeNull();
  });

  it('returns null when the run targets another org than the intent', async () => {
    dbState.selectAgentRunsResults.push([{ ...runRow, orgId: 'org-2' }]);

    expect(await buildAuthContextForIntent(agentIntent())).toBeNull();
  });

  it('returns null when the run agent does not match originPrincipalId', async () => {
    dbState.selectAgentRunsResults.push([{ ...runRow, agentId: 'agent-9' }]);

    expect(await buildAuthContextForIntent(agentIntent())).toBeNull();
  });

  it('returns null when the agent row is gone', async () => {
    dbState.selectAgentRunsResults.push([runRow]);
    dbState.selectAgentsResults.push([]);

    expect(await buildAuthContextForIntent(agentIntent())).toBeNull();
  });

  it('returns null when run ownership fails (org agent of another org)', async () => {
    dbState.selectAgentRunsResults.push([runRow]);
    dbState.selectAgentsResults.push([{ ...agentRow, orgId: 'org-2', partnerId: null }]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);
    dbState.selectDevicesResults.push([{ siteId: 'site-1' }]);

    expect(await buildAuthContextForIntent(agentIntent())).toBeNull();
  });

  // -------------------------------------------------------------------------
  // P2-2 (Task A3, #4189): explicit device scope
  // -------------------------------------------------------------------------

  /** A SWEEP-minted intent: device-less run, target from `scope_device_id`. */
  const scopedIntent = (overrides: Partial<ActionIntent> = {}) => agentIntent({
    scopeKind: 'device',
    scopeDeviceId: 'dev-scope',
    ...overrides,
  } as Partial<ActionIntent>);

  /** The scope branch projects `org_id` alongside `site_id` (the run-device
   *  branch only ever needed the site), so the device row shape differs. */
  function seedScoped(device: unknown[] = [{ orgId: 'org-1', siteId: 'site-scope' }]) {
    dbState.selectAgentRunsResults.push([{ ...runRow, deviceId: null }]);
    dbState.selectAgentsResults.push([agentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);
    dbState.selectDevicesResults.push(device);
  }

  it('pins the rebuilt context to the SCOPE device and its CURRENT site, not the run', async () => {
    seedScoped();

    const result = await buildAuthContextForIntent(scopedIntent());

    expect(result).not.toBeNull();
    // The run carries NO device — every one of these comes from the scope.
    expect(result!.allowedDeviceIds).toEqual(['dev-scope']);
    expect(result!.allowedSiteIds).toEqual(['site-scope']);
    expect(result!.canAccessSite!('site-scope')).toBe(true);
    expect(result!.canAccessSite!('site-1')).toBe(false);
  });

  it('throws IntentScopeLostError (not null) when the scope was tombstoned', async () => {
    dbState.selectAgentRunsResults.push([{ ...runRow, deviceId: null }]);
    dbState.selectAgentsResults.push([agentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);

    // Distinct from `null`/actor_invalid on purpose: revalidateRelease maps
    // this to the terminal `agent_scope_lost` errorCode.
    await expect(
      buildAuthContextForIntent(scopedIntent({ scopeDeviceId: null } as Partial<ActionIntent>)),
    ).rejects.toBeInstanceOf(IntentScopeLostError);
  });

  it('throws IntentScopeLostError when the scoped device is gone', async () => {
    seedScoped([]);

    await expect(buildAuthContextForIntent(scopedIntent())).rejects.toBeInstanceOf(IntentScopeLostError);
  });

  it('throws IntentScopeLostError when the scoped device moved to another org', async () => {
    seedScoped([{ orgId: 'org-2', siteId: 'site-scope' }]);

    await expect(buildAuthContextForIntent(scopedIntent())).rejects.toBeInstanceOf(IntentScopeLostError);
  });

  // -------------------------------------------------------------------------
  // P2-4 (Task A3, #4191): explicit ticket scope
  // -------------------------------------------------------------------------

  /** A ticket-triage-minted intent: device-less run, target from `scope_ticket_id`. */
  const ticketScopedIntent = (overrides: Partial<ActionIntent> = {}) => agentIntent({
    scopeKind: 'ticket',
    scopeTicketId: 'ticket-scope',
    ...overrides,
  } as Partial<ActionIntent>);

  function seedTicketScoped(ticket: unknown[]) {
    dbState.selectAgentRunsResults.push([{ ...runRow, deviceId: null }]);
    dbState.selectAgentsResults.push([agentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);
    dbState.selectTicketsResults.push(ticket);
  }

  it('throws IntentScopeLostError immediately when the ticket scope was tombstoned (no DB read)', async () => {
    dbState.selectAgentRunsResults.push([{ ...runRow, deviceId: null }]);
    dbState.selectAgentsResults.push([agentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]);

    await expect(
      buildAuthContextForIntent(ticketScopedIntent({ scopeTicketId: null } as Partial<ActionIntent>)),
    ).rejects.toBeInstanceOf(IntentScopeLostError);
    expect(dbState.selectTicketsResults.length).toBe(0);
  });

  it('throws IntentScopeLostError when the scoped ticket is missing', async () => {
    seedTicketScoped([]);

    await expect(buildAuthContextForIntent(ticketScopedIntent())).rejects.toBeInstanceOf(IntentScopeLostError);
  });

  it('throws IntentScopeLostError when the scoped ticket was soft-deleted', async () => {
    seedTicketScoped([{ id: 'ticket-scope', orgId: 'org-1', status: 'open', deletedAt: new Date() }]);

    await expect(buildAuthContextForIntent(ticketScopedIntent())).rejects.toBeInstanceOf(IntentScopeLostError);
  });

  it('throws IntentScopeLostError when the scoped ticket moved to another org', async () => {
    seedTicketScoped([{ id: 'ticket-scope', orgId: 'org-2', status: 'open', deletedAt: null }]);

    await expect(buildAuthContextForIntent(ticketScopedIntent())).rejects.toBeInstanceOf(IntentScopeLostError);
  });

  it('throws IntentScopeLostError when the scoped ticket is closed', async () => {
    seedTicketScoped([{ id: 'ticket-scope', orgId: 'org-1', status: 'closed', deletedAt: null }]);

    await expect(buildAuthContextForIntent(ticketScopedIntent())).rejects.toBeInstanceOf(IntentScopeLostError);
  });

  it('builds an AuthContext for a resolved ticket — resolution-note drafts execute on resolved tickets', async () => {
    seedTicketScoped([{ id: 'ticket-scope', orgId: 'org-1', status: 'resolved', deletedAt: null }]);

    const result = await buildAuthContextForIntent(ticketScopedIntent());

    expect(result).not.toBeNull();
    expect(result!.orgId).toBe('org-1');
  });

  it('builds an AuthContext for every other live status (open)', async () => {
    seedTicketScoped([{ id: 'ticket-scope', orgId: 'org-1', status: 'open', deletedAt: null }]);

    const result = await buildAuthContextForIntent(ticketScopedIntent());

    expect(result).not.toBeNull();
  });
});

describe('buildAuthContextForIntent — #4650 tenant-mutation target-org widening (agent-owned)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectAgentRunsResults.length = 0;
    dbState.selectAgentsResults.length = 0;
    dbState.selectOrgsResults.length = 0;
    dbState.selectDevicesResults.length = 0;
  });

  const moveOrgAgentIntent = (overrides: Partial<ActionIntent> = {}) => baseIntent({
    requestedByUserId: null,
    requestingApiKeyId: null,
    requestingAgentRunId: 'run-1',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: 'agent-1',
    source: 'ai_agent',
    partnerId: 'partner-1',
    actionName: 'manage_tickets',
    arguments: { action: 'move_org', ticketId: 'ticket-1', targetOrgId: 'org-2' },
    ...overrides,
  } as Partial<ActionIntent>);

  const runRow = { id: 'run-1', agentId: 'agent-1', orgId: 'org-1', deviceId: 'dev-1' };
  const partnerAgentRow = { id: 'agent-1', orgId: null, partnerId: 'partner-1', name: 'Ticket Triage', kind: 'triage' };
  const orgAgentRow = { id: 'agent-1', orgId: 'org-1', partnerId: null, name: 'Ticket Triage', kind: 'triage' };

  it('widens for a partner-scoped agent when the recorded target org shares the agent\'s partner', async () => {
    dbState.selectAgentRunsResults.push([runRow]);
    dbState.selectAgentsResults.push([partnerAgentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]); // source org (run.orgId)
    dbState.selectDevicesResults.push([{ siteId: 'site-1' }]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]); // target org — SAME partner

    const result = await buildAuthContextForIntent(moveOrgAgentIntent());

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1', 'org-2']);
    expect(result!.canAccessOrg('org-1')).toBe(true);
    expect(result!.canAccessOrg('org-2')).toBe(true);
    expect(result!.canAccessOrg('org-3')).toBe(false);
  });

  it('does NOT widen for a partner-scoped agent when the recorded target org belongs to ANOTHER partner', async () => {
    dbState.selectAgentRunsResults.push([runRow]);
    dbState.selectAgentsResults.push([partnerAgentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]); // source org
    dbState.selectDevicesResults.push([{ siteId: 'site-1' }]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-2' }]); // target org — DIFFERENT partner

    const result = await buildAuthContextForIntent(moveOrgAgentIntent());

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
    expect(result!.canAccessOrg('org-2')).toBe(false);
  });

  it('never widens for an ORG-scoped agent — its home IS a single org', async () => {
    dbState.selectAgentRunsResults.push([runRow]);
    dbState.selectAgentsResults.push([orgAgentRow]);
    dbState.selectOrgsResults.push([{ partnerId: null }]); // source org has no partner for an org agent's ownership check
    dbState.selectDevicesResults.push([{ siteId: 'site-1' }]);

    const result = await buildAuthContextForIntent(moveOrgAgentIntent());

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
    expect(result!.canAccessOrg('org-2')).toBe(false);
    // No second `organizations` lookup for an org-scoped agent — it is never
    // eligible for the widening, so resolveTenantMutationTargetOrgId's result
    // must never trigger the target-org DB read at all.
    expect(dbState.selectOrgsResults).toHaveLength(0);
  });

  it('does NOT widen a tool/action pair outside the allowlist for a partner-scoped agent', async () => {
    dbState.selectAgentRunsResults.push([runRow]);
    dbState.selectAgentsResults.push([partnerAgentRow]);
    dbState.selectOrgsResults.push([{ partnerId: 'partner-1' }]); // source org only
    dbState.selectDevicesResults.push([{ siteId: 'site-1' }]);

    const result = await buildAuthContextForIntent(
      moveOrgAgentIntent({
        arguments: { action: 'assign', ticketId: 'ticket-1', targetOrgId: 'org-2' },
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.accessibleOrgIds).toEqual(['org-1']);
    expect(dbState.selectOrgsResults).toHaveLength(0);
  });
});

describe('originPrincipalFor — ai_agent', () => {
  it('maps an agent intent to { kind: ai_agent, agentId, runId }', () => {
    const principal = originPrincipalFor(baseIntent({
      requestedByUserId: null,
      requestingAgentRunId: 'run-1',
      originPrincipalKind: 'ai_agent',
      originPrincipalId: 'agent-1',
    } as Partial<ActionIntent>));

    expect(principal).toEqual({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' });
  });

  it('falls to unknown when the run id or agent id is missing (corruption stays untrusted)', () => {
    expect(originPrincipalFor(baseIntent({
      originPrincipalKind: 'ai_agent',
      originPrincipalId: 'agent-1',
      requestingAgentRunId: null,
    } as Partial<ActionIntent>))).toEqual({ kind: 'unknown' });
    expect(originPrincipalFor(baseIntent({
      originPrincipalKind: 'ai_agent',
      originPrincipalId: null,
      requestingAgentRunId: 'run-1',
    } as Partial<ActionIntent>))).toEqual({ kind: 'unknown' });
  });
});
