import { beforeEach, describe, expect, it, vi } from 'vitest';
import { M365_PERMISSION_PROFILES, type CompleteConsentResult, type RetestRequest, type RetestResult } from '@breeze/shared/m365';

const { dbMocks, contextMocks, consentMocks, columns } = vi.hoisted(() => ({
  dbMocks: {
    selectResults: [] as unknown[][],
    updateResults: [] as Array<unknown[] | ((set: Record<string, unknown>) => unknown[])>,
    insertResults: [] as Array<unknown[] | ((values: Record<string, unknown>) => unknown[])>,
    updateSets: [] as Record<string, unknown>[],
    updateWheres: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    executed: [] as unknown[],
    order: [] as string[],
  },
  contextMocks: {
    callerDepth: 0,
    serializeSystem: false,
    systemTail: Promise.resolve() as Promise<void>,
    runOutside: vi.fn(<T>(fn: () => T) => fn()),
    withSystem: vi.fn(async <T>(fn: () => Promise<T>) => {
      if (!contextMocks.serializeSystem) return fn();
      const previous = contextMocks.systemTail;
      let release!: () => void;
      contextMocks.systemTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await fn(); } finally { release(); }
    }),
    withCaller: vi.fn(async <T>(_context: unknown, fn: () => Promise<T>) => {
      contextMocks.callerDepth += 1;
      try { return await fn(); } finally { contextMocks.callerDepth -= 1; }
    }),
    fromAuth: vi.fn(() => ({ scope: 'organization', orgId: '22222222-2222-4222-8222-222222222222' })),
  },
  consentMocks: {
    validStates: new Set<string>(),
    stateCounter: 0,
    deleteAttempt: vi.fn(async () => {
      dbMocks.order.push('delete-session');
      consentMocks.validStates.clear();
    }),
    createAdmin: vi.fn(async () => {
      dbMocks.order.push('insert-session');
      consentMocks.stateCounter += 1;
      const rawState = consentMocks.stateCounter === 1 ? 'raw-state' : `raw-state-${consentMocks.stateCounter}`;
      consentMocks.validStates.add(rawState);
      return { rawState, session: {} };
    }),
    consumeAdmin: vi.fn(async (input: { rawState: string }) => {
      dbMocks.order.push('consume-admin-session');
      if (!consentMocks.validStates.delete(input.rawState)) return null;
      // Mirrors the column default: every stored session carries a purpose.
      return { userId: '66666666-6666-4666-8666-666666666666', purpose: 'initial' };
    }),
    deleteForConnection: vi.fn(async () => {
      dbMocks.order.push('delete-session-by-connection');
      consentMocks.validStates.clear();
    }),
    insertIdentity: vi.fn(async (_owner: unknown, prepared: Record<string, unknown>) => {
      dbMocks.order.push('insert-identity-session');
      return { rawState: prepared.rawState, codeChallenge: prepared.codeChallenge, session: {} };
    }),
  },
  columns: {
    id: { name: 'id' }, orgId: { name: 'org_id' }, tenantId: { name: 'tenant_id' },
    clientId: { name: 'client_id' }, profile: { name: 'profile' },
    consentAttemptId: { name: 'consent_attempt_id' }, status: { name: 'status' },
    consentGeneration: { name: 'consent_generation' },
    permissionManifestVersion: { name: 'permission_manifest_version' },
  },
}));

function selectable(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const limited = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    for: vi.fn(async () => rows),
  };
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    limit: vi.fn(() => limited),
    for: vi.fn(async () => rows),
  };
}

vi.mock('../../db/schema', () => ({ m365Connections: columns }));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
    eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
    inArray: vi.fn((column: unknown, value: unknown) => ({ op: 'inArray', column, value })),
    isNull: vi.fn((column: unknown) => ({ op: 'isNull', column })),
    or: vi.fn((...conditions: unknown[]) => ({ op: 'or', conditions })),
    sql: vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => ({
      op: 'sql', strings: [...strings], params,
    })),
  };
});

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      dbMocks.executed.push(query);
      dbMocks.order.push('lock');
      return [];
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => selectable(dbMocks.selectResults.shift() ?? [])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((set: Record<string, unknown>) => {
        dbMocks.updateSets.push(set);
        dbMocks.order.push('update');
        return {
          where: vi.fn((where: unknown) => {
            dbMocks.updateWheres.push(where);
            return {
              returning: vi.fn(async () => {
                const result = dbMocks.updateResults.shift() ?? [];
                return typeof result === 'function' ? result(set) : result;
              }),
            };
          }),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        dbMocks.insertedValues.push(values);
        dbMocks.order.push('insert-connection');
        return {
          returning: vi.fn(async () => {
            const result = dbMocks.insertResults.shift() ?? [];
            return typeof result === 'function' ? result(values) : result;
          }),
        };
      }),
    })),
  },
  runOutsideDbContext: contextMocks.runOutside,
  withSystemDbAccessContext: contextMocks.withSystem,
  withDbAccessContext: contextMocks.withCaller,
}));

vi.mock('../../middleware/auth', () => ({
  dbAccessContextFromAuth: contextMocks.fromAuth,
}));

vi.mock('./consentSessionService', () => ({
  deleteConsentSessionsForAttemptInTransaction: consentMocks.deleteAttempt,
  deleteConsentSessionsForConnection: consentMocks.deleteForConnection,
  createAdminConsentSessionInTransaction: consentMocks.createAdmin,
  consumeConsentSessionInTransaction: consentMocks.consumeAdmin,
  insertPreparedIdentityVerificationSessionInTransaction: consentMocks.insertIdentity,
}));

vi.mock('./runtimeConfig', () => ({
  loadM365CustomerGraphReadRuntimeConfig: vi.fn(() => ({
    clientId: '55555555-5555-4555-8555-555555555555',
    vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
    credentialVersion: '0123456789abcdef0123456789abcdef',
    callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-read-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'key-1',
    onboardingOrgIds: '*',
  })),
}));

import {
  ConnectionLifecycleError,
  applyIdentityVerificationResult,
  applyUpgradeVerificationResult,
  transitionUpgradeConsentToIdentity,
  applyRetestResult,
  createConnectionService,
  deriveGrantHealth,
  disconnectCustomerGraphReadConnection,
  initiateCustomerGraphReadConsent,
  initiateCustomerGraphReadUpgradeConsent,
  loadRetestSnapshot,
  markAdminConsentReturned,
  transitionAdminConsentToIdentity,
  retestCustomerGraphReadConnection,
  type ConsentAttemptSnapshot,
  type CustomerGraphReadConnectionSnapshot,
  type RetestSnapshot,
} from './connectionService';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const CLIENT_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';
const REQUIRED = M365_PERMISSION_PROFILES['customer-graph-read'].applicationPermissionAssignments;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    userId: null,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    clientSecret: null,
    profile: 'customer-graph-read' as const,
    authMode: 'application-certificate' as const,
    credentialDomain: 'customer-graph-read' as const,
    vaultRef: 'akv://vault/version',
    credentialVersion: 'version',
    permissionManifestVersion: 3,
    observedGrants: [...REQUIRED],
    consentAttemptId: ATTEMPT_ID,
    grantsVerifiedAt: new Date('2026-07-14T16:00:00.000Z'),
    displayName: 'Contoso',
    status: 'active' as const,
    consentedAt: new Date('2026-07-14T15:00:00.000Z'),
    lastVerifiedAt: new Date('2026-07-14T16:00:00.000Z'),
    expiresAt: null,
    revokedAt: null,
    lastErrorCode: null,
    createdBy: ACTOR_ID,
    createdAt: new Date('2026-07-14T15:00:00.000Z'),
    updatedAt: new Date('2026-07-14T16:00:00.000Z'),
    ...overrides,
  };
}

function snapshot(overrides: Partial<CustomerGraphReadConnectionSnapshot> = {}): CustomerGraphReadConnectionSnapshot {
  return {
    id: CONNECTION_ID, orgId: ORG_ID, profile: 'customer-graph-read',
    consentAttemptId: ATTEMPT_ID, tenantId: TENANT_ID, clientId: CLIENT_ID,
    permissionManifestVersion: 3, observedGrants: [...REQUIRED],
    grantsVerifiedAt: new Date('2026-07-14T16:00:00.000Z'), displayName: 'Contoso',
    status: 'active', lastVerifiedAt: new Date('2026-07-14T16:00:00.000Z'),
    lastErrorCode: null, ...overrides,
  };
}

function attempt(status: ConsentAttemptSnapshot['status'] = 'verifying'): ConsentAttemptSnapshot {
  return { id: CONNECTION_ID, orgId: ORG_ID, profile: 'customer-graph-read', consentAttemptId: ATTEMPT_ID, status };
}

function completeResult(overrides: Partial<Extract<CompleteConsentResult, { success: true }>> = {}): CompleteConsentResult {
  return {
    success: true, tenantId: TENANT_ID, applicationId: CLIENT_ID,
    administratorObjectId: '77777777-7777-4777-8777-777777777777',
    organizationDisplayName: 'Contoso', manifestVersion: 3,
    verifiedAt: '2026-07-14T16:00:00.000Z', grantReconciliation: 'complete',
    observedGrants: [...REQUIRED], missingGrants: [], unexpectedGrants: [],
    grantsVerifiedAt: '2026-07-14T16:00:00.000Z', ...overrides,
  } as CompleteConsentResult;
}

function auth() {
  return { scope: 'organization', orgId: ORG_ID, accessibleOrgIds: [ORG_ID], partnerId: null, user: { id: ACTOR_ID } } as never;
}

describe('customer Graph-read connection lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    dbMocks.updateResults.length = 0;
    dbMocks.insertResults.length = 0;
    dbMocks.updateSets.length = 0;
    dbMocks.updateWheres.length = 0;
    dbMocks.insertedValues.length = 0;
    dbMocks.executed.length = 0;
    dbMocks.order.length = 0;
    contextMocks.callerDepth = 0;
    contextMocks.serializeSystem = false;
    contextMocks.systemTail = Promise.resolve();
    consentMocks.validStates.clear();
    consentMocks.stateCounter = 0;
  });

  it('derives active/degraded/missing/unexpected/both/manifest-stale health', () => {
    const manifest = M365_PERMISSION_PROFILES['customer-graph-read'];
    expect(deriveGrantHealth(snapshot(), manifest)).toMatchObject({ state: 'active', missingGrants: [], unexpectedGrants: [] });
    expect(deriveGrantHealth(snapshot({ observedGrants: REQUIRED.slice(1), status: 'degraded' }), manifest)).toMatchObject({ state: 'missing', missingGrants: [REQUIRED[0]] });
    const unexpected = { resourceApplicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appRoleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', value: 'Too.Much' };
    expect(deriveGrantHealth(snapshot({ observedGrants: [...REQUIRED, unexpected], status: 'degraded' }), manifest)).toMatchObject({ state: 'unexpected', unexpectedGrants: [unexpected] });
    expect(deriveGrantHealth(snapshot({ observedGrants: [unexpected], status: 'degraded' }), manifest).state).toBe('both');
    expect(deriveGrantHealth(snapshot({ permissionManifestVersion: 1, status: 'degraded' }), manifest).state).toBe('manifest-stale');
    expect(deriveGrantHealth(snapshot({ grantsVerifiedAt: null, observedGrants: [], status: 'degraded' }), manifest).state).toBe('degraded');
  });

  it('does not claim definitive drift before the first authoritative grant observation', () => {
    const manifest = M365_PERMISSION_PROFILES['customer-graph-read'];
    const unknown = deriveGrantHealth(snapshot({
      grantsVerifiedAt: null,
      observedGrants: [],
      status: 'degraded',
      lastErrorCode: 'grant_reconciliation_unavailable',
    }), manifest);
    expect(unknown).toMatchObject({
      state: 'degraded',
      missingGrants: [],
      unexpectedGrants: [],
    });

    const retained = deriveGrantHealth(snapshot({
      grantsVerifiedAt: new Date('2026-07-14T16:00:00.000Z'),
      observedGrants: REQUIRED.slice(1),
      status: 'degraded',
      lastErrorCode: 'grant_reconciliation_unavailable',
    }), manifest);
    expect(retained.missingGrants).toEqual([REQUIRED[0]]);
  });

  it('initiates in one system transaction, deleting the old session before attempt rotation and inserting the new session last', async () => {
    dbMocks.selectResults.push([row({ status: 'degraded' })]);
    dbMocks.updateResults.push((set) => [row({ ...set })]);

    const result = await initiateCustomerGraphReadConsent({ orgId: ORG_ID, actorId: ACTOR_ID });

    expect(result.rawState).toBe('raw-state');
    expect(result.consentUrl).toContain('https://login.microsoftonline.com/common/adminconsent?');
    expect(dbMocks.order).toEqual(['lock', 'delete-session', 'update', 'insert-session']);
    expect(contextMocks.runOutside).toHaveBeenCalledOnce();
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'pending-consent', clientId: CLIENT_ID });
  });

  it.each(['delete-session', 'update', 'insert-session'])('propagates a %s write failure so the system transaction rolls back', async (step) => {
    dbMocks.selectResults.push([row({ status: 'degraded' })]);
    dbMocks.updateResults.push((set) => [row({ ...set })]);
    if (step === 'delete-session') consentMocks.deleteAttempt.mockRejectedValueOnce(new Error('write failed'));
    if (step === 'update') dbMocks.updateResults[0] = () => { throw new Error('write failed'); };
    if (step === 'insert-session') consentMocks.createAdmin.mockRejectedValueOnce(new Error('write failed'));

    await expect(initiateCustomerGraphReadConsent({ orgId: ORG_ID, actorId: ACTOR_ID }))
      .rejects.toThrow('write failed');
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
  });

  it('propagates a first-connection insert failure so no admin session is created', async () => {
    dbMocks.selectResults.push([]);
    dbMocks.insertResults.push(() => { throw new Error('insert failed'); });

    await expect(initiateCustomerGraphReadConsent({ orgId: ORG_ID, actorId: ACTOR_ID }))
      .rejects.toThrow('insert failed');
    expect(dbMocks.insertedValues[0]).toMatchObject({ permissionManifestVersion: 3 });
    expect(consentMocks.createAdmin).not.toHaveBeenCalled();
  });

  it('serializes concurrent initiations so exactly the latest returned state remains usable', async () => {
    contextMocks.serializeSystem = true;
    dbMocks.selectResults.push([row({ status: 'degraded' })], [row({ status: 'pending-consent' })]);
    dbMocks.updateResults.push(
      (set) => [row({ status: 'degraded', ...set })],
      (set) => [row({ status: 'pending-consent', ...set })],
    );

    const [first, second] = await Promise.all([
      initiateCustomerGraphReadConsent({ orgId: ORG_ID, actorId: ACTOR_ID }),
      initiateCustomerGraphReadConsent({ orgId: ORG_ID, actorId: ACTOR_ID }),
    ]);

    expect(first.rawState).not.toBe(second.rawState);
    expect([first.rawState, second.rawState].filter((state) => consentMocks.validStates.has(state)))
      .toEqual([second.rawState]);
    expect(dbMocks.executed).toHaveLength(2);
  });

  it('uses an attempt/status CAS to advance only pending consent to verifying', async () => {
    dbMocks.updateResults.push([row({ status: 'verifying' })]);
    await expect(markAdminConsentReturned(attempt('pending-consent'))).resolves.toMatchObject({ status: 'verifying' });
    expect(dbMocks.updateWheres[0]).toMatchObject({ op: 'and' });
    expect(JSON.stringify(dbMocks.updateWheres[0])).toContain(ATTEMPT_ID);
    expect(JSON.stringify(dbMocks.updateWheres[0])).toContain('pending-consent');
  });

  it('atomically consumes admin state, CAS-transitions, and inserts the prepared identity session', async () => {
    consentMocks.validStates.add('admin-state');
    dbMocks.updateResults.push((set) => [row({ status: 'pending-consent', ...set })]);
    const prepared = {
      rawState: 'identity-state',
      tenantHintHash: 'a'.repeat(64),
      nonce: 'nonce',
      codeVerifier: 'v'.repeat(43),
      codeChallenge: 'challenge',
      expiresAt: new Date('2026-07-14T16:10:00.000Z'),
    };

    await expect(transitionAdminConsentToIdentity({
      attempt: attempt('pending-consent'),
      rawAdminState: 'admin-state',
      prepared,
    })).resolves.toMatchObject({
      connection: { status: 'verifying' },
      identity: { rawState: 'identity-state', codeChallenge: 'challenge' },
      actorId: ACTOR_ID,
    });

    expect(dbMocks.order).toEqual(['consume-admin-session', 'update', 'insert-identity-session']);
    expect(contextMocks.runOutside).toHaveBeenCalledOnce();
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
    expect(consentMocks.insertIdentity).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      userId: ACTOR_ID,
    }), prepared);
  });

  it.each(['consume', 'cas', 'identity-insert'] as const)(
    'propagates %s transition failure through the single rollback transaction',
    async (step) => {
      consentMocks.validStates.add('admin-state');
      if (step === 'consume') consentMocks.consumeAdmin.mockRejectedValueOnce(new Error('consume failed'));
      if (step === 'cas') dbMocks.updateResults.push(() => { throw new Error('cas failed'); });
      else dbMocks.updateResults.push((set) => [row({ status: 'pending-consent', ...set })]);
      if (step === 'identity-insert') {
        consentMocks.insertIdentity.mockRejectedValueOnce(new Error('insert failed'));
      }

      await expect(transitionAdminConsentToIdentity({
        attempt: attempt('pending-consent'),
        rawAdminState: 'admin-state',
        prepared: {
          rawState: 'identity-state', tenantHintHash: 'a'.repeat(64), nonce: 'nonce',
          codeVerifier: 'v'.repeat(43), codeChallenge: 'challenge',
          expiresAt: new Date('2026-07-14T16:10:00.000Z'),
        },
      })).rejects.toThrow();
      expect(contextMocks.withSystem).toHaveBeenCalledOnce();
    },
  );

  it('binds a verified tenant once and computes active only from exact current grants', async () => {
    dbMocks.updateResults.push((set) => [row({ tenantId: null, status: 'verifying', ...set })]);
    await expect(applyIdentityVerificationResult(attempt(), completeResult())).resolves.toMatchObject({ status: 'active', tenantId: TENANT_ID });
    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'active', tenantId: TENANT_ID, observedGrants: REQUIRED, lastErrorCode: null });
    expect(JSON.stringify(dbMocks.updateWheres[0])).toContain('isNull');
    expect(JSON.stringify(dbMocks.updateWheres[0])).toContain(TENANT_ID);
  });

  it('returns a bounded lifecycle snapshot for observability without executor-only proof fields', async () => {
    dbMocks.updateResults.push((set) => [row({ tenantId: null, status: 'verifying', ...set })]);
    const applied = await applyIdentityVerificationResult(attempt(), {
      ...completeResult(),
      administratorObjectId: 'must-not-reach-control-plane-observability',
      accessToken: 'must-not-reach-control-plane-observability',
      idToken: 'must-not-reach-control-plane-observability',
      providerDescription: 'must-not-reach-control-plane-observability',
    } as never);

    const serialized = JSON.stringify(applied);
    expect(applied).toMatchObject({
      orgId: ORG_ID,
      id: CONNECTION_ID,
      profile: 'customer-graph-read',
      consentAttemptId: ATTEMPT_ID,
      tenantId: TENANT_ID,
      permissionManifestVersion: 3,
      status: 'active',
      lastErrorCode: null,
    });
    expect(serialized).not.toContain('must-not-reach-control-plane-observability');
    expect(serialized).not.toMatch(/administratorObjectId|accessToken|idToken|providerDescription/);
  });

  it('refuses binding when executor application proof differs from the fixed profile application', async () => {
    dbMocks.updateResults.push((set) => [row({ tenantId: null, status: 'verifying', ...set })]);
    await expect(applyIdentityVerificationResult(attempt(), completeResult({
      applicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }))).resolves.toMatchObject({ status: 'pending-consent', tenantId: null });
    expect(dbMocks.updateSets[0]).toMatchObject({
      status: 'pending-consent', lastErrorCode: 'application_token_invalid',
    });
    expect(dbMocks.updateSets[0]).not.toHaveProperty('tenantId');
  });

  it('binds trusted proof but stores no observed set/timestamp when first reconciliation is unavailable', async () => {
    dbMocks.updateResults.push((set) => [row({ tenantId: null, observedGrants: [], grantsVerifiedAt: null, status: 'verifying', ...set })]);
    const unavailable = {
      ...completeResult(), grantReconciliation: 'unavailable', errorCode: 'grant_reconciliation_unavailable',
      observedGrants: null, missingGrants: null, unexpectedGrants: null, grantsVerifiedAt: null,
    } as CompleteConsentResult;

    await expect(applyIdentityVerificationResult(attempt(), unavailable)).resolves.toMatchObject({ status: 'degraded', tenantId: TENANT_ID });
    expect(dbMocks.updateSets[0]).not.toHaveProperty('observedGrants');
    expect(dbMocks.updateSets[0]).not.toHaveProperty('grantsVerifiedAt');
    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'degraded', lastErrorCode: 'grant_reconciliation_unavailable' });
  });

  it('returns generic tenant_already_bound for immutable or unique tenant ownership conflicts', async () => {
    dbMocks.updateResults.push([]);
    dbMocks.selectResults.push([{ tenantId: '88888888-8888-4888-8888-888888888888' }]);
    await expect(applyIdentityVerificationResult(attempt(), completeResult()))
      .rejects.toMatchObject({ code: 'tenant_already_bound' });
    expect(ConnectionLifecycleError).toBeDefined();
  });

  it('maps the unique tenant/profile index conflict to the same generic tenant_already_bound code', async () => {
    dbMocks.updateResults.push(() => { throw Object.assign(new Error('duplicate'), { code: '23505' }); });
    await expect(applyIdentityVerificationResult(attempt(), completeResult()))
      .rejects.toMatchObject({ code: 'tenant_already_bound', message: 'tenant_already_bound' });
  });

  it('rejects zero-row delayed CAS results as stale', async () => {
    dbMocks.updateResults.push([]);
    await expect(markAdminConsentReturned(attempt('pending-consent')))
      .rejects.toMatchObject({ code: 'stale_attempt' });
  });

  it('keeps caller-scoped read/write transactions short and performs executor HTTP between them', async () => {
    dbMocks.selectResults.push([row()]);
    dbMocks.updateResults.push(
      (set) => [row({ ...set })],
      (set) => [row({ ...set })],
    );
    const executorClient = {
      completeIdentityVerification: vi.fn(),
      executeReadAction: vi.fn(),
      retestCustomerGraphRead: vi.fn(async () => {
        expect(contextMocks.callerDepth).toBe(0);
        return {
          success: true,
          tenantId: TENANT_ID,
          applicationId: CLIENT_ID,
          organizationDisplayName: 'Contoso',
          manifestVersion: 3,
          verifiedAt: '2026-07-14T16:00:00.000Z',
          grantReconciliation: 'complete',
          observedGrants: [...REQUIRED],
          missingGrants: [],
          unexpectedGrants: [],
          grantsVerifiedAt: '2026-07-14T16:00:00.000Z',
        } satisfies RetestResult;
      }),
    };

    await expect(retestCustomerGraphReadConnection({
      id: CONNECTION_ID, orgId: ORG_ID, auth: auth(), executorClient,
      correlationId: '99999999-9999-4999-8999-999999999999',
    })).resolves.toMatchObject({ status: 'active' });
    expect(contextMocks.withCaller).toHaveBeenCalledTimes(2);
    expect(contextMocks.withSystem).not.toHaveBeenCalled();
    expect(dbMocks.updateSets[0]).toMatchObject({
      consentAttemptId: expect.not.stringMatching(ATTEMPT_ID),
    });
    expect(executorClient.retestCustomerGraphRead).toHaveBeenCalledWith({
      correlationId: '99999999-9999-4999-8999-999999999999', tenantId: TENANT_ID,
    });
  });

  it('lets a newer retest result win while a slower prior operation becomes stale', async () => {
    let firstClaimedAttempt = '';
    let secondClaimedAttempt = '';
    let markFirstStarted!: () => void;
    let resolveFirst!: (result: RetestResult) => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstResult = new Promise<RetestResult>((resolve) => { resolveFirst = resolve; });
    const result = (displayName: string, verifiedAt: string): RetestResult => ({
      success: true,
      tenantId: TENANT_ID,
      applicationId: CLIENT_ID,
      organizationDisplayName: displayName,
      manifestVersion: 3,
      verifiedAt,
      grantReconciliation: 'complete',
      observedGrants: [...REQUIRED],
      missingGrants: [],
      unexpectedGrants: [],
      grantsVerifiedAt: verifiedAt,
    });

    dbMocks.selectResults.push([row()]);
    dbMocks.updateResults.push((set) => {
      firstClaimedAttempt = set.consentAttemptId as string;
      return [row({ ...set })];
    });
    const slowExecutor = {
      completeIdentityVerification: vi.fn(),
      executeReadAction: vi.fn(),
      retestCustomerGraphRead: vi.fn(() => {
        markFirstStarted();
        return firstResult;
      }),
    };
    const first = retestCustomerGraphReadConnection({
      id: CONNECTION_ID,
      orgId: ORG_ID,
      auth: auth(),
      executorClient: slowExecutor,
    });
    await firstStarted;

    expect(firstClaimedAttempt).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstClaimedAttempt).not.toBe(ATTEMPT_ID);
    dbMocks.selectResults.push([row({ consentAttemptId: firstClaimedAttempt })]);
    dbMocks.updateResults.push(
      (set) => {
        secondClaimedAttempt = set.consentAttemptId as string;
        return [row({ consentAttemptId: firstClaimedAttempt, ...set })];
      },
      (set) => [row({ consentAttemptId: secondClaimedAttempt, ...set })],
    );
    const newer = await retestCustomerGraphReadConnection({
      id: CONNECTION_ID,
      orgId: ORG_ID,
      auth: auth(),
      executorClient: {
        completeIdentityVerification: vi.fn(),
        executeReadAction: vi.fn(),
        retestCustomerGraphRead: vi.fn(async () => result('Newer Result', '2026-07-14T18:00:00.000Z')),
      },
    });
    expect(newer.displayName).toBe('Newer Result');
    expect(secondClaimedAttempt).not.toBe(firstClaimedAttempt);

    dbMocks.updateResults.push([]);
    resolveFirst(result('Older Result', '2026-07-14T17:00:00.000Z'));
    await expect(first).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(dbMocks.updateSets[2]).toMatchObject({ displayName: 'Newer Result' });
    expect(dbMocks.updateSets[3]).toMatchObject({ displayName: 'Older Result' });
    expect(JSON.stringify(dbMocks.updateWheres[2])).toContain(secondClaimedAttempt);
    expect(JSON.stringify(dbMocks.updateWheres[3])).toContain(firstClaimedAttempt);
  });

  it('denies cross-org or revoked retest snapshots before executor use', async () => {
    dbMocks.selectResults.push([]);
    await expect(loadRetestSnapshot({ id: CONNECTION_ID, orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', auth: auth() }))
      .rejects.toMatchObject({ code: 'connection_not_found' });
    expect(contextMocks.withCaller).toHaveBeenCalledOnce();
  });

  it('retains active status on transient retest failure and prior grants on unavailable reconciliation', async () => {
    const retestSnapshot = { ...snapshot(), tenantId: TENANT_ID, status: 'active', auth: auth() } as RetestSnapshot;
    dbMocks.updateResults.push((set) => [row({ ...set })]);
    await applyRetestResult(retestSnapshot, { success: false, errorCode: 'credential_unavailable' });
    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'active', lastErrorCode: 'credential_unavailable' });
    expect(JSON.stringify(dbMocks.updateWheres[0])).toContain(ATTEMPT_ID);

    dbMocks.updateResults.push((set) => [row({ ...set })]);
    const retained = await applyRetestResult(retestSnapshot, {
      success: true, tenantId: TENANT_ID, applicationId: CLIENT_ID,
      organizationDisplayName: 'Contoso', manifestVersion: 3,
      verifiedAt: '2026-07-14T17:00:00.000Z', grantReconciliation: 'unavailable',
      errorCode: 'grant_reconciliation_unavailable', observedGrants: null,
      missingGrants: null, unexpectedGrants: null, grantsVerifiedAt: null,
    });
    expect(dbMocks.updateSets[1]).not.toHaveProperty('observedGrants');
    expect(dbMocks.updateSets[1]).not.toHaveProperty('grantsVerifiedAt');
    expect(dbMocks.updateSets[1]).toMatchObject({ status: 'degraded', lastErrorCode: 'grant_reconciliation_unavailable' });
    expect(retained.observedGrants).toEqual(REQUIRED);
    expect(retained.grantsVerifiedAt).toEqual(new Date('2026-07-14T16:00:00.000Z'));
  });

  it('disconnect wins races by deleting sessions before rotating the attempt and clearing ownership/execution state', async () => {
    dbMocks.selectResults.push([row()]);
    dbMocks.updateResults.push((set) => [row({ ...set })]);
    const disconnected = await disconnectCustomerGraphReadConnection({ id: CONNECTION_ID, orgId: ORG_ID, actorId: ACTOR_ID });

    expect(dbMocks.order).toEqual(['delete-session', 'update']);
    expect(dbMocks.updateSets[0]).toMatchObject({
      tenantId: null, clientId: '', displayName: null, observedGrants: [],
      grantsVerifiedAt: null, lastVerifiedAt: null, status: 'revoked', lastErrorCode: null,
      permissionManifestVersion: 3,
    });
    expect(disconnected.status).toBe('revoked');
    expect(disconnected.consentAttemptId).not.toBe(ATTEMPT_ID);
  });
});

describe('createConnectionService factory (non-read profile)', () => {
  const actionsManifest = M365_PERMISSION_PROFILES['customer-graph-actions'];
  const ACTIONS_REQUIRED = actionsManifest.applicationPermissionAssignments ?? [];

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    dbMocks.updateResults.length = 0;
    dbMocks.updateSets.length = 0;
    dbMocks.order.length = 0;
    contextMocks.callerDepth = 0;
  });

  function actionsService(retest = vi.fn(async (_request: RetestRequest) => ({
    success: true, tenantId: TENANT_ID, applicationId: CLIENT_ID,
    organizationDisplayName: 'Contoso', manifestVersion: 1,
    verifiedAt: '2026-07-14T16:00:00.000Z', grantReconciliation: 'complete',
    observedGrants: [...ACTIONS_REQUIRED], missingGrants: [], unexpectedGrants: [],
    grantsVerifiedAt: '2026-07-14T16:00:00.000Z',
  } satisfies RetestResult))) {
    const createExecutorClient = vi.fn(() => ({ retest }));
    const service = createConnectionService({
      profile: 'customer-graph-actions',
      manifest: actionsManifest,
      loadRuntimeConfig: () => ({
        clientId: CLIENT_ID,
        callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
        vaultRef: 'akv://vault.example/m365-customer-graph-actions/0123456789abcdef0123456789abcdef',
        credentialVersion: '0123456789abcdef0123456789abcdef',
        executorUrl: 'https://actions-executor.example.test',
      }),
      createExecutorClient,
      retest: (client, request) => client.retest(request),
    });
    return { service, createExecutorClient, retest };
  }

  it('threads deps.profile and deps.manifest through list + grant-health', async () => {
    dbMocks.selectResults.push([row({
      profile: 'customer-graph-actions',
      permissionManifestVersion: actionsManifest.version,
      observedGrants: [...ACTIONS_REQUIRED],
    })]);

    const { service } = actionsService();
    const listed = await service.listConnections(ORG_ID);

    expect(listed).toHaveLength(1);
    const [connection] = listed;
    expect(connection!.profile).toBe('customer-graph-actions');
    expect(connection!.grantHealth.requiredGrants).toEqual(ACTIONS_REQUIRED);
    expect(connection!.grantHealth.state).toBe('active');
  });

  it('drops rows whose stored profile does not match the bound profile', async () => {
    dbMocks.selectResults.push([row({ profile: 'customer-graph-read' })]);
    const { service } = actionsService();
    expect(await service.listConnections(ORG_ID)).toEqual([]);
  });

  it('builds its executor via deps.createExecutorClient and retests via deps.retest', async () => {
    dbMocks.selectResults.push([row({ profile: 'customer-graph-actions' })]);
    dbMocks.updateResults.push(
      (set) => [row({ profile: 'customer-graph-actions', ...set })],
      (set) => [row({ profile: 'customer-graph-actions', ...set })],
    );

    const { service, createExecutorClient, retest } = actionsService();
    const result = await service.retestConnection({
      id: CONNECTION_ID, orgId: ORG_ID, auth: auth(),
      correlationId: '99999999-9999-4999-8999-999999999999',
    });

    expect(createExecutorClient).toHaveBeenCalledOnce();
    expect(retest).toHaveBeenCalledWith({
      correlationId: '99999999-9999-4999-8999-999999999999', tenantId: TENANT_ID,
    });
    expect(result.profile).toBe('customer-graph-actions');
    expect(result.status).toBe('active');
  });
});

describe('initiateUpgradeConsent', () => {
  const EXECUTABLE = {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    profile: 'customer-graph-read' as const,
    permissionManifestVersion: 2,
    observedGrants: [],
    consentAttemptId: ATTEMPT_ID,
    grantsVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    displayName: 'Contoso',
    status: 'active' as const,
    lastVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    lastErrorCode: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    dbMocks.updateResults.length = 0;
    dbMocks.insertResults.length = 0;
    dbMocks.updateSets.length = 0;
    dbMocks.updateWheres.length = 0;
    dbMocks.insertedValues.length = 0;
    dbMocks.executed.length = 0;
    dbMocks.order.length = 0;
    consentMocks.validStates.clear();
    consentMocks.stateCounter = 0;
    contextMocks.callerDepth = 0;
  });

  it('binds the session to the EXISTING attempt and never writes status', async () => {
    dbMocks.selectResults.push([EXECUTABLE], [EXECUTABLE]);

    const initiated = await initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: auth(),
    });

    expect(consentMocks.createAdmin).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      consentAttemptId: EXECUTABLE.consentAttemptId,
      purpose: 'upgrade',
    }));
    // The whole point of the transition: no UPDATE on m365_connections at all,
    // so an abandoned upgrade cannot strand a working connection in
    // pending-consent (spec §2.2).
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(initiated.connection.status).toBe('active');
    expect(initiated.connection.consentAttemptId).toBe(EXECUTABLE.consentAttemptId);
    expect(initiated.consentUrl).toContain('https://login.microsoftonline.com/common/adminconsent');
    expect(initiated.consentUrl).toContain('state=');
  });

  it('supersedes an abandoned upgrade session before minting a new one', async () => {
    dbMocks.selectResults.push([EXECUTABLE], [EXECUTABLE]);

    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: auth(),
    });

    expect(dbMocks.order.indexOf('delete-session'))
      .toBeLessThan(dbMocks.order.indexOf('insert-session'));
  });

  it('serializes against re-consent on the same owner/profile advisory lock', async () => {
    dbMocks.selectResults.push([EXECUTABLE], [EXECUTABLE]);

    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: auth(),
    });

    expect(dbMocks.order[0]).toBe('lock');
  });

  it('refuses a connection that is not executable', async () => {
    dbMocks.selectResults.push([]);

    await expect(initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: auth(),
    })).rejects.toMatchObject({ code: 'connection_not_found' });
    expect(consentMocks.createAdmin).not.toHaveBeenCalled();
  });

  it('refuses when the stored manifest is already current', async () => {
    // Nothing to approve; minting a consent URL would send an administrator to
    // Microsoft to re-approve what they already approved.
    dbMocks.selectResults.push([{ ...EXECUTABLE, permissionManifestVersion: 3 }]);

    await expect(initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: auth(),
    })).rejects.toMatchObject({ code: 'manifest_current' });
    expect(consentMocks.createAdmin).not.toHaveBeenCalled();
  });

  it('refuses when a concurrent write rotated the attempt', async () => {
    dbMocks.selectResults.push([EXECUTABLE], []);

    await expect(initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: auth(),
    })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(consentMocks.createAdmin).not.toHaveBeenCalled();
  });
});

describe('upgrade consent verification', () => {
  const MANIFEST = M365_PERMISSION_PROFILES['customer-graph-read'];
  const REQUIRED_V3 = [...(MANIFEST.applicationPermissionAssignments ?? [])];
  const ATTEMPT: ConsentAttemptSnapshot = {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    profile: 'customer-graph-read',
    consentAttemptId: ATTEMPT_ID,
    status: 'active',
  };
  const STORED = {
    ...ATTEMPT,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    permissionManifestVersion: 2,
    observedGrants: [],
    grantsVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    displayName: 'Contoso',
    lastVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    lastErrorCode: null,
  };
  function successResult(observedGrants: unknown[]) {
    return {
      success: true as const,
      tenantId: STORED.tenantId,
      applicationId: CLIENT_ID,
      organizationDisplayName: 'Contoso',
      manifestVersion: MANIFEST.version,
      verifiedAt: '2026-09-08T10:00:00.000Z',
      grantReconciliation: 'complete' as const,
      grantsVerifiedAt: '2026-09-08T10:00:01.000Z',
      observedGrants,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    dbMocks.updateResults.length = 0;
    dbMocks.updateSets.length = 0;
    dbMocks.updateWheres.length = 0;
    dbMocks.order.length = 0;
    consentMocks.validStates.clear();
    consentMocks.stateCounter = 0;
  });

  it('promotes the manifest version and bumps the consent generation on a full approval', async () => {
    dbMocks.selectResults.push([STORED]);
    dbMocks.updateResults.push((set) => [{ ...STORED, ...set }]);

    const applied = await applyUpgradeVerificationResult(ATTEMPT, successResult(REQUIRED_V3) as never);

    expect(applied.failureCode).toBeNull();
    const set = dbMocks.updateSets[0]!;
    expect(set.permissionManifestVersion).toBe(3);
    expect(set.consentGeneration).toBeDefined();      // sql`consent_generation + 1`
    expect(set.status).toBe('active');
    expect(set.lastErrorCode).toBeNull();
    expect(set.observedGrants).toEqual(REQUIRED_V3);
  });

  it('records the observation but does NOT promote when a v3 grant is missing', async () => {
    const partial = REQUIRED_V3.slice(0, REQUIRED_V3.length - 1);
    dbMocks.selectResults.push([STORED]);
    dbMocks.updateResults.push((set) => [{ ...STORED, ...set }]);

    const applied = await applyUpgradeVerificationResult(ATTEMPT, successResult(partial) as never);

    expect(applied.failureCode).toBe('grant_missing');
    const set = dbMocks.updateSets[0]!;
    expect(set.permissionManifestVersion).toBeUndefined();
    expect(set.consentGeneration).toBeUndefined();
    expect(set.status).toBeUndefined();               // never made less executable
    expect(set.lastErrorCode).toBe('grant_missing');
    expect(set.observedGrants).toEqual(partial);
  });

  it('writes nothing at all when the administrator abandoned or the provider failed', async () => {
    dbMocks.selectResults.push([STORED]);

    const applied = await applyUpgradeVerificationResult(
      ATTEMPT,
      { success: false, errorCode: 'consent_cancelled' } as never,
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.connection.permissionManifestVersion).toBe(2);
    expect(applied.connection.status).toBe('active');
    // The row is untouched by design, so the reason has to travel in band or
    // the callback cannot tell this apart from an abandoned flow.
    expect(applied.failureCode).toBe('consent_cancelled');
  });

  it('refuses to rebind: a different verified tenant is a silent no-op', async () => {
    // applyIdentityVerificationResult accepts a binding when tenant_id IS NULL
    // OR equal. An upgrade always has a bound tenant, so anything but equality
    // is an attempt to move a live connection to another tenant.
    dbMocks.selectResults.push([STORED]);

    const applied = await applyUpgradeVerificationResult(
      ATTEMPT,
      { ...successResult(REQUIRED_V3), tenantId: '99999999-9999-4999-8999-999999999999' } as never,
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.failureCode).toBe('tenant_mismatch');
  });

  it('writes nothing when the returned application is not the configured one', async () => {
    dbMocks.selectResults.push([STORED]);

    const applied = await applyUpgradeVerificationResult(
      ATTEMPT,
      { ...successResult(REQUIRED_V3), applicationId: '99999999-9999-4999-8999-999999999999' } as never,
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.failureCode).toBe('application_token_invalid');
  });

  it('writes nothing when grant reconciliation was unavailable', async () => {
    dbMocks.selectResults.push([STORED]);

    const applied = await applyUpgradeVerificationResult(
      ATTEMPT,
      { ...successResult(REQUIRED_V3), grantReconciliation: 'unavailable' } as never,
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.failureCode).toBe('grant_reconciliation_unavailable');
  });

  it('rejects an attempt whose connection is not executable', async () => {
    await expect(applyUpgradeVerificationResult(
      { ...ATTEMPT, status: 'pending-consent' },
      successResult(REQUIRED_V3) as never,
    )).rejects.toMatchObject({ code: 'stale_attempt' });
  });
});

describe('transitionUpgradeConsentToIdentity', () => {
  const ATTEMPT: ConsentAttemptSnapshot = {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    profile: 'customer-graph-read',
    consentAttemptId: ATTEMPT_ID,
    status: 'active',
  };
  const STORED = {
    ...ATTEMPT,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    permissionManifestVersion: 2,
    observedGrants: [],
    grantsVerifiedAt: null,
    displayName: null,
    lastVerifiedAt: null,
    lastErrorCode: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    dbMocks.updateResults.length = 0;
    dbMocks.updateSets.length = 0;
    dbMocks.order.length = 0;
  });

  it('consumes the admin session and inserts an upgrade identity session without an UPDATE', async () => {
    consentMocks.consumeAdmin.mockResolvedValueOnce({ userId: ACTOR_ID, purpose: 'upgrade' } as never);
    dbMocks.selectResults.push([STORED]);

    const prepared = {
      rawState: 'identity-state', tenantHintHash: 'h', nonce: 'n',
      codeVerifier: 'v', codeChallenge: 'c', expiresAt: new Date(),
    };
    const result = await transitionUpgradeConsentToIdentity({
      attempt: ATTEMPT,
      rawAdminState: 'admin-state',
      prepared: prepared as never,
    });

    expect(result.actorId).toBe(ACTOR_ID);
    expect(dbMocks.updateSets).toHaveLength(0);       // status untouched
    expect(consentMocks.insertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'upgrade', consentAttemptId: ATTEMPT.consentAttemptId }),
      expect.anything(),
    );
  });

  it('refuses an upgrade session reaching the FIRST-TIME transition', async () => {
    // Symmetric to the check below. Unreachable today only because the two
    // flows gate on disjoint statuses; if that ever slipped, an upgrade would
    // move a live connection to `verifying` and stop its reads.
    consentMocks.consumeAdmin.mockResolvedValueOnce({ userId: ACTOR_ID, purpose: 'upgrade' } as never);

    await expect(transitionAdminConsentToIdentity({
      attempt: { ...ATTEMPT, status: 'pending-consent' },
      rawAdminState: 'admin-state',
      prepared: {} as never,
    })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it('refuses an admin session that is not an upgrade session', async () => {
    // Defense in depth against a first-time session reaching the upgrade
    // branch: the router read the purpose without consuming, so the consumed
    // row is the authority.
    consentMocks.consumeAdmin.mockResolvedValueOnce({ userId: ACTOR_ID, purpose: 'initial' } as never);

    await expect(transitionUpgradeConsentToIdentity({
      attempt: ATTEMPT,
      rawAdminState: 'admin-state',
      prepared: {} as never,
    })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(consentMocks.insertIdentity).not.toHaveBeenCalled();
  });

  it('refuses when the connection is no longer executable', async () => {
    await expect(transitionUpgradeConsentToIdentity({
      attempt: { ...ATTEMPT, status: 'verifying' },
      rawAdminState: 'admin-state',
      prepared: {} as never,
    })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(consentMocks.consumeAdmin).not.toHaveBeenCalled();
  });
});

describe('retest with an upgrade consent in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
    dbMocks.updateResults.length = 0;
    dbMocks.updateSets.length = 0;
    dbMocks.order.length = 0;
    contextMocks.callerDepth = 0;
  });

  it("supersedes the connection's consent sessions before rotating the attempt id", async () => {
    // The attempt-id rotation in loadRetestSnapshot has no ON UPDATE CASCADE
    // on m365_consent_sessions_connection_identity_fkey, so a live upgrade
    // session would make the rotation raise 23503.
    const CURRENT = {
      id: CONNECTION_ID,
      orgId: ORG_ID,
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      profile: 'customer-graph-read' as const,
      permissionManifestVersion: 3,
      observedGrants: [],
      consentAttemptId: ATTEMPT_ID,
      grantsVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      displayName: 'Contoso',
      status: 'active' as const,
      lastVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      lastErrorCode: null,
    };
    dbMocks.selectResults.push([CURRENT]);
    dbMocks.updateResults.push([CURRENT], [CURRENT]);

    await retestCustomerGraphReadConnection({
      id: CURRENT.id,
      orgId: CURRENT.orgId,
      auth: auth(),
      executorClient: {
        retestCustomerGraphRead: async () => ({ success: false, errorCode: 'credential_unavailable' }),
      } as never,
    });

    expect(consentMocks.deleteForConnection).toHaveBeenCalledWith({
      connectionId: CURRENT.id,
      orgId: CURRENT.orgId,
      profile: 'customer-graph-read',
    });
    expect(dbMocks.order.indexOf('delete-session-by-connection'))
      .toBeLessThan(dbMocks.order.indexOf('update'));
  });
});
