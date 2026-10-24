import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { M365ReadAction } from '@breeze/shared/m365';

const { dbMocks, contextMocks, orgMocks, runtimeMocks, budgetMocks, executorMocks, auditMocks } = vi.hoisted(() => ({
  dbMocks: {
    selectResults: [] as unknown[][],
    selectSpy: vi.fn(),
  },
  contextMocks: {
    fromAuth: vi.fn((auth: unknown) => ({ scope: 'organization', auth })),
    withCaller: vi.fn(async <T>(_context: unknown, fn: () => Promise<T>) => fn()),
    system: vi.fn(),
  },
  orgMocks: {
    resolveWritableToolOrgId: vi.fn(),
  },
  runtimeMocks: {
    enabled: vi.fn(),
    // Which "off" the gate reports when `enabled` is false (#9319).
    disabledReason: 'instance_disabled' as 'instance_disabled' | 'org_not_enabled',
    loadConfig: vi.fn(),
  },
  budgetMocks: {
    consume: vi.fn(),
  },
  executorMocks: {
    createClient: vi.fn(),
    executeReadAction: vi.fn(),
  },
  auditMocks: {
    writeAuditEvent: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  m365Connections: {
    id: { name: 'id' },
    orgId: { name: 'org_id' },
    tenantId: { name: 'tenant_id' },
    profile: { name: 'profile' },
    status: { name: 'status' },
  },
}));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
    eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
  };
});

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => {
      dbMocks.selectSpy(...args);
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => dbMocks.selectResults.shift() ?? []),
          })),
        })),
      };
    },
  },
  withDbAccessContext: contextMocks.withCaller,
  withSystemDbAccessContext: vi.fn(async <T>(fn: () => Promise<T>, label?: string) => { contextMocks.system(label); return fn(); }),
}));

vi.mock('../../middleware/auth', () => ({
  dbAccessContextFromAuth: contextMocks.fromAuth,
}));

vi.mock('../aiToolWriteOrg', () => ({
  resolveWritableToolOrgId: orgMocks.resolveWritableToolOrgId,
}));

vi.mock('./runtimeConfig', () => ({
  isM365GraphReadToolsEnabledForOrg: runtimeMocks.enabled,
  m365GraphReadToolsAvailability: (orgId: string) =>
    (runtimeMocks.enabled(orgId) ? 'enabled' : runtimeMocks.disabledReason),
  loadM365CustomerGraphReadRuntimeConfig: runtimeMocks.loadConfig,
}));

vi.mock('./readActionBudget', () => ({
  consumeM365ReadActionBudget: budgetMocks.consume,
}));

vi.mock('./graphReadExecutorClient', async (importActual) => {
  const actual = await importActual<typeof import('./graphReadExecutorClient')>();
  return {
    ...actual,
    createGraphReadExecutorClient: executorMocks.createClient,
  };
});

// Only writeAuditEvent is mocked — recordM365ReadActionEvent (readActionMetrics.ts)
// runs for real, so its `result: 'success'|'failure'` mapping and safe-details
// construction get genuine coverage through this test file (per the task's
// exact file list, there is no separate readActionMetrics.test.ts).
vi.mock('../auditEvents', async (importActual) => {
  const actual = await importActual<typeof import('../auditEvents')>();
  return {
    ...actual,
    writeAuditEvent: auditMocks.writeAuditEvent,
  };
});

import { executeM365UserLookupForCallerTarget, executeM365MailboxReadByOrg, executeM365ReadAction, executeM365ReadActionByOrg } from './readActionService';
import { GraphReadExecutorClientError } from './graphReadExecutorClient';
import type { AuthContext } from '../../middleware/auth';
import type { RequestLike } from '../auditEvents';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';

const ORG_GET_ACTION: M365ReadAction = { type: 'm365.org.get' };

const RUNTIME_CONFIG = {
  clientId: '55555555-5555-4555-8555-555555555555',
  vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
  credentialVersion: '0123456789abcdef0123456789abcdef',
  callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
  executorUrl: 'https://executor.internal.example.test',
  executorAudience: 'm365-graph-read-executor' as const,
  executorSigningPrivateJwk: {},
  executorSigningKid: 'key-1',
  onboardingOrgIds: '*' as const,
};

// Structurally matches production (apps/api/src/middleware/auth.ts:527-554):
// `canAccessSite` is ALWAYS a defined, permissive-by-default closure for
// organization-scope AuthContexts — it is `allowedSiteIds` being defined
// (not undefined) that signals a site-restricted caller. Defaulting
// `canAccessSite` to an always-true closure and `allowedSiteIds` to
// undefined here means overriding only `canAccessSite` (the old, wrong
// signal) in a test can never look like it produces a site-scope denial.
function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: ACTOR_ID, email: 'actor@example.test', name: 'Actor', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
    ...overrides,
  } as AuthContext;
}

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    tenantId: TENANT_ID,
    profile: 'customer-graph-read',
    status: 'active',
    ...overrides,
  };
}

describe('executeM365ReadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    orgMocks.resolveWritableToolOrgId.mockReturnValue({ orgId: ORG_ID });
    runtimeMocks.enabled.mockReturnValue(true);
    runtimeMocks.loadConfig.mockReturnValue(RUNTIME_CONFIG);
    budgetMocks.consume.mockResolvedValue({ allowed: true });
    executorMocks.createClient.mockReturnValue({ executeReadAction: executorMocks.executeReadAction });
  });

  it('refuses site-restricted sessions before any DB access', async () => {
    const result = await executeM365ReadAction(
      auth({ allowedSiteIds: ['site-1'] }),
      ORG_GET_ACTION,
    );

    expect(result).toEqual({
      ok: false,
      code: 'site_scope_denied',
      message: 'Microsoft 365 tools are not available to site-restricted sessions.',
    });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
    expect(orgMocks.resolveWritableToolOrgId).not.toHaveBeenCalled();
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('proceeds past site-scope gate for an unrestricted org auth even though canAccessSite is defined', async () => {
    // Regression for the wrong-signal bug: production org-scope AuthContexts
    // ALWAYS carry a defined `canAccessSite` closure (see auth.ts:527-554),
    // even when unrestricted. Only `allowedSiteIds` being defined signals a
    // real site restriction. auth() defaults `canAccessSite` to a defined,
    // permissive closure and `allowedSiteIds` to undefined — asserting this
    // reaches org resolution (and beyond) proves the gate reads the right field.
    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(orgMocks.resolveWritableToolOrgId).toHaveBeenCalled();
    expect(result).not.toMatchObject({ code: 'site_scope_denied' });
  });

  it('surfaces org_context_required when org resolution fails', async () => {
    orgMocks.resolveWritableToolOrgId.mockReturnValue({ error: 'Cannot access another organization' });

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toEqual({
      ok: false,
      code: 'org_context_required',
      message: 'Cannot access another organization',
    });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
  });

  it('never lets an ambiguous multi-org read fall back to the device-page write default (#6675)', async () => {
    // A real resolveWritableToolOrgId would refuse this only when the caller
    // passes { useWriteDefault: false } — this mock stands in for that real
    // behavior so the assertion actually pins the call site's third argument.
    orgMocks.resolveWritableToolOrgId.mockImplementation(
      (_authArg: AuthContext, _inputOrgId: string | undefined, options?: { useWriteDefault?: boolean }) => {
        if (options?.useWriteDefault === false) {
          return { error: 'orgId is required: you have access to multiple organizations' };
        }
        return { orgId: 'org-b' };
      },
    );
    const partnerAuthWithWriteDefault = auth({
      orgId: null,
      scope: 'partner' as AuthContext['scope'],
      accessibleOrgIds: ['org-a', 'org-b'],
      canAccessOrg: (id: string | null | undefined) => id === 'org-a' || id === 'org-b',
      aiWriteDefaultOrgId: 'org-b',
    } as Partial<AuthContext>);

    const result = await executeM365ReadAction(partnerAuthWithWriteDefault, ORG_GET_ACTION);

    expect(result).toEqual({
      ok: false,
      code: 'org_context_required',
      message: 'orgId is required: you have access to multiple organizations',
    });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
  });

  it('refuses when Graph read tools are disabled for the org', async () => {
    runtimeMocks.enabled.mockReturnValue(false);

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toEqual({
      ok: false,
      code: 'tools_disabled',
      reason: 'instance_disabled',
      message: 'Microsoft 365 tools are turned off on this Breeze instance. A Breeze platform administrator can enable them.',
    });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
  });

  it('names the per-org allowlist when the org is not enabled (#9319)', async () => {
    runtimeMocks.enabled.mockReturnValue(false);
    runtimeMocks.disabledReason = 'org_not_enabled';
    try {
      const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);
      expect(result).toEqual({
        ok: false,
        code: 'tools_disabled',
        reason: 'org_not_enabled',
        message: 'Microsoft 365 tools are not enabled for this organization yet. Ask your Breeze administrator to enable them.',
      });
      const byOrg = await executeM365ReadActionByOrg(ORG_ID, ORG_GET_ACTION);
      expect(byOrg).toMatchObject({ ok: false, code: 'tools_disabled', reason: 'org_not_enabled' });
      expect(dbMocks.selectSpy).not.toHaveBeenCalled();
    } finally {
      runtimeMocks.disabledReason = 'instance_disabled';
    }
  });

  it('flag on + org allowlisted + no connection → connection_not_ready with the Connect next step (#9319)', async () => {
    dbMocks.selectResults.push([]);
    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);
    expect(result).toMatchObject({
      ok: false,
      code: 'connection_not_ready',
      message: expect.stringContaining('Connect Microsoft 365 in Integrations'),
    });
  });

  it.each([
    ['missing connection', undefined],
    ['pending-consent', connectionRow({ status: 'pending-consent' })],
    ['revoked', connectionRow({ status: 'revoked' })],
    ['null tenantId', connectionRow({ tenantId: null })],
  ])('returns connection_not_ready for %s', async (_label, row) => {
    dbMocks.selectResults.push(row ? [row] : []);

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('connection_not_ready');
      expect(result.message.length).toBeGreaterThan(0);
    }
    expect(executorMocks.createClient).not.toHaveBeenCalled();
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('proceeds past the connection check when status is degraded', async () => {
    dbMocks.selectResults.push([connectionRow({ status: 'degraded' })]);
    executorMocks.executeReadAction.mockResolvedValue({
      success: true, kind: 'collection', items: [{ id: 'x' }], truncated: false,
    });

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toEqual({ ok: true, kind: 'collection', items: [{ id: 'x' }], truncated: false });
  });

  it('surfaces read_rate_limited with retryAfterSeconds on budget denial, without touching the executor', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    budgetMocks.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toMatchObject({ ok: false, code: 'read_rate_limited', retryAfterSeconds: 42 });
    expect(executorMocks.createClient).not.toHaveBeenCalled();
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('returns collection items on the executor happy path and audits itemCount without payload keys', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({
      success: true, kind: 'collection', items: [{ id: 'a' }, { id: 'b' }], truncated: true,
    });

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toEqual({ ok: true, kind: 'collection', items: [{ id: 'a' }, { id: 'b' }], truncated: true });
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    const [, event] = auditMocks.writeAuditEvent.mock.calls[0]!;
    expect(event).toMatchObject({
      orgId: ORG_ID,
      action: 'm365.customer_graph_read.action_executed',
      resourceType: 'm365_connection',
      resourceId: CONNECTION_ID,
      result: 'success',
      actorType: 'user',
      actorId: ACTOR_ID,
      details: { actionType: 'm365.org.get', outcome: 'ok', itemCount: 2, truncated: true },
    });
    expect(Object.keys(event.details)).not.toContain('items');
    expect(JSON.stringify(event)).not.toContain('"a"');
    expect(JSON.stringify(event)).not.toContain('"b"');
  });

  it('threads a provided auditRequest through to writeAuditEvent instead of the empty snapshot', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({
      success: true, kind: 'collection', items: [{ id: 'a' }], truncated: false,
    });
    const providedRequest: RequestLike = {
      req: { header: (name: string) => (name === 'x-test' ? 'present' : undefined) },
    };

    await executeM365ReadAction(auth(), ORG_GET_ACTION, undefined, providedRequest);

    expect(auditMocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    const [requestArg] = auditMocks.writeAuditEvent.mock.calls[0]!;
    expect(requestArg).toBe(providedRequest);
  });

  it('returns a single resource on the executor resource happy path', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({
      success: true, kind: 'resource', resource: { id: 'org-1' },
    });

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toEqual({ ok: true, kind: 'resource', resource: { id: 'org-1' } });
    const [, event] = auditMocks.writeAuditEvent.mock.calls[0]!;
    expect(event.details).toMatchObject({ outcome: 'ok', itemCount: 1, truncated: false });
    expect(Object.keys(event.details)).not.toContain('resource');
  });

  it('maps graph_permission_missing to a fixed failure message and audits result failure', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({
      success: false, errorCode: 'graph_permission_missing',
    });

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toEqual({
      ok: false,
      code: 'graph_permission_missing',
      message: 'This action requires Microsoft Graph permissions Breeze does not have — run Retest on the Microsoft 365 card.',
      retryAfterSeconds: undefined,
    });
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    const [, event] = auditMocks.writeAuditEvent.mock.calls[0]!;
    expect(event).toMatchObject({
      result: 'failure',
      details: { outcome: 'graph_permission_missing', itemCount: 0, truncated: false },
    });
  });

  it('maps graph_license_required to its fixed sentence and surfaces retryAfterSeconds when present', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({
      success: false, errorCode: 'graph_license_required', retryAfterSeconds: 30,
    });

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toEqual({
      ok: false,
      code: 'graph_license_required',
      message: 'This tenant does not include Entra ID P1/P2, which Microsoft requires for sign-in logs.',
      retryAfterSeconds: 30,
    });
  });

  it('maps a GraphReadExecutorClientError to executor_unavailable and audits the attempt', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockRejectedValue(new GraphReadExecutorClientError({ cause: 'network', operation: 'read-action' }));

    const result = await executeM365ReadAction(auth(), ORG_GET_ACTION);

    expect(result).toEqual({
      ok: false,
      code: 'executor_unavailable',
      message: 'Microsoft 365 Graph read is temporarily unavailable. Try again shortly.',
    });
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    const [, event] = auditMocks.writeAuditEvent.mock.calls[0]!;
    expect(event).toMatchObject({
      result: 'failure',
      details: { outcome: 'executor_unavailable', itemCount: 0, truncated: false },
    });
  });

  it('rethrows unexpected non-executor errors instead of swallowing them', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    const boom = new Error('unexpected');
    executorMocks.executeReadAction.mockRejectedValue(boom);

    await expect(executeM365ReadAction(auth(), ORG_GET_ACTION)).rejects.toThrow('unexpected');
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe('executeM365MailboxReadByOrg (#6354 W03)', () => {
  const OID = '77777777-7777-4777-8777-777777777777';
  const subject = { entraTenantId: TENANT_ID, entraOid: OID };
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    runtimeMocks.enabled.mockReturnValue(true);
    runtimeMocks.loadConfig.mockReturnValue(RUNTIME_CONFIG);
    budgetMocks.consume.mockResolvedValue({ allowed: true });
    executorMocks.createClient.mockReturnValue({ executeReadAction: executorMocks.executeReadAction });
  });

  it('pins tenant and object id in the executor envelope and audits the actor', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({ success: true, kind: 'resource', resource: { id: OID, proxyAddresses: [] } });
    const result = await executeM365MailboxReadByOrg(ORG_ID, subject, ACTOR_ID);
    expect(result).toEqual({ ok: true, kind: 'resource', resource: { id: OID, proxyAddresses: [] } });
    expect(executorMocks.executeReadAction).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID, action: { type: 'm365.user.mailboxes', userId: OID },
    }));
    // The connection read runs in its own short system scope, never the caller's.
    expect(contextMocks.system).toHaveBeenCalledWith('callerVerification.mailboxes.readConnection');
    expect(contextMocks.withCaller).not.toHaveBeenCalled();
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a tenant mismatch', () => dbMocks.selectResults.push([connectionRow({ tenantId: '99999999-9999-4999-8999-999999999999' })]), 'tenant_mismatch'],
    ['an exhausted budget', () => { dbMocks.selectResults.push([connectionRow()]); budgetMocks.consume.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 }); }, 'read_rate_limited'],
    ['disabled tools', () => { runtimeMocks.enabled.mockReturnValue(false); }, 'tools_disabled'],
    ['a missing connection', () => dbMocks.selectResults.push([]), 'connection_not_ready'],
    ['a revoked connection', () => dbMocks.selectResults.push([connectionRow({ status: 'revoked' })]), 'connection_not_ready'],
  ])('%s makes zero executor calls', async (_label, arrange, code) => {
    arrange();
    const result = await executeM365MailboxReadByOrg(ORG_ID, subject, ACTOR_ID);
    expect(result).toMatchObject({ ok: false, code });
    expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
  });

  it('refuses a non-GUID object id before any DB access', async () => {
    const result = await executeM365MailboxReadByOrg(ORG_ID, { ...subject, entraOid: 'alex@example.com' }, ACTOR_ID);
    expect(result).toMatchObject({ ok: false });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
    expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
  });
});

describe('executeM365ReadActionByOrg (effect-probe entry, #6170)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    runtimeMocks.enabled.mockReturnValue(true);
    runtimeMocks.loadConfig.mockReturnValue(RUNTIME_CONFIG);
    budgetMocks.consume.mockResolvedValue({ allowed: true });
    executorMocks.createClient.mockReturnValue({ executeReadAction: executorMocks.executeReadAction });
  });

  it('refuses tools_disabled when the org flag is off, without touching the database', async () => {
    runtimeMocks.enabled.mockReturnValue(false);
    const result = await executeM365ReadActionByOrg(ORG_ID, ORG_GET_ACTION);
    expect(result).toMatchObject({ ok: false, code: 'tools_disabled' });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
    expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
  });

  it('refuses a whole-tenant sync action id with tools_disabled', async () => {
    const result = await executeM365ReadActionByOrg(ORG_ID, { type: 'm365.sync.users' } as unknown as Parameters<typeof executeM365ReadActionByOrg>[1]);
    expect(result).toMatchObject({ ok: false, code: 'tools_disabled' });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
  });

  it('refuses connection_not_ready when no customer-graph-read row exists', async () => {
    dbMocks.selectResults.push([]);
    const result = await executeM365ReadActionByOrg(ORG_ID, ORG_GET_ACTION);
    expect(result).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
  });

  it('refuses a row for another org (defense-in-depth over RLS)', async () => {
    dbMocks.selectResults.push([connectionRow({ orgId: '99999999-9999-4999-8999-999999999999' })]);
    const result = await executeM365ReadActionByOrg(ORG_ID, ORG_GET_ACTION);
    expect(result).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
  });

  it('loads the connection under the AMBIENT context: opens neither a caller nor a system context', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({ success: true, kind: 'resource', resource: { id: 'org-1' } });
    const result = await executeM365ReadActionByOrg(ORG_ID, ORG_GET_ACTION, { actorId: ACTOR_ID });
    expect(result).toMatchObject({ ok: true });
    expect(contextMocks.withCaller).not.toHaveBeenCalled();
    expect(contextMocks.system).not.toHaveBeenCalled();
    expect(dbMocks.selectSpy).toHaveBeenCalledTimes(1);
  });

  it('calls the read executor on a ready connection and audits the passed actor', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({ success: true, kind: 'resource', resource: { id: 'org-1' } });
    await executeM365ReadActionByOrg(ORG_ID, ORG_GET_ACTION, { actorId: ACTOR_ID });
    expect(executorMocks.executeReadAction).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID, action: ORG_GET_ACTION,
    }));
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId: ACTOR_ID }),
    );
  });
});

describe('executeM365UserLookupForCallerTarget (#6354 W05)', () => {
  const OID = '77777777-7777-4777-8777-777777777777';
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    runtimeMocks.enabled.mockReturnValue(true);
    runtimeMocks.loadConfig.mockReturnValue(RUNTIME_CONFIG);
    budgetMocks.consume.mockResolvedValue({ allowed: true });
    executorMocks.createClient.mockReturnValue({ executeReadAction: executorMocks.executeReadAction });
  });

  it('looks the identifier up on the pinned-tenant connection (tenant compared case-insensitively) and audits the actor', async () => {
    dbMocks.selectResults.push([connectionRow()]);
    executorMocks.executeReadAction.mockResolvedValue({ success: true, kind: 'resource', resource: { id: OID } });
    const result = await executeM365UserLookupForCallerTarget(ORG_ID, 'alex@example.com', TENANT_ID.toUpperCase(), ACTOR_ID);
    expect(result).toMatchObject({ ok: true });
    expect(executorMocks.executeReadAction).toHaveBeenCalledTimes(1);
    expect(executorMocks.executeReadAction).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID, action: { type: 'm365.user.get', userIdOrUpn: 'alex@example.com' },
    }));
    expect(contextMocks.system).not.toHaveBeenCalled();
    expect(contextMocks.withCaller).not.toHaveBeenCalled();
  });

  it('a tenant mismatch makes zero executor calls', async () => {
    dbMocks.selectResults.push([connectionRow({ tenantId: '99999999-9999-4999-8999-999999999999' })]);
    const result = await executeM365UserLookupForCallerTarget(ORG_ID, OID, TENANT_ID, ACTOR_ID);
    expect(result).toMatchObject({ ok: false, code: 'tenant_mismatch' });
    expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
    expect(budgetMocks.consume).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid identifier', () => {}, 'not a user!!', 'invalid_subject', false],
    ['disabled tools', () => { runtimeMocks.enabled.mockReturnValue(false); }, OID, 'tools_disabled', false],
    ['a missing connection', () => dbMocks.selectResults.push([]), OID, 'connection_not_ready', true],
    ['a revoked connection', () => dbMocks.selectResults.push([connectionRow({ status: 'revoked' })]), OID, 'connection_not_ready', true],
    ['another org\'s row', () => dbMocks.selectResults.push([connectionRow({ orgId: 'other-org' })]), OID, 'connection_not_ready', true],
  ])('%s makes zero executor calls', async (_label, arrange, identifier, code, _db) => {
    arrange();
    const result = await executeM365UserLookupForCallerTarget(ORG_ID, identifier as string, TENANT_ID, ACTOR_ID);
    expect(result).toMatchObject({ ok: false, code });
    expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
  });

  it('refuses an invalid identifier before any DB access', async () => {
    await executeM365UserLookupForCallerTarget(ORG_ID, '', TENANT_ID, ACTOR_ID);
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
  });
});
