import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { M365MutatingAction, M365WriteAction } from '@breeze/shared/m365';

/**
 * writeActionService is the security-critical write-side authz ladder:
 * feature flag (no DB) -> load connection (ambient RLS) -> readiness
 * (missing/wrong-org/status/no-tenant -> connection_not_ready) -> budget
 * (write_rate_limited) -> executor call (executor_unavailable) -> executor
 * result. Every fail-closed branch must be proven to NEVER call the
 * executor — mirrors the Task 7 lesson (a fail-closed branch that still lets
 * the mutating call through is the actual bug class this ladder exists to
 * prevent). Mock declarations use vi.hoisted (not bare module-scope consts)
 * because vi.mock factories are hoisted above the rest of the file and
 * referencing a non-"mock"-prefixed outer const throws — same pattern as
 * readActionService.test.ts / connectionService.test.ts in this directory.
 */
const {
  enabled, budget, executeWriteAction, connRows, recordEvent, withDbAccessContext, withSystemDbAccessContext,
} = vi.hoisted(() => ({
  enabled: vi.fn(),
  budget: vi.fn(),
  executeWriteAction: vi.fn(),
  connRows: vi.fn(),
  recordEvent: vi.fn(),
  withDbAccessContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));

vi.mock('./writeActionRuntimeConfig', () => ({
  isM365GraphActionsEnabledForOrg: (o: string) => enabled(o),
  loadM365CustomerGraphActionsRuntimeConfig: () => ({
    executorUrl: 'https://x/',
    executorAudience: 'm365-graph-actions-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'k',
  }),
}));
vi.mock('./writeActionBudget', () => ({
  consumeM365WriteActionBudget: (id: string) => budget(id),
}));
vi.mock('./graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction }),
  GraphActionsExecutorClientError: class extends Error {},
}));
vi.mock('./writeActionMetrics', () => ({
  recordM365WriteActionEvent: (...a: unknown[]) => recordEvent(...a),
}));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => connRows() }) }) }) },
  withDbAccessContext: (ctx: unknown, fn: () => unknown) => withDbAccessContext(ctx, fn),
  withSystemDbAccessContext: (fn: () => unknown) => withSystemDbAccessContext(fn),
}));
vi.mock('../../db/schema', () => ({
  m365Connections: { orgId: 'orgId', profile: 'profile' },
}));
vi.mock('../../middleware/auth', () => ({
  dbAccessContextFromAuth: (auth: { orgId?: string }) => ({ scope: 'organization', orgId: auth.orgId }),
}));

import { executeM365WriteActionByOrg, executeM365WriteActionForAuth } from './writeActionService';
import { GraphActionsExecutorClientError } from './graphActionsExecutorClient';
import type { AuthContext } from '../../middleware/auth';

const ORG = '44444444-4444-4444-8444-444444444444';
const TENANT = '22222222-2222-4222-8222-222222222222';
const GROUP = '55555555-5555-4555-8555-555555555555';
const GRAPH = '00000003-0000-0000-c000-000000000000';
const action: M365WriteAction = { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' };
const groupRemove: M365WriteAction = {
  type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'offboard',
};

/** The two grants every pre-M1 (manifest v2) connection holds. */
const PRE_M1_GRANTS = [
  { resourceApplicationId: GRAPH, appRoleId: '741f803b-c850-494e-b5df-cde7c675a1ca', value: 'User.ReadWrite.All' },
  { resourceApplicationId: GRAPH, appRoleId: 'cc117bb9-00cf-4eb8-b580-ea2a878fe8f7', value: 'User-PasswordProfile.ReadWrite.All' },
];
const M1_GRANTS = [
  ...PRE_M1_GRANTS,
  { resourceApplicationId: GRAPH, appRoleId: '77f3a031-c388-4f99-b373-dc68676a979e', value: 'User.RevokeSessions.All' },
  { resourceApplicationId: GRAPH, appRoleId: 'dbaae8cf-10b5-4b86-a4a1-f871c94c6695', value: 'GroupMember.ReadWrite.All' },
  { resourceApplicationId: GRAPH, appRoleId: '5b07b0dd-2377-4e44-a38d-703f09a0dc3c', value: 'DeviceManagementManagedDevices.PrivilegedOperations.All' },
  { resourceApplicationId: GRAPH, appRoleId: '6931bccd-447a-43d1-b442-00a195474933', value: 'MailboxSettings.ReadWrite' },
  { resourceApplicationId: GRAPH, appRoleId: '498476ce-e0fe-48b0-b801-37ba7e2685c6', value: 'Organization.Read.All' },
];

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    orgId: ORG,
    profile: 'customer-graph-actions',
    status: 'active',
    tenantId: TENANT,
    permissionManifestVersion: 2,
    grantsVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    observedGrants: PRE_M1_GRANTS,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  enabled.mockReturnValue(true);
  budget.mockResolvedValue({ allowed: true });
  connRows.mockResolvedValue([row()]);
  executeWriteAction.mockResolvedValue({ success: true, action: 'm365.user.disable', userId: 'u1' });
  withDbAccessContext.mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
  withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
});

describe('executeM365WriteActionByOrg — app-role ladder (spec §7.2)', () => {
  it('refuses an M1 action on a pre-M1 connection with consent_upgrade_required, not connection_not_ready', async () => {
    const r = await executeM365WriteActionByOrg(ORG, groupRemove);
    expect(r).toMatchObject({ ok: false, code: 'consent_upgrade_required' });
    expect(executeWriteAction).not.toHaveBeenCalled();
    expect(budget).not.toHaveBeenCalled();
  });

  it('still executes the two pre-M1 actions on a pre-M1 connection (re-consent is an upgrade, not an outage)', async () => {
    for (const a of [
      { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
      { type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'x' },
    ] as const) {
      executeWriteAction.mockResolvedValueOnce(a.type === 'm365.user.disable'
        ? { success: true, action: a.type, userId: 'u1' }
        : { success: true, action: a.type, userId: 'u1', temporaryPassword: 'p', forceChangeNextSignIn: true });
      const r = await executeM365WriteActionByOrg(ORG, a);
      expect(r.ok).toBe(true);
    }
    expect(executeWriteAction).toHaveBeenCalledTimes(2);
  });

  it('keeps executing the pre-M1 actions on a kept-stale row whose Retest recorded manifest_stale', async () => {
    connRows.mockResolvedValue([row({ lastErrorCode: 'manifest_stale' })]);
    expect((await executeM365WriteActionByOrg(ORG, action)).ok).toBe(true);
  });

  it('does NOT refuse when the connection has no authoritative grant observation', async () => {
    connRows.mockResolvedValue([row({ grantsVerifiedAt: null, observedGrants: [] })]);
    executeWriteAction.mockResolvedValue({ success: true, action: 'm365.group.membership.remove', userId: 'u1', groupId: GROUP, noop: false });
    const r = await executeM365WriteActionByOrg(ORG, groupRemove);
    expect(executeWriteAction).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it('executes an M1 action on a v3 connection holding every M1 grant', async () => {
    connRows.mockResolvedValue([row({ permissionManifestVersion: 3, observedGrants: M1_GRANTS })]);
    executeWriteAction.mockResolvedValue({ success: true, action: 'm365.group.membership.remove', userId: 'u1', groupId: GROUP, noop: false });
    expect((await executeM365WriteActionByOrg(ORG, groupRemove)).ok).toBe(true);
  });

  it('matches grants on (resource, appRoleId), never on the value alone', async () => {
    const foreign = M1_GRANTS.map((g) => g.value === 'GroupMember.ReadWrite.All'
      ? { ...g, resourceApplicationId: '11111111-1111-4111-8111-111111111111' }
      : g);
    connRows.mockResolvedValue([row({ permissionManifestVersion: 2, observedGrants: foreign })]);
    expect(await executeM365WriteActionByOrg(ORG, groupRemove)).toMatchObject({ ok: false, code: 'consent_upgrade_required' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('refuses connection_not_ready (not an upgrade prompt) when a CURRENT-manifest row lacks a required grant', async () => {
    // A v3 row only reaches active without a role if something outside the
    // consent flow removed it; upgrade consent would refuse (manifest_current),
    // so telling the operator to "re-consent the upgrade" would be a dead end.
    connRows.mockResolvedValue([row({
      permissionManifestVersion: 3,
      observedGrants: M1_GRANTS.filter((g) => g.value !== 'GroupMember.ReadWrite.All'),
    })]);
    expect(await executeM365WriteActionByOrg(ORG, groupRemove)).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('audits a consent_upgrade_required refusal with the fixed {actionType, outcome} shape', async () => {
    await executeM365WriteActionByOrg(ORG, groupRemove, { actorId: 'user-1' });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG, connectionId: 'conn-1', actionType: 'm365.group.membership.remove',
        outcome: 'consent_upgrade_required', actorId: 'user-1',
      }),
    );
  });

  it('gates the read-only auto-reply probe arm on MailboxSettings.ReadWrite too', async () => {
    const r = await executeM365WriteActionByOrg(ORG, { type: 'm365.user.mailbox.auto_reply.state', userIdentifier: 'a@b.com' });
    expect(r).toMatchObject({ ok: false, code: 'consent_upgrade_required' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });
});

describe('executeM365WriteActionForAuth', () => {
  const auth = {
    scope: 'organization',
    orgId: ORG,
    user: { id: 'user-1' },
    canAccessOrg: (id: string) => id === ORG,
    accessibleOrgIds: [ORG],
  } as unknown as AuthContext;

  it('refuses a site-restricted session before touching the database', async () => {
    const r = await executeM365WriteActionForAuth({ ...auth, allowedSiteIds: ['s1'] } as unknown as AuthContext, action);
    expect(r).toMatchObject({ ok: false, code: 'site_scope_denied' });
    expect(connRows).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('refuses a device-bound run and an empty site allow-list (org-wide governance ceiling)', async () => {
    for (const restricted of [
      { ...auth, allowedDeviceIds: ['d1'] },
      { ...auth, allowedSiteIds: [] },
    ]) {
      const r = await executeM365WriteActionForAuth(restricted as unknown as AuthContext, action);
      expect(r).toMatchObject({ ok: false, code: 'site_scope_denied' });
    }
    expect(connRows).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('refuses the read-only probe arm: the chat path takes mutating actions only', async () => {
    const r = await executeM365WriteActionForAuth(
      auth,
      { type: 'm365.user.mailbox.auto_reply.state', userIdentifier: 'a@b.com' } as unknown as M365MutatingAction,
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_action' });
    expect(connRows).not.toHaveBeenCalled();
  });

  it('refuses when no org can be resolved', async () => {
    const partner = {
      scope: 'partner', orgId: null, user: { id: 'user-1' },
      canAccessOrg: () => true, accessibleOrgIds: null,
    } as unknown as AuthContext;
    expect(await executeM365WriteActionForAuth(partner, action)).toMatchObject({ ok: false, code: 'org_context_required' });
    expect(connRows).not.toHaveBeenCalled();
  });

  it('refuses another org for an organization-scoped token', async () => {
    expect(await executeM365WriteActionForAuth(auth, action, '66666666-6666-4666-8666-666666666666'))
      .toMatchObject({ ok: false, code: 'org_context_required' });
    expect(connRows).not.toHaveBeenCalled();
  });

  it('opens a db access context from the auth (never a system context) and attributes the actor', async () => {
    const r = await executeM365WriteActionForAuth(auth, action);
    expect(r.ok).toBe(true);
    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
    expect(withDbAccessContext.mock.calls[0]?.[0]).toEqual({ scope: 'organization', orgId: ORG });
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorId: 'user-1', outcome: 'ok' }));
  });

  it('runs the same ladder: an M1 action on a pre-M1 connection is consent_upgrade_required', async () => {
    expect(await executeM365WriteActionForAuth(auth, groupRemove)).toMatchObject({ ok: false, code: 'consent_upgrade_required' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });
});

describe('executeM365WriteActionByOrg', () => {
  it('runs the happy path, calls the executor once, and audits ok', async () => {
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toEqual({ ok: true, result: { success: true, action: 'm365.user.disable', userId: 'u1' } });
    expect(executeWriteAction).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG, connectionId: 'conn-1', actionType: 'm365.user.disable', outcome: 'ok' }),
    );
  });

  it('refuses when the flag is off (no DB, no executor)', async () => {
    enabled.mockReturnValue(false);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'tools_disabled' });
    expect(connRows).not.toHaveBeenCalled();
    expect(budget).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('fails closed when there is no connection row at all', async () => {
    connRows.mockResolvedValue([]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(budget).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails closed when the connection is for a different org (defense-in-depth over RLS)', async () => {
    connRows.mockResolvedValue([
      { id: 'conn-2', orgId: 'other-org', profile: 'customer-graph-actions', status: 'active', tenantId: TENANT },
    ]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(budget).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails closed when the connection is revoked', async () => {
    connRows.mockResolvedValue([
      { id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'revoked', tenantId: TENANT },
    ]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(budget).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails closed when the connection is degraded (write side is stricter than read: active-only)', async () => {
    connRows.mockResolvedValue([
      { id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'degraded', tenantId: TENANT },
    ]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails closed when the connection has no verified tenant', async () => {
    connRows.mockResolvedValue([
      { id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'active', tenantId: null },
    ]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('refuses when the budget denies (no executor call)', async () => {
    budget.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'write_rate_limited', retryAfterSeconds: 60 });
    expect(executeWriteAction).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('reports executor_unavailable and audits it when the executor client throws', async () => {
    executeWriteAction.mockRejectedValue(new GraphActionsExecutorClientError());
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'executor_unavailable' });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'executor_unavailable' }),
    );
  });

  it('rethrows unexpected (non-executor-client) errors instead of swallowing them', async () => {
    executeWriteAction.mockRejectedValue(new Error('boom'));
    await expect(executeM365WriteActionByOrg(ORG, action)).rejects.toThrow('boom');
  });

  it('returns the executor-reported failure code and audits it, never the raw result contents', async () => {
    executeWriteAction.mockResolvedValue({ success: false, errorCode: 'user_not_found' });
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'user_not_found' });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'user_not_found' }),
    );
  });

  it('never leaks a temporary password into the audit event details', async () => {
    executeWriteAction.mockResolvedValue({
      success: true,
      action: 'm365.user.reset_password',
      userId: 'u1',
      temporaryPassword: 'SUPER-SECRET-DO-NOT-LOG',
      forceChangeNextSignIn: true,
    });
    const r = await executeM365WriteActionByOrg(ORG, {
      type: 'm365.user.reset_password',
      userIdentifier: 'a@b.com',
      reason: 'x',
    });
    expect(r).toMatchObject({ ok: true });
    const call = recordEvent.mock.calls[0];
    expect(JSON.stringify(call)).not.toContain('SUPER-SECRET-DO-NOT-LOG');
  });
});
