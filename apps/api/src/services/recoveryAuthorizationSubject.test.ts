import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { UserPermissions } from './permissions';
import {
  RecoveryAuthorizationDeniedError,
  RecoveryAuthorizationTransientError,
  authorizeQueuedRecoveryWork,
  captureRecoveryAuthorizationSubject,
  extractRecoveryOAuthScopes,
  rehydrateRecoveryAuthorizationSubject,
  type RecoveryAuthorizationSubjectDependencies,
  type RecoveryAuthorizationSubjectRow,
} from './recoveryAuthorizationSubject';
import { ResilienceAuthorizationError } from './resilienceSiteAuthorization';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PRINCIPAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RUN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOW = new Date('2026-08-24T18:00:00.000Z');

const backupWriter: UserPermissions = {
  permissions: [
    { resource: 'backup', action: 'read' },
    { resource: 'backup', action: 'write' },
    { resource: 'backup', action: 'cross_site_restore' },
    { resource: 'devices', action: 'execute' },
    { resource: 'scripts', action: 'execute' },
  ],
  partnerId: null,
  orgId: ORG_ID,
  roleId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  scope: 'organization',
  allowedSiteIds: ['11111111-1111-4111-8111-111111111111'],
};

function auth(principal: AuthContext['principal'], userId = USER_ID): AuthContext {
  return {
    principal,
    user: { id: userId, email: 'operator@example.com', name: 'Operator', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: (orgId) => orgId === ORG_ID,
  } as AuthContext;
}

function dependencies(
  overrides: Partial<RecoveryAuthorizationSubjectDependencies> = {},
): RecoveryAuthorizationSubjectDependencies {
  return {
    now: () => NOW,
    loadUser: vi.fn(async (id, orgId) => ({
      id,
      orgId,
      partnerId: null,
      status: 'active',
      authEpoch: 4,
      permissionsEpoch: 9,
      permissions: backupWriter,
    })),
    loadApiKey: vi.fn(async (id, orgId) => ({
      id,
      orgId,
      status: 'active',
      expiresAt: new Date('2026-08-25T00:00:00.000Z'),
      updatedAt: new Date('2026-08-24T17:00:00.000Z'),
      scopes: ['ai:execute'],
      principalType: 'human',
      principalId: null,
      createdBy: USER_ID,
    })),
    loadServicePrincipal: vi.fn(async (id, orgId) => ({
      id,
      orgId,
      status: 'active',
      scopes: ['ai:execute'],
      updatedAt: new Date('2026-08-24T17:30:00.000Z'),
    })),
    loadOAuthGrant: vi.fn(async (id) => ({
      id,
      accountId: USER_ID,
      clientId: 'oauth-client',
      partnerId: null,
      orgId: ORG_ID,
      scopes: ['ai:execute'],
      expiresAt: new Date('2026-08-25T00:00:00.000Z'),
      revokedAt: null,
      clientDisabledAt: null,
      clientBlocked: false,
    })),
    loadAiRun: vi.fn(async (id, orgId) => ({
      id,
      orgId,
      agentId: PRINCIPAL_ID,
      runStatus: 'running',
      agentEnabled: true,
      agentDisabledAt: null,
      effectiveEnabled: true,
      effectiveMode: 'supervised',
      effectiveToolAllowlist: ['execute_dr_plan'],
      effectivePolicyRevision: 'policy-v4',
      allowedSiteIds: ['11111111-1111-4111-8111-111111111111'],
    })),
    authorizeResilienceResources: vi.fn(async () => ({ resources: [] })),
    ...overrides,
  };
}

function stored(
  kind: RecoveryAuthorizationSubjectRow['authorizationPrincipalKind'],
  principalId: string | null,
  revision = 'stored-revision',
): RecoveryAuthorizationSubjectRow {
  return {
    authorizationPrincipalKind: kind,
    authorizationPrincipalId: principalId,
    authorizationGrantRevision: revision,
    authorizationState: 'pending',
    authorizationDenialCode: null,
    authorizationCheckedAt: null,
  };
}

describe('captureRecoveryAuthorizationSubject', () => {
  it('captures an active user session with a live epoch-derived revision', async () => {
    const subject = await captureRecoveryAuthorizationSubject(
      auth({ kind: 'user_session' }),
      ORG_ID,
      'restore',
      dependencies(),
    );

    expect(subject).toMatchObject({
      authorizationPrincipalKind: 'user_session',
      authorizationPrincipalId: USER_ID,
      authorizationState: 'pending',
      authorizationDenialCode: null,
      authorizationCheckedAt: null,
    });
    expect(subject.authorizationGrantRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('records the API key id rather than its creator id', async () => {
    const subject = await captureRecoveryAuthorizationSubject(
      auth({ kind: 'api_key', apiKeyId: KEY_ID }),
      ORG_ID,
      'restore',
      dependencies(),
    );

    expect(subject.authorizationPrincipalId).toBe(KEY_ID);
    expect(subject.authorizationPrincipalId).not.toBe(USER_ID);
  });

  it('records the AI run id rather than the mutable agent id', async () => {
    const subject = await captureRecoveryAuthorizationSubject(
      auth({ kind: 'ai_agent', agentId: PRINCIPAL_ID, runId: RUN_ID }),
      ORG_ID,
      { operation: 'restore', requiredAiTool: 'execute_dr_plan' },
      dependencies(),
    );

    expect(subject.authorizationPrincipalId).toBe(RUN_ID);
  });

  it('accepts only an allowlisted system reason for its operation', async () => {
    await expect(captureRecoveryAuthorizationSubject(
      auth({ kind: 'system', reason: 'backup-verification-scheduler' }),
      ORG_ID,
      'verify',
      dependencies(),
    )).resolves.toMatchObject({
      authorizationPrincipalKind: 'system',
      authorizationPrincipalId: 'backup-verification-scheduler',
      authorizationGrantRevision: 'system-recovery-v1',
    });

    await expect(captureRecoveryAuthorizationSubject(
      auth({ kind: 'system', reason: 'request-supplied-system' }),
      ORG_ID,
      'verify',
      dependencies(),
    )).rejects.toMatchObject({ code: 'system_reason_not_allowed', retriable: false });
  });

  it.each([
    [{ kind: 'unknown' } as const, 'unknown_principal'],
    [{ kind: 'agent', deviceId: PRINCIPAL_ID } as const, 'principal_kind_not_supported'],
    [{ kind: 'helper', deviceId: PRINCIPAL_ID } as const, 'principal_kind_not_supported'],
    [{ kind: 'api_key' } as const, 'principal_id_missing'],
  ])('rejects unsupported or incomplete principal %#', async (principal, code) => {
    await expect(captureRecoveryAuthorizationSubject(
      auth(principal),
      ORG_ID,
      'restore',
      dependencies(),
    )).rejects.toMatchObject({ code, retriable: false });
  });
});

describe('extractRecoveryOAuthScopes', () => {
  it('reads oidc-provider Grant openid/resource scope shapes and subtracts rejected scopes', () => {
    expect(extractRecoveryOAuthScopes({
      openid: { scope: 'openid offline_access mcp:read mcp:execute' },
      resources: { 'https://mcp.example.test': 'mcp:read mcp:execute' },
      rejected: { openid: { scope: 'mcp:read' } },
    })).toEqual(['openid', 'offline_access', 'mcp:execute']);
  });
});

describe('rehydrateRecoveryAuthorizationSubject', () => {
  it('denies a user disabled after enqueue', async () => {
    const deps = dependencies({
      loadUser: vi.fn(async () => ({
        id: USER_ID,
        orgId: ORG_ID,
        partnerId: null,
        status: 'disabled',
        authEpoch: 5,
        permissionsEpoch: 10,
        permissions: null,
      })),
    });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('user_session', USER_ID),
      ORG_ID,
      'restore',
      deps,
    )).rejects.toMatchObject({ code: 'principal_disabled', retriable: false });
  });

  it('keeps human API-key authority clamped to the live creator', async () => {
    const deps = dependencies({
      loadUser: vi.fn(async () => null),
    });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('api_key', KEY_ID),
      ORG_ID,
      'restore',
      deps,
    )).rejects.toMatchObject({ code: 'principal_inactive', retriable: false });
  });

  it('denies a human API key when its creator can no longer delegate the stored scopes', async () => {
    const deps = dependencies({
      loadUser: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        partnerId: null,
        status: 'active',
        authEpoch: 4,
        permissionsEpoch: 10,
        permissions: {
          ...backupWriter,
          permissions: backupWriter.permissions.filter((permission) => permission.resource !== 'devices'),
        },
      })),
    });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('api_key', KEY_ID),
      ORG_ID,
      'restore',
      deps,
    )).rejects.toMatchObject({ code: 'delegation_scope_denied', retriable: false });
  });

  it('resolves service-principal API keys independently of their creators', async () => {
    const loadUser = vi.fn(async () => {
      throw new Error('the creator must not be consulted');
    });
    const deps = dependencies({
      loadUser,
      loadApiKey: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        status: 'active',
        expiresAt: new Date('2026-08-25T00:00:00.000Z'),
        updatedAt: new Date('2026-08-24T17:00:00.000Z'),
        scopes: ['ai:execute'],
        principalType: 'service',
        principalId: PRINCIPAL_ID,
        createdBy: USER_ID,
      })),
    });

    const live = await rehydrateRecoveryAuthorizationSubject(
      stored('api_key', KEY_ID),
      ORG_ID,
      'restore',
      deps,
    );

    expect(live.principalKind).toBe('api_key');
    expect(live.delegatedScopes).toEqual(['ai:execute']);
    expect(loadUser).not.toHaveBeenCalled();
  });

  it('denies a disabled or scope-reduced service principal', async () => {
    const deps = dependencies({
      loadApiKey: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        status: 'active',
        expiresAt: new Date('2026-08-25T00:00:00.000Z'),
        updatedAt: new Date('2026-08-24T17:00:00.000Z'),
        scopes: ['ai:execute'],
        principalType: 'service',
        principalId: PRINCIPAL_ID,
        createdBy: USER_ID,
      })),
      loadServicePrincipal: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        status: 'disabled',
        scopes: [],
        updatedAt: NOW,
      })),
    });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('api_key', KEY_ID),
      ORG_ID,
      'restore',
      deps,
    )).rejects.toMatchObject({ code: 'principal_disabled', retriable: false });
  });

  it.each([
    ['revoked grant', { revokedAt: NOW }],
    ['expired grant', { expiresAt: new Date('2026-08-24T17:59:59.000Z') }],
    ['disabled client', { clientDisabledAt: NOW }],
    ['blocked client', { clientBlocked: true }],
  ])('denies OAuth when the %s is no longer live', async (_label, change) => {
    const base = await dependencies().loadOAuthGrant!('grant-1', ORG_ID);
    const deps = dependencies({ loadOAuthGrant: vi.fn(async () => ({ ...base!, ...change })) });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('oauth_grant', 'grant-1'),
      ORG_ID,
      'restore',
      deps,
    )).rejects.toBeInstanceOf(RecoveryAuthorizationDeniedError);
  });

  it('loads OAuth block state for the queued work target organization', async () => {
    const deps = dependencies();

    await rehydrateRecoveryAuthorizationSubject(
      stored('oauth_grant', 'grant-1'),
      ORG_ID,
      'restore',
      deps,
    );

    expect(deps.loadOAuthGrant).toHaveBeenCalledWith('grant-1', ORG_ID);
  });

  it('denies OAuth when the live account loses the queued operation base permission', async () => {
    const deps = dependencies({
      loadUser: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        partnerId: null,
        status: 'active',
        authEpoch: 4,
        permissionsEpoch: 10,
        permissions: {
          ...backupWriter,
          permissions: backupWriter.permissions.filter((permission) => permission.resource !== 'backup'),
        },
      })),
    });

    await expect(authorizeQueuedRecoveryWork(
      stored('oauth_grant', 'grant-1'),
      ORG_ID,
      [],
      'restore',
      deps,
    )).rejects.toMatchObject({ code: 'base_permission_denied', retriable: false });
  });

  it('maps a live mcp:execute OAuth grant to the internal recovery execution scope', async () => {
    const deps = dependencies({
      loadOAuthGrant: vi.fn(async (id) => ({
        id,
        accountId: USER_ID,
        clientId: 'oauth-client',
        partnerId: null,
        orgId: ORG_ID,
        scopes: ['openid', 'mcp:execute'],
        expiresAt: new Date('2026-08-25T00:00:00.000Z'),
        revokedAt: null,
        clientDisabledAt: null,
        clientBlocked: false,
      })),
    });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('oauth_grant', 'grant-1'),
      ORG_ID,
      'restore',
      deps,
    )).resolves.toMatchObject({ delegatedScopes: expect.arrayContaining(['ai:execute']) });
  });

  it('denies a partner-scoped OAuth grant when its durable partner axis mismatches the account', async () => {
    const deps = dependencies({
      loadOAuthGrant: vi.fn(async (id) => ({
        id,
        accountId: USER_ID,
        clientId: 'oauth-client',
        partnerId: '22222222-2222-4222-8222-222222222222',
        orgId: null,
        scopes: ['ai:execute'],
        expiresAt: new Date('2026-08-25T00:00:00.000Z'),
        revokedAt: null,
        clientDisabledAt: null,
        clientBlocked: false,
      })),
      loadUser: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        partnerId: '33333333-3333-4333-8333-333333333333',
        status: 'active',
        authEpoch: 4,
        permissionsEpoch: 9,
        permissions: backupWriter,
      })),
    });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('oauth_grant', 'grant-1'),
      ORG_ID,
      'restore',
      deps,
    )).rejects.toMatchObject({ code: 'principal_tenant_mismatch', retriable: false });
  });

  it('denies an AI run when its live effective policy is disabled or loses the required tool', async () => {
    const disabled = dependencies({
      loadAiRun: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        agentId: PRINCIPAL_ID,
        runStatus: 'running',
        agentEnabled: true,
        agentDisabledAt: null,
        effectiveEnabled: false,
        effectiveMode: 'off',
        effectiveToolAllowlist: ['execute_dr_plan'],
        effectivePolicyRevision: 'policy-v5',
        allowedSiteIds: ['11111111-1111-4111-8111-111111111111'],
      })),
    });
    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('ai_agent', RUN_ID),
      ORG_ID,
      { operation: 'restore', requiredAiTool: 'execute_dr_plan' },
      disabled,
    )).rejects.toMatchObject({ code: 'principal_disabled' });

    const reduced = dependencies({
      loadAiRun: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        agentId: PRINCIPAL_ID,
        runStatus: 'running',
        agentEnabled: true,
        agentDisabledAt: null,
        effectiveEnabled: true,
        effectiveMode: 'supervised',
        effectiveToolAllowlist: [],
        effectivePolicyRevision: 'policy-v6',
        allowedSiteIds: ['11111111-1111-4111-8111-111111111111'],
      })),
    });
    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('ai_agent', RUN_ID),
      ORG_ID,
      { operation: 'restore', requiredAiTool: 'execute_dr_plan' },
      reduced,
    )).rejects.toMatchObject({ code: 'delegation_scope_denied' });
  });

  it('fails closed when an AI run has no live device-site lineage', async () => {
    const deps = dependencies({
      loadAiRun: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        agentId: PRINCIPAL_ID,
        runStatus: 'running',
        agentEnabled: true,
        agentDisabledAt: null,
        effectiveEnabled: true,
        effectiveMode: 'supervised',
        effectiveToolAllowlist: ['execute_dr_plan'],
        effectivePolicyRevision: 'policy-v7',
        allowedSiteIds: [],
      })),
    });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('ai_agent', RUN_ID),
      ORG_ID,
      { operation: 'restore', requiredAiTool: 'execute_dr_plan' },
      deps,
    )).rejects.toMatchObject({ code: 'principal_inactive', retriable: false });
  });

  it('requires queued AI work to name the live tool grant it depends on', async () => {
    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('ai_agent', RUN_ID),
      ORG_ID,
      'restore',
      dependencies(),
    )).rejects.toMatchObject({ code: 'delegation_scope_denied', retriable: false });
  });

  it('reports revision drift as evidence without treating a matching revision as authority', async () => {
    const deps = dependencies();
    const first = await rehydrateRecoveryAuthorizationSubject(
      stored('user_session', USER_ID, 'stale'),
      ORG_ID,
      'restore',
      deps,
    );
    expect(first.grantRevisionDrifted).toBe(true);

    const second = await rehydrateRecoveryAuthorizationSubject(
      stored('user_session', USER_ID, first.currentGrantRevision),
      ORG_ID,
      'restore',
      deps,
    );
    expect(second.grantRevisionDrifted).toBe(false);
    expect(deps.loadUser).toHaveBeenCalledTimes(2);
  });

  it('does not infer a subject from legacy createdBy or initiatedBy attribution', async () => {
    await expect(rehydrateRecoveryAuthorizationSubject(
      {
        ...stored('unknown', null, null as unknown as string),
        createdBy: USER_ID,
        initiatedBy: USER_ID,
      },
      ORG_ID,
      'restore',
      dependencies(),
    )).rejects.toMatchObject({ code: 'authorization_subject_unknown', retriable: false });
  });

  it('preserves transient lookup failures as retriable', async () => {
    const deps = dependencies({
      loadUser: vi.fn(async () => {
        throw new RecoveryAuthorizationTransientError('authorization_dependency_unavailable');
      }),
    });

    await expect(rehydrateRecoveryAuthorizationSubject(
      stored('user_session', USER_ID),
      ORG_ID,
      'restore',
      deps,
    )).rejects.toMatchObject({
      code: 'authorization_dependency_unavailable',
      retriable: true,
    });
  });
});

describe('authorizeQueuedRecoveryWork', () => {
  it.each([
    [403, 'site_access_denied'],
    [404, 'resource_not_found'],
  ] as const)('classifies live lineage %s/%s as a known non-retriable denial', async (status, code) => {
    const deps = dependencies({
      authorizeResilienceResources: vi.fn(async () => {
        throw new ResilienceAuthorizationError(status, code);
      }),
    });

    await expect(authorizeQueuedRecoveryWork(
      stored('user_session', USER_ID),
      ORG_ID,
      [{ kind: 'snapshot', id: '22222222-2222-4222-8222-222222222222', role: 'source' }],
      'media',
      deps,
    )).rejects.toMatchObject({ code, retriable: false });
  });

  it('lets an allowlisted system reason reach live lineage without user RBAC grants', async () => {
    const deps = dependencies();
    const subject = await captureRecoveryAuthorizationSubject(
      auth({ kind: 'system', reason: 'backup-verification-scheduler' }),
      ORG_ID,
      'verify',
      deps,
    );

    await expect(authorizeQueuedRecoveryWork(
      subject,
      ORG_ID,
      [{ kind: 'snapshot', id: '22222222-2222-4222-8222-222222222222', role: 'source' }],
      'verify',
      deps,
    )).resolves.toBeDefined();
    expect(deps.authorizeResilienceResources).toHaveBeenCalledTimes(1);
  });

  it('lets a currently tool-authorized AI run reach live site lineage', async () => {
    const deps = dependencies();

    await expect(authorizeQueuedRecoveryWork(
      stored('ai_agent', RUN_ID),
      ORG_ID,
      [{ kind: 'snapshot', id: '22222222-2222-4222-8222-222222222222', role: 'source' }],
      { operation: 'restore', requiredAiTool: 'execute_dr_plan' },
      deps,
    )).resolves.toBeDefined();
    expect(deps.authorizeResilienceResources).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({
        kind: 'ai_agent',
        permissions: expect.objectContaining({
          allowedSiteIds: ['11111111-1111-4111-8111-111111111111'],
        }),
      }),
    }));
  });

  it.each([
    'queued',
    'awaiting_approval',
    'completed',
    'failed',
    'cancelled',
    'expired',
    'skipped',
  ] as const)('denies queued recovery effects when the captured AI run becomes non-executing: %s', async (runStatus) => {
    let liveRunStatus = 'running';
    const authorizeResilienceResources = vi.fn(async () => ({ resources: [] }));
    const deps = dependencies({
      loadAiRun: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        agentId: PRINCIPAL_ID,
        runStatus: liveRunStatus,
        agentEnabled: true,
        agentDisabledAt: null,
        effectiveEnabled: true,
        effectiveMode: 'supervised',
        effectiveToolAllowlist: ['execute_dr_plan'],
        effectivePolicyRevision: 'policy-v4',
        allowedSiteIds: ['11111111-1111-4111-8111-111111111111'],
      })),
      authorizeResilienceResources,
    });
    const captured = await captureRecoveryAuthorizationSubject(
      auth({ kind: 'ai_agent', agentId: PRINCIPAL_ID, runId: RUN_ID }),
      ORG_ID,
      { operation: 'restore', requiredAiTool: 'execute_dr_plan' },
      deps,
    );
    liveRunStatus = runStatus;
    authorizeResilienceResources.mockClear();

    await expect(authorizeQueuedRecoveryWork(
      captured,
      ORG_ID,
      [{ kind: 'snapshot', id: '22222222-2222-4222-8222-222222222222', role: 'source' }],
      { operation: 'restore', requiredAiTool: 'execute_dr_plan' },
      deps,
    )).rejects.toMatchObject({ code: 'principal_inactive', retriable: false });
    expect(authorizeResilienceResources).not.toHaveBeenCalled();
  });

  it('always performs live base-permission and lineage authorization even when the revision matches', async () => {
    const deps = dependencies();
    const captured = await captureRecoveryAuthorizationSubject(
      auth({ kind: 'user_session' }),
      ORG_ID,
      'restore',
      deps,
    );
    vi.mocked(deps.loadUser).mockClear();

    await authorizeQueuedRecoveryWork(
      captured,
      ORG_ID,
      [{ kind: 'snapshot', id: '22222222-2222-4222-8222-222222222222', role: 'source' }],
      'restore',
      deps,
    );

    expect(deps.loadUser).toHaveBeenCalledTimes(1);
    expect(deps.authorizeResilienceResources).toHaveBeenCalledTimes(1);
  });

  it('denies before lineage when live base permission was removed', async () => {
    const noBackupWrite = { ...backupWriter, permissions: [] };
    const authorizeResilienceResources = vi.fn(async () => ({ resources: [] }));
    const deps = dependencies({
      loadUser: vi.fn(async (id, orgId) => ({
        id,
        orgId,
        partnerId: null,
        status: 'active',
        authEpoch: 4,
        permissionsEpoch: 10,
        permissions: noBackupWrite,
      })),
      authorizeResilienceResources,
    });

    await expect(authorizeQueuedRecoveryWork(
      stored('user_session', USER_ID),
      ORG_ID,
      [],
      'restore',
      deps,
    )).rejects.toMatchObject({ code: 'base_permission_denied', retriable: false });
    expect(authorizeResilienceResources).not.toHaveBeenCalled();
  });

  it('requires current organization write authority for C2C restore work', async () => {
    const deps = dependencies();

    await expect(authorizeQueuedRecoveryWork(
      stored('user_session', USER_ID),
      ORG_ID,
      [],
      'c2c_restore',
      deps,
    )).rejects.toMatchObject({ code: 'base_permission_denied', retriable: false });
  });
});
