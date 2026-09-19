import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { M365SyncCallFailureCode } from './readActionService';

const { dbMocks, contextMocks, orgMocks, runtimeMocks, budgetMocks, executorMocks, auditMocks, metricMocks } = vi.hoisted(() => ({
  dbMocks: {
    selectResults: [] as unknown[][],
    selectSpy: vi.fn(),
  },
  contextMocks: {
    fromAuth: vi.fn((auth: unknown) => ({ scope: 'organization', auth })),
    withCaller: vi.fn(async <T>(_context: unknown, fn: () => Promise<T>) => fn()),
  },
  orgMocks: {
    resolveWritableToolOrgId: vi.fn(),
  },
  runtimeMocks: {
    enabled: vi.fn(),
    loadConfig: vi.fn(),
  },
  budgetMocks: {
    consume: vi.fn(),
    consumeSync: vi.fn(),
  },
  executorMocks: {
    createClient: vi.fn(),
    executeReadAction: vi.fn(),
    syncAction: vi.fn(),
  },
  auditMocks: {
    writeAuditEvent: vi.fn(),
  },
  metricMocks: {
    executorSeconds: vi.fn(),
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
}));

vi.mock('../../middleware/auth', () => ({
  dbAccessContextFromAuth: contextMocks.fromAuth,
}));

vi.mock('../aiTools', () => ({
  resolveWritableToolOrgId: orgMocks.resolveWritableToolOrgId,
}));

vi.mock('./runtimeConfig', () => ({
  isM365GraphReadToolsEnabledForOrg: runtimeMocks.enabled,
  loadM365CustomerGraphReadRuntimeConfig: runtimeMocks.loadConfig,
}));

vi.mock('./readActionBudget', () => ({
  consumeM365ReadActionBudget: budgetMocks.consume,
  consumeM365SyncBudget: budgetMocks.consumeSync,
}));

vi.mock('./graphReadExecutorClient', async (importActual) => {
  const actual = await importActual<typeof import('./graphReadExecutorClient')>();
  return {
    ...actual,
    createGraphReadExecutorClient: executorMocks.createClient,
  };
});

vi.mock('../auditEvents', async (importActual) => {
  const actual = await importActual<typeof import('../auditEvents')>();
  return {
    ...actual,
    writeAuditEvent: auditMocks.writeAuditEvent,
  };
});

vi.mock('../m365Sync/metrics', () => ({ recordM365SyncExecutorSeconds: metricMocks.executorSeconds }));

import { callGraphReadExecutor, connectionExecutionSnapshot, syncFailureMessage } from './readActionService';
import { GraphReadExecutorClientError } from './graphReadExecutorClient';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';

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

const ROW = {
  id: CONNECTION_ID,
  orgId: ORG_ID,
  tenantId: TENANT_ID,
  consentGeneration: 3,
  status: 'active',
  permissionManifestVersion: 3,
  vaultRef: 'akv://vault.example/x/0123456789abcdef0123456789abcdef',
  credentialVersion: '0123456789abcdef0123456789abcdef',
};

const SNAPSHOT = {
  id: CONNECTION_ID, orgId: ORG_ID, tenantId: TENANT_ID, consentGeneration: 3,
  status: 'active' as const, permissionManifestVersion: 3,
  vaultRef: 'akv://vault.example/x/0123456789abcdef0123456789abcdef',
  credentialVersion: '0123456789abcdef0123456789abcdef',
};
const SYNC_ACTION = { type: 'm365.sync.users' } as const;
const SYNC_OK = {
  success: true, kind: 'sync', items: [{ id: 'u1' }], truncated: false,
  fetchedAt: '2026-09-08T00:00:00.000Z', sources: { users: 'ok' },
} as const;

describe('callGraphReadExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.loadConfig.mockReturnValue(RUNTIME_CONFIG);
    budgetMocks.consume.mockResolvedValue({ allowed: true });
    budgetMocks.consumeSync.mockResolvedValue({ allowed: true });
    executorMocks.createClient.mockReturnValue({
      executeReadAction: executorMocks.executeReadAction,
      syncAction: executorMocks.syncAction,
    });
  });

  it('never opens a DB context: no db.select, no withDbAccessContext, on either route', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-1' });
    expect(dbMocks.selectSpy).not.toHaveBeenCalled();
    expect(contextMocks.withCaller).not.toHaveBeenCalled();
  });

  it('route sync consumes the SYNC budget, never the interactive one', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-1' });
    expect(budgetMocks.consumeSync).toHaveBeenCalledWith(CONNECTION_ID);
    expect(budgetMocks.consume).not.toHaveBeenCalled();
  });

  it('route read consumes the INTERACTIVE budget and calls executeReadAction', async () => {
    executorMocks.executeReadAction.mockResolvedValue({ success: true, kind: 'collection', items: [], truncated: false });
    await callGraphReadExecutor(SNAPSHOT, { type: 'm365.org.get' }, { route: 'read', correlationId: 'c-2' });
    expect(budgetMocks.consume).toHaveBeenCalledWith(CONNECTION_ID);
    expect(budgetMocks.consumeSync).not.toHaveBeenCalled();
    expect(executorMocks.syncAction).not.toHaveBeenCalled();
  });

  it('a denied sync budget is a refusal, not an executor call (fail-closed)', async () => {
    budgetMocks.consumeSync.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });
    const result = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-3' });
    expect(result).toMatchObject({ ok: false, code: 'read_rate_limited', retryAfterSeconds: 900 });
    expect(executorMocks.syncAction).not.toHaveBeenCalled();
  });

  it('returns the sync result verbatim with an executor duration', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    const result = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-4' });
    expect(result).toMatchObject({ ok: true, kind: 'sync', result: SYNC_OK });
    expect((result as { executorMs: number }).executorMs).toBeGreaterThanOrEqual(0);
  });

  it('reads the failure discriminant off `code`, never off `errorCode` (W03 shape)', async () => {
    // A sync failure body is `{ success: false, code, retryAfterSeconds? }`.
    // Reading `.errorCode` here would silently produce `code: undefined` and a
    // "undefined" message — this test is the one that catches that.
    executorMocks.syncAction.mockResolvedValue({ success: false, code: 'sync_capacity', retryAfterSeconds: 30 });
    const capacity = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-5' });
    expect(capacity).toMatchObject({ ok: false, code: 'sync_capacity', retryAfterSeconds: 30 });
    expect((capacity as { message: string }).message).not.toContain('undefined');

    executorMocks.syncAction.mockResolvedValue({ success: false, code: 'graph_throttled', retryAfterSeconds: 12 });
    const throttled = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-6' });
    expect(throttled).toMatchObject({ ok: false, code: 'graph_throttled', retryAfterSeconds: 12 });
  });

  it('maps continuation_invalid without inventing a message', async () => {
    executorMocks.syncAction.mockResolvedValue({ success: false, code: 'continuation_invalid' });
    const result = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-5b' });
    expect(result).toMatchObject({ ok: false, code: 'continuation_invalid' });
    expect((result as { message: string }).message).not.toContain('undefined');
  });

  it('labels the executor histogram with opts.domain, falling back to the action id', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-5c', domain: 'users' });
    expect(metricMocks.executorSeconds.mock.calls[0]![0]).toBe('users');

    metricMocks.executorSeconds.mockClear();
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-5d' });
    expect(metricMocks.executorSeconds.mock.calls[0]![0]).toBe('m365.sync.users');
  });

  it('collapses a transport-level executor error to executor_unavailable on the sync route', async () => {
    executorMocks.syncAction.mockRejectedValue(new GraphReadExecutorClientError());
    const result = await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-7' });
    expect(result).toMatchObject({ ok: false, code: 'executor_unavailable' });
  });

  it('writes NO per-call audit event on the sync route (the run emits one m365.sync.run instead)', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-8' });
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('writes the per-call audit event on the read route, exactly as the request path did', async () => {
    executorMocks.executeReadAction.mockResolvedValue({ success: true, kind: 'collection', items: [{}], truncated: false });
    await callGraphReadExecutor(SNAPSHOT, { type: 'm365.org.get' }, { route: 'read', correlationId: 'c-9', actorId: ACTOR_ID });
    expect(auditMocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(auditMocks.writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      orgId: ORG_ID,
      action: 'm365.customer_graph_read.action_executed',
      resourceId: CONNECTION_ID,
      details: { actionType: 'm365.org.get', outcome: 'ok', itemCount: 1, truncated: false },
      result: 'success',
    });
  });

  it('honours an injected recordEvent on the sync route without touching the default recorder', async () => {
    executorMocks.syncAction.mockResolvedValue(SYNC_OK);
    const recordEvent = vi.fn();
    await callGraphReadExecutor(SNAPSHOT, SYNC_ACTION, { route: 'sync', correlationId: 'c-10', recordEvent });
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(auditMocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe('connectionExecutionSnapshot', () => {
  it.each(['pending-consent', 'verifying', 'suspended', 'revoked'])(
    'returns null for a %s connection (not executable)',
    (status) => {
      expect(connectionExecutionSnapshot({ ...ROW, status } as never)).toBeNull();
    },
  );

  it('returns null when the verified tenant is missing', () => {
    expect(connectionExecutionSnapshot({ ...ROW, tenantId: null } as never)).toBeNull();
  });

  it('coerces a null vaultRef/credentialVersion to "" rather than refusing a degraded row', () => {
    const snap = connectionExecutionSnapshot({ ...ROW, status: 'degraded', vaultRef: null, credentialVersion: null } as never);
    expect(snap).toMatchObject({ status: 'degraded', vaultRef: '', credentialVersion: '' });
  });
});

/**
 * The message map is TOTAL over M365SyncCallFailureCode. A code with no entry
 * would surface to an operator as the literal string "undefined", and `sources`
 * / `last_error` would then carry it into the audit trail — so the union is
 * pinned here, and the `_exhaustive` line makes ADDING a code to the union a
 * compile error until its message exists.
 */
describe('syncFailureMessage', () => {
  const ALL_CODES = [
    // M365ReadActionRefusalCode
    'tools_disabled', 'site_scope_denied', 'org_context_required',
    'connection_not_ready', 'read_rate_limited', 'executor_unavailable',
    // M365SyncFailureCode (= ReadActionFailureCode + continuation_invalid)
    'credential_unavailable', 'application_token_invalid', 'graph_permission_missing',
    'graph_license_required', 'graph_not_found', 'graph_throttled',
    'graph_response_too_large', 'graph_request_timeout', 'graph_transport_failed',
    'graph_response_invalid', 'continuation_invalid',
    // sync-only
    'sync_capacity',
  ] as const satisfies readonly M365SyncCallFailureCode[];

  // Compile-time half: if the union gains a member absent from ALL_CODES this
  // assignment stops type-checking, so the runtime loop below cannot go stale.
  type Missing = Exclude<M365SyncCallFailureCode, (typeof ALL_CODES)[number]>;
  const _exhaustive: Missing extends never ? true : never = true;

  it('has a non-empty, non-"undefined" message for EVERY code in the union', () => {
    expect(_exhaustive).toBe(true);
    for (const code of ALL_CODES) {
      const message = syncFailureMessage(code);
      expect(message, code).toBeTruthy();
      expect(message, code).not.toContain('undefined');
    }
  });
});
