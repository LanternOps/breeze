import { beforeEach, describe, expect, it, vi } from 'vitest';
import { M365_PERMISSION_PROFILES, type RetestRequest, type RetestResult } from '@breeze/shared/m365';

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
    consumedPurpose: 'initial' as 'initial' | 'upgrade',
    createIdentity: vi.fn(async (_input: Record<string, unknown>) => {
      dbMocks.order.push('insert-session');
      consentMocks.stateCounter += 1;
      const rawState = consentMocks.stateCounter === 1 ? 'raw-state' : `raw-state-${consentMocks.stateCounter}`;
      consentMocks.validStates.add(rawState);
      return { rawState, session: {}, nonce: `nonce-${consentMocks.stateCounter}`, codeChallenge: `challenge-${consentMocks.stateCounter}` };
    }),
    insertVerified: vi.fn(async (_input: Record<string, unknown>) => {
      dbMocks.order.push('insert-verified-session');
      consentMocks.stateCounter += 1;
      const rawState = `consent-state-${consentMocks.stateCounter}`;
      consentMocks.validStates.add(rawState);
      return { rawState, session: {} };
    }),
    consumeAdmin: vi.fn(async (input: { rawState: string }) => {
      dbMocks.order.push('consume-admin-session');
      if (!consentMocks.validStates.delete(input.rawState)) return null;
      // A flow-2 admin_consent session carries the identity verified in phase 1.
      return {
        userId: '66666666-6666-4666-8666-666666666666',
        purpose: consentMocks.consumedPurpose,
        flowVersion: 2,
        phase: 'admin_consent',
        verifiedTenantId: '44444444-4444-4444-8444-444444444444',
        verifiedAdminObjectId: '77777777-7777-4777-8777-777777777777',
        verifiedAdminUsername: 'admin@tenant.example',
        identityVerifiedAt: new Date('2026-07-14T15:59:00.000Z'),
      };
    }),
    deleteForConnection: vi.fn(async () => {
      dbMocks.order.push('delete-session-by-connection');
      consentMocks.validStates.clear();
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

vi.mock('./consentSessionService', async (importActual) => {
  const actual = await importActual<typeof import('./consentSessionService')>();
  return {
    // Pure helpers stay real so the service is tested against the true
    // flow-2 / verified-identity rules.
    hashTenantHint: actual.hashTenantHint,
    verifiedIdentityFromSession: actual.verifiedIdentityFromSession,
    deleteConsentSessionsForAttemptInTransaction: consentMocks.deleteAttempt,
    deleteConsentSessionsForConnection: consentMocks.deleteForConnection,
    createIdentitySessionInTransaction: consentMocks.createIdentity,
    insertVerifiedConsentSessionInTransaction: consentMocks.insertVerified,
    consumeConsentSessionInTransaction: consentMocks.consumeAdmin,
  };
});

const { lifecycleMocks } = vi.hoisted(() => ({
  lifecycleMocks: {
    disconnected: vi.fn(async (_conn: { id: string; orgId: string }) => {}),
    depthAtHook: -1,
  },
}));
vi.mock('../m365Sync/lifecycle', () => ({
  onConnectionDisconnected: lifecycleMocks.disconnected,
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
  applyConsentFinalizationResult,
  applyUpgradeFinalizationResult,
  applyRetestResult,
  beginConsentFinalization,
  createConnectionService,
  deriveGrantHealth,
  disconnectCustomerGraphReadConnection,
  initiateCustomerGraphReadConsent,
  initiateCustomerGraphReadUpgradeConsent,
  loadRetestSnapshot,
  markConsentAttemptFailed,
  retestCustomerGraphReadConnection,
  transitionIdentityToConsent,
  type ConsentAttemptSnapshot,
  type CustomerGraphReadConnectionSnapshot,
  type RetestSnapshot,
} from './connectionService';
import * as connectionServiceModule from './connectionService';
import type { VerifiedConsentIdentity } from './consentSessionService';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const CLIENT_ID = '55555555-5555-4555-8555-555555555555';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';
const ADMIN_ID = '77777777-7777-4777-8777-777777777777';
const TENANT_B = '88888888-8888-4888-8888-888888888888';
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

function retestOk(overrides: Partial<Extract<RetestResult, { success: true }>> = {}): RetestResult {
  return {
    success: true, tenantId: TENANT_ID, applicationId: CLIENT_ID,
    organizationDisplayName: 'Contoso', manifestVersion: 3,
    verifiedAt: '2026-07-14T16:00:00.000Z', grantReconciliation: 'complete',
    observedGrants: [...REQUIRED], missingGrants: [], unexpectedGrants: [],
    grantsVerifiedAt: '2026-07-14T16:00:00.000Z', ...overrides,
  } as RetestResult;
}

function verifiedIdentity(tenantId = TENANT_ID): VerifiedConsentIdentity {
  return {
    tenantId,
    administratorObjectId: ADMIN_ID,
    administratorUsername: 'admin@tenant.example',
    verifiedAt: new Date('2026-07-14T15:59:00.000Z'),
  };
}

/** Finalization input for the first-time path. */
function fin(result: RetestResult, verifiedTenantId = TENANT_ID) {
  return { verifiedTenantId, result };
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

    // A still-bound row (reconnect) pins the identity sign-in to its tenant.
    expect(result.binding).toEqual({
      phase: 'identity_verification',
      rawState: 'raw-state',
      connectionId: CONNECTION_ID,
      consentAttemptId: dbMocks.updateSets[0]!.consentAttemptId,
      tenantId: TENANT_ID,
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('state')).toBe('raw-state');
    expect(url.searchParams.get('nonce')).toBe('nonce-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://console.example.test/api/v1/m365/consent/callback');
    expect(result.authorizationUrl).not.toContain('adminconsent');
    expect(consentMocks.createIdentity).toHaveBeenCalledWith(expect.objectContaining({
      expectedTenantId: TENANT_ID, userId: ACTOR_ID, profile: 'customer-graph-read',
    }));
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
    if (step === 'insert-session') consentMocks.createIdentity.mockRejectedValueOnce(new Error('write failed'));

    await expect(initiateCustomerGraphReadConsent({ orgId: ORG_ID, actorId: ACTOR_ID }))
      .rejects.toThrow('write failed');
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
  });

  it('propagates a first-connection insert failure so no identity session is created', async () => {
    dbMocks.selectResults.push([]);
    dbMocks.insertResults.push(() => { throw new Error('insert failed'); });

    await expect(initiateCustomerGraphReadConsent({ orgId: ORG_ID, actorId: ACTOR_ID }))
      .rejects.toThrow('insert failed');
    expect(dbMocks.insertedValues[0]).toMatchObject({ permissionManifestVersion: 3 });
    expect(consentMocks.createIdentity).not.toHaveBeenCalled();
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

    expect(first.binding.rawState).not.toBe(second.binding.rawState);
    expect([first.binding.rawState, second.binding.rawState].filter((state) => consentMocks.validStates.has(state)))
      .toEqual([second.binding.rawState]);
    expect(dbMocks.executed).toHaveLength(2);
  });

  it('binds a verified tenant once and computes active only from exact current grants', async () => {
    dbMocks.updateResults.push((set) => [row({ tenantId: null, status: 'verifying', ...set })]);
    await expect(applyConsentFinalizationResult(attempt(), fin(retestOk()))).resolves.toMatchObject({ status: 'active', tenantId: TENANT_ID });
    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'active', tenantId: TENANT_ID, observedGrants: REQUIRED, lastErrorCode: null });
    expect(JSON.stringify(dbMocks.updateWheres[0])).toContain('isNull');
    expect(JSON.stringify(dbMocks.updateWheres[0])).toContain(TENANT_ID);
  });

  it('returns a bounded lifecycle snapshot for observability without executor-only proof fields', async () => {
    dbMocks.updateResults.push((set) => [row({ tenantId: null, status: 'verifying', ...set })]);
    const applied = await applyConsentFinalizationResult(attempt(), fin({
      ...retestOk(),
      administratorObjectId: 'must-not-reach-control-plane-observability',
      accessToken: 'must-not-reach-control-plane-observability',
      idToken: 'must-not-reach-control-plane-observability',
      providerDescription: 'must-not-reach-control-plane-observability',
    } as never));

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
    await expect(applyConsentFinalizationResult(attempt(), fin(retestOk({
      applicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })))).resolves.toMatchObject({ status: 'pending-consent', tenantId: null });
    expect(dbMocks.updateSets[0]).toMatchObject({
      status: 'pending-consent', lastErrorCode: 'application_token_invalid',
    });
    expect(dbMocks.updateSets[0]).not.toHaveProperty('tenantId');
  });

  it('binds trusted proof but stores no observed set/timestamp when first reconciliation is unavailable', async () => {
    dbMocks.updateResults.push((set) => [row({ tenantId: null, observedGrants: [], grantsVerifiedAt: null, status: 'verifying', ...set })]);
    const unavailable = {
      ...retestOk(), grantReconciliation: 'unavailable', errorCode: 'grant_reconciliation_unavailable',
      observedGrants: null, missingGrants: null, unexpectedGrants: null, grantsVerifiedAt: null,
    } as RetestResult;

    await expect(applyConsentFinalizationResult(attempt(), fin(unavailable))).resolves.toMatchObject({ status: 'degraded', tenantId: TENANT_ID });
    expect(dbMocks.updateSets[0]).not.toHaveProperty('observedGrants');
    expect(dbMocks.updateSets[0]).not.toHaveProperty('grantsVerifiedAt');
    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'degraded', lastErrorCode: 'grant_reconciliation_unavailable' });
  });

  it('returns generic tenant_already_bound for immutable or unique tenant ownership conflicts', async () => {
    dbMocks.updateResults.push([]);
    dbMocks.selectResults.push([{ tenantId: '88888888-8888-4888-8888-888888888888' }]);
    await expect(applyConsentFinalizationResult(attempt(), fin(retestOk())))
      .rejects.toMatchObject({ code: 'tenant_already_bound' });
    expect(ConnectionLifecycleError).toBeDefined();
  });

  it('maps the unique tenant/profile index conflict to the same generic tenant_already_bound code', async () => {
    dbMocks.updateResults.push(() => { throw Object.assign(new Error('duplicate'), { code: '23505' }); });
    await expect(applyConsentFinalizationResult(attempt(), fin(retestOk())))
      .rejects.toMatchObject({ code: 'tenant_already_bound', message: 'tenant_already_bound' });
  });

  it('rejects zero-row delayed CAS results as stale', async () => {
    dbMocks.updateResults.push([]);
    await expect(markConsentAttemptFailed(attempt('pending-consent'), 'consent_cancelled'))
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
      verifyConsentIdentity: vi.fn(),
      executeReadAction: vi.fn(),
      syncAction: vi.fn(),
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
      verifyConsentIdentity: vi.fn(),
      executeReadAction: vi.fn(),
      syncAction: vi.fn(),
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
        verifyConsentIdentity: vi.fn(),
        executeReadAction: vi.fn(),
        syncAction: vi.fn(),
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

  describe('disconnect erases the synced tenant snapshot (spec §5.8)', () => {
    it('calls the sync disconnect hook AFTER the status flip, inside the same single system context', async () => {
      dbMocks.selectResults.push([row()]);
      dbMocks.updateResults.push((set) => [row({ ...set })]);
      let systemDepth = 0;
      contextMocks.withSystem.mockImplementationOnce(async (fn) => {
        systemDepth += 1;
        try { return await fn(); } finally { systemDepth -= 1; }
      });
      lifecycleMocks.disconnected.mockImplementationOnce(async () => {
        lifecycleMocks.depthAtHook = systemDepth;
        dbMocks.order.push('erase');
      });

      await disconnectCustomerGraphReadConnection({ id: CONNECTION_ID, orgId: ORG_ID, actorId: ACTOR_ID });

      expect(lifecycleMocks.disconnected).toHaveBeenCalledWith({ id: CONNECTION_ID, orgId: ORG_ID });
      expect(dbMocks.order).toEqual(['delete-session', 'update', 'erase']);
      expect(lifecycleMocks.depthAtHook).toBe(1);
      expect(contextMocks.withSystem).toHaveBeenCalledOnce();
    });

    it('propagates a hook failure so the whole disconnect rolls back', async () => {
      dbMocks.selectResults.push([row()]);
      dbMocks.updateResults.push((set) => [row({ ...set })]);
      lifecycleMocks.disconnected.mockRejectedValueOnce(new Error('erase failed'));
      await expect(disconnectCustomerGraphReadConnection({ id: CONNECTION_ID, orgId: ORG_ID, actorId: ACTOR_ID }))
        .rejects.toThrow('erase failed');
    });

    it('does not erase when the connection was not found', async () => {
      dbMocks.selectResults.push([]);
      await expect(disconnectCustomerGraphReadConnection({ id: CONNECTION_ID, orgId: ORG_ID, actorId: ACTOR_ID }))
        .rejects.toMatchObject({ code: 'connection_not_found' });
      expect(lifecycleMocks.disconnected).not.toHaveBeenCalled();
    });
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

  it('disconnecting the ACTIONS profile never erases the tenant snapshot the READ profile synced', async () => {
    // The sync reads exclusively through the customer-graph-read connection;
    // m365_* entity rows are org-keyed, so erasing them here would wipe data
    // the still-connected read profile owns.
    dbMocks.selectResults.push([row({ profile: 'customer-graph-actions' })]);
    dbMocks.updateResults.push((set) => [row({ profile: 'customer-graph-actions', ...set })]);
    const { service } = actionsService();
    await service.disconnectConnection({ id: CONNECTION_ID, orgId: ORG_ID, actorId: ACTOR_ID });
    expect(lifecycleMocks.disconnected).not.toHaveBeenCalled();
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

    expect(consentMocks.createIdentity).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      consentAttemptId: EXECUTABLE.consentAttemptId,
      purpose: 'upgrade',
      // Upgrade pins the identity sign-in to the bound tenant.
      expectedTenantId: TENANT_ID,
    }));
    // The whole point of the transition: no UPDATE on m365_connections at all,
    // so an abandoned upgrade cannot strand a working connection in
    // pending-consent (spec §2.2).
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(initiated.connection.status).toBe('active');
    expect(initiated.connection.consentAttemptId).toBe(EXECUTABLE.consentAttemptId);
    expect(new URL(initiated.authorizationUrl).pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`);
    expect(initiated.binding).toMatchObject({ phase: 'identity_verification', tenantId: TENANT_ID, consentAttemptId: ATTEMPT_ID });
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
    expect(consentMocks.createIdentity).not.toHaveBeenCalled();
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
    expect(consentMocks.createIdentity).not.toHaveBeenCalled();
  });

  it('refuses when a concurrent write rotated the attempt', async () => {
    dbMocks.selectResults.push([EXECUTABLE], []);

    await expect(initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: auth(),
    })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(consentMocks.createIdentity).not.toHaveBeenCalled();
  });
});

describe('upgrade consent finalization', () => {
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

    const applied = await applyUpgradeFinalizationResult(ATTEMPT, { verifiedTenantId: TENANT_ID, result: successResult(REQUIRED_V3) as never });

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

    const applied = await applyUpgradeFinalizationResult(ATTEMPT, { verifiedTenantId: TENANT_ID, result: successResult(partial) as never });

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

    const applied = await applyUpgradeFinalizationResult(
      ATTEMPT,
      { verifiedTenantId: TENANT_ID, result: { success: false, errorCode: 'organization_probe_failed' } },
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.connection.permissionManifestVersion).toBe(2);
    expect(applied.connection.status).toBe('active');
    // The row is untouched by design, so the reason has to travel in band or
    // the callback cannot tell this apart from an abandoned flow.
    expect(applied.failureCode).toBe('organization_probe_failed');
  });

  it('refuses to rebind: a different application-proof tenant is a silent no-op', async () => {
    // applyConsentFinalizationResult accepts a binding when tenant_id IS NULL
    // OR equal. An upgrade always has a bound tenant, so anything but equality
    // is an attempt to move a live connection to another tenant.
    dbMocks.selectResults.push([STORED]);

    const applied = await applyUpgradeFinalizationResult(
      ATTEMPT,
      { verifiedTenantId: TENANT_ID, result: { ...successResult(REQUIRED_V3), tenantId: '99999999-9999-4999-8999-999999999999' } as never },
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.failureCode).toBe('tenant_mismatch');
  });

  it('upgrade finalization with a different VERIFIED tenant is a no-op reporting tenant_mismatch', async () => {
    dbMocks.selectResults.push([STORED]);

    const applied = await applyUpgradeFinalizationResult(
      ATTEMPT,
      { verifiedTenantId: TENANT_B, result: { ...successResult(REQUIRED_V3), tenantId: TENANT_B } as never },
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.failureCode).toBe('tenant_mismatch');
  });

  it('writes nothing when the returned application is not the configured one', async () => {
    dbMocks.selectResults.push([STORED]);

    const applied = await applyUpgradeFinalizationResult(
      ATTEMPT,
      { verifiedTenantId: TENANT_ID, result: { ...successResult(REQUIRED_V3), applicationId: '99999999-9999-4999-8999-999999999999' } as never },
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.failureCode).toBe('application_token_invalid');
  });

  it('writes nothing when grant reconciliation was unavailable', async () => {
    dbMocks.selectResults.push([STORED]);

    const applied = await applyUpgradeFinalizationResult(
      ATTEMPT,
      { verifiedTenantId: TENANT_ID, result: { ...successResult(REQUIRED_V3), grantReconciliation: 'unavailable' } as never },
    );

    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.failureCode).toBe('grant_reconciliation_unavailable');
  });

  it('rejects an attempt whose connection is not executable', async () => {
    await expect(applyUpgradeFinalizationResult(
      { ...ATTEMPT, status: 'pending-consent' },
      { verifiedTenantId: TENANT_ID, result: successResult(REQUIRED_V3) as never },
    )).rejects.toMatchObject({ code: 'stale_attempt' });
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

describe.each([
  ['customer-graph-read', 'https://console.example.test/api/v1/m365/consent/callback'],
  ['customer-graph-actions', 'https://console.example.test/api/v1/m365/actions-consent/callback'],
] as const)('%s identity-first lifecycle', (profile, callbackUrl) => {
  const manifest = M365_PERMISSION_PROFILES[profile];
  const PROFILE_REQUIRED = [...(manifest.applicationPermissionAssignments ?? [])];

  function profileRow(overrides: Record<string, unknown> = {}) {
    return row({
      profile,
      credentialDomain: profile,
      permissionManifestVersion: manifest.version,
      observedGrants: [...PROFILE_REQUIRED],
      ...overrides,
    });
  }

  function profileAttempt(status: ConsentAttemptSnapshot['status']) {
    return { id: CONNECTION_ID, orgId: ORG_ID, profile, consentAttemptId: ATTEMPT_ID, status } as const;
  }

  function service() {
    return createConnectionService({
      profile,
      manifest,
      loadRuntimeConfig: () => ({
        clientId: CLIENT_ID,
        callbackUrl,
        vaultRef: `akv://vault.example/${profile}/0123456789abcdef0123456789abcdef`,
        credentialVersion: '0123456789abcdef0123456789abcdef',
      }),
      createExecutorClient: () => ({}),
      retest: async () => { throw new Error('not used'); },
    });
  }

  function okFor(tenantId: string): RetestResult {
    return retestOk({ tenantId, manifestVersion: manifest.version, observedGrants: [...PROFILE_REQUIRED] });
  }

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
    consentMocks.validStates.clear();
    consentMocks.stateCounter = 0;
    consentMocks.consumedPurpose = 'initial';
  });

  it('initial connect starts at the organizations authority and writes an identity session', async () => {
    dbMocks.selectResults.push([]);
    dbMocks.insertResults.push((values) => [profileRow({ ...values })]);

    const initiated = await service().initiateConsent({ orgId: ORG_ID, actorId: ACTOR_ID });

    const url = new URL(initiated.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(callbackUrl);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(initiated.binding).toMatchObject({ phase: 'identity_verification', tenantId: null, rawState: 'raw-state' });
    expect(consentMocks.createIdentity).toHaveBeenCalledWith(expect.objectContaining({
      expectedTenantId: null, profile, userId: ACTOR_ID,
    }));
    expect(consentMocks.createIdentity.mock.calls[0]![0]).not.toHaveProperty('purpose', 'upgrade');
  });

  it('reconnect of a still-bound row pins identity to the bound tenant', async () => {
    dbMocks.selectResults.push([profileRow({ status: 'degraded', tenantId: TENANT_ID })]);
    dbMocks.updateResults.push((set) => [profileRow({ status: 'degraded', ...set })]);

    const initiated = await service().initiateConsent({ orgId: ORG_ID, actorId: ACTOR_ID });

    expect(new URL(initiated.authorizationUrl).pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`);
    expect(initiated.binding.tenantId).toBe(TENANT_ID);
    // Reconnect never clears the binding; only a verified finalize may write tenant_id.
    expect(dbMocks.updateSets[0]).not.toHaveProperty('tenantId');
  });

  it('reconnect after disconnect (tenant cleared) uses organizations again', async () => {
    dbMocks.selectResults.push([profileRow({ status: 'revoked', tenantId: null })]);
    dbMocks.updateResults.push((set) => [profileRow({ status: 'revoked', tenantId: null, ...set })]);

    const initiated = await service().initiateConsent({ orgId: ORG_ID, actorId: ACTOR_ID });

    expect(new URL(initiated.authorizationUrl).pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect(initiated.binding.tenantId).toBeNull();
  });

  it('a row left in verifying by the old flow is restartable by initiating again', async () => {
    dbMocks.selectResults.push([profileRow({ status: 'verifying', tenantId: null })]);
    dbMocks.updateResults.push((set) => [profileRow({ status: 'verifying', tenantId: null, ...set })]);

    const initiated = await service().initiateConsent({ orgId: ORG_ID, actorId: ACTOR_ID });

    expect(initiated.connection.status).toBe('pending-consent');
    expect(new URL(initiated.authorizationUrl).pathname).toBe('/organizations/oauth2/v2.0/authorize');
  });

  it('upgrade pins identity to the bound tenant and writes nothing to the row', async () => {
    const stale = profileRow({ permissionManifestVersion: manifest.version - 1 });
    dbMocks.selectResults.push([stale], [stale]);

    const initiated = await service().initiateUpgradeConsent({ connectionId: CONNECTION_ID, orgId: ORG_ID, auth: auth() });

    expect(new URL(initiated.authorizationUrl).pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`);
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(consentMocks.createIdentity).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'upgrade', expectedTenantId: TENANT_ID,
    }));
  });

  it('identity → consent writes a verified session and does NOT move status or bind', async () => {
    dbMocks.selectResults.push([profileRow({ status: 'pending-consent', tenantId: null })]);

    const out = await service().transitionIdentityToConsent({
      attempt: profileAttempt('pending-consent'), purpose: 'initial', actorId: ACTOR_ID,
      verified: verifiedIdentity(TENANT_ID), nextPhase: 'admin_consent',
    });

    expect(out.verifiedTenantId).toBe(TENANT_ID);
    expect(out.rawState).toMatch(/^consent-state-/);
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(dbMocks.order).toEqual(['lock', 'insert-verified-session']);
    expect(consentMocks.insertVerified).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'admin_consent',
      purpose: 'initial',
      profile,
      userId: ACTOR_ID,
      consentAttemptId: ATTEMPT_ID,
      verified: verifiedIdentity(TENANT_ID),
    }));
  });

  it('identity → consent on a bound reconnect row accepts the same tenant', async () => {
    dbMocks.selectResults.push([profileRow({ status: 'pending-consent', tenantId: TENANT_ID })]);

    await expect(service().transitionIdentityToConsent({
      attempt: profileAttempt('pending-consent'), purpose: 'initial', actorId: ACTOR_ID,
      verified: verifiedIdentity(TENANT_ID), nextPhase: 'admin_consent',
    })).resolves.toMatchObject({ verifiedTenantId: TENANT_ID });
  });

  it('identity in tenant B cannot continue an attempt on a row bound to tenant A', async () => {
    dbMocks.selectResults.push([profileRow({ status: 'pending-consent', tenantId: TENANT_ID })]);

    await expect(service().transitionIdentityToConsent({
      attempt: profileAttempt('pending-consent'), purpose: 'initial', actorId: ACTOR_ID,
      verified: verifiedIdentity(TENANT_B), nextPhase: 'admin_consent',
    })).rejects.toMatchObject({ code: 'tenant_mismatch' });
    expect(consentMocks.insertVerified).not.toHaveBeenCalled();
  });

  it('a superseded attempt cannot continue (concurrent re-initiate rotated the attempt)', async () => {
    dbMocks.selectResults.push([]);

    await expect(service().transitionIdentityToConsent({
      attempt: profileAttempt('pending-consent'), purpose: 'initial', actorId: ACTOR_ID,
      verified: verifiedIdentity(), nextPhase: 'admin_consent',
    })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(consentMocks.insertVerified).not.toHaveBeenCalled();
  });

  it('an initial transition refuses an executable attempt and an upgrade refuses pending-consent', async () => {
    await expect(service().transitionIdentityToConsent({
      attempt: profileAttempt('active'), purpose: 'initial', actorId: ACTOR_ID,
      verified: verifiedIdentity(), nextPhase: 'admin_consent',
    })).rejects.toMatchObject({ code: 'stale_attempt' });
    await expect(service().transitionIdentityToConsent({
      attempt: profileAttempt('pending-consent'), purpose: 'upgrade', actorId: ACTOR_ID,
      verified: verifiedIdentity(), nextPhase: 'admin_consent',
    })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(dbMocks.order).toEqual([]);
  });

  it('upgrade identity → consent requires the bound tenant and never writes the row', async () => {
    dbMocks.selectResults.push([profileRow({ status: 'active', tenantId: TENANT_ID })]);
    await expect(service().transitionIdentityToConsent({
      attempt: profileAttempt('active'), purpose: 'upgrade', actorId: ACTOR_ID,
      verified: verifiedIdentity(TENANT_ID), nextPhase: 'admin_consent',
    })).resolves.toMatchObject({ verifiedTenantId: TENANT_ID });
    expect(consentMocks.insertVerified).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'upgrade' }));

    dbMocks.selectResults.push([profileRow({ status: 'active', tenantId: TENANT_ID })]);
    await expect(service().transitionIdentityToConsent({
      attempt: profileAttempt('active'), purpose: 'upgrade', actorId: ACTOR_ID,
      verified: verifiedIdentity(TENANT_B), nextPhase: 'admin_consent',
    })).rejects.toMatchObject({ code: 'tenant_mismatch' });
    expect(consentMocks.insertVerified).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it('finalization start consumes the consent session and moves pending-consent → verifying', async () => {
    consentMocks.validStates.add('s2');
    dbMocks.updateResults.push((set) => [profileRow({ status: 'pending-consent', tenantId: null, ...set })]);

    const started = await service().beginConsentFinalization({ attempt: profileAttempt('pending-consent'), rawConsentState: 's2' });

    expect(started.verified).toEqual({
      tenantId: TENANT_ID,
      administratorObjectId: ADMIN_ID,
      administratorUsername: 'admin@tenant.example',
      verifiedAt: new Date('2026-07-14T15:59:00.000Z'),
    });
    expect(started.purpose).toBe('initial');
    expect(started.actorId).toBe(ACTOR_ID);
    expect(started.attempt).toEqual(profileAttempt('verifying'));
    expect(dbMocks.order).toEqual(['consume-admin-session', 'update']);
    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'verifying', lastErrorCode: null });
    expect(dbMocks.updateSets[0]!.consentedAt).toBeInstanceOf(Date);
    expect(dbMocks.updateSets[0]).not.toHaveProperty('tenantId');
    expect(consentMocks.consumeAdmin).toHaveBeenCalledWith(expect.objectContaining({ phase: 'admin_consent', rawState: 's2', profile }));
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
  });

  it('a replayed consent state is rejected (session already consumed)', async () => {
    await expect(service().beginConsentFinalization({ attempt: profileAttempt('pending-consent'), rawConsentState: 's2' }))
      .rejects.toMatchObject({ code: 'stale_attempt' });
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it('a consumed session without a verified identity never starts finalization', async () => {
    consentMocks.validStates.add('s2');
    consentMocks.consumeAdmin.mockResolvedValueOnce({ userId: ACTOR_ID, purpose: 'initial', flowVersion: 2, phase: 'admin_consent', verifiedTenantId: null } as never);

    await expect(service().beginConsentFinalization({ attempt: profileAttempt('pending-consent'), rawConsentState: 's2' }))
      .rejects.toMatchObject({ code: 'stale_attempt' });
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it('a first-time consent session cannot finalize an executable connection, and vice versa', async () => {
    consentMocks.validStates.add('s2');
    await expect(service().beginConsentFinalization({ attempt: profileAttempt('active'), rawConsentState: 's2' }))
      .rejects.toMatchObject({ code: 'stale_attempt' });
    consentMocks.validStates.add('s3');
    consentMocks.consumedPurpose = 'upgrade';
    await expect(service().beginConsentFinalization({ attempt: profileAttempt('pending-consent'), rawConsentState: 's3' }))
      .rejects.toMatchObject({ code: 'stale_attempt' });
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it('upgrade finalization start consumes only, with the row still executable', async () => {
    consentMocks.validStates.add('s2');
    consentMocks.consumedPurpose = 'upgrade';
    dbMocks.selectResults.push([profileRow({ status: 'active' })]);

    const started = await service().beginConsentFinalization({ attempt: profileAttempt('active'), rawConsentState: 's2' });

    expect(started.purpose).toBe('upgrade');
    expect(started.attempt.status).toBe('active');
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it('binds the VERIFIED tenant only after a successful application proof', async () => {
    dbMocks.updateResults.push((set) => [profileRow({ tenantId: null, status: 'verifying', ...set })]);

    const applied = await service().applyConsentFinalizationResult(profileAttempt('verifying'), { verifiedTenantId: TENANT_ID, result: okFor(TENANT_ID) });

    expect(dbMocks.updateSets[0]).toMatchObject({ tenantId: TENANT_ID, status: 'active' });
    expect(applied.status).toBe('active');
    expect(JSON.stringify(dbMocks.updateWheres[0])).toContain('isNull');
  });

  it('refuses to bind when the application proof reports a different tenant', async () => {
    dbMocks.updateResults.push((set) => [profileRow({ tenantId: null, status: 'verifying', ...set })]);

    await service().applyConsentFinalizationResult(profileAttempt('verifying'), { verifiedTenantId: TENANT_ID, result: okFor(TENANT_B) });

    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'pending-consent', lastErrorCode: 'tenant_mismatch' });
    expect(dbMocks.updateSets[0]).not.toHaveProperty('tenantId');
  });

  it.each([
    ['application_token_invalid'],
    ['organization_probe_failed'],
    ['credential_unavailable'],
  ] as const)('does not bind on a failed application proof (%s)', async (code) => {
    dbMocks.updateResults.push((set) => [profileRow({ tenantId: null, status: 'verifying', ...set })]);

    await service().applyConsentFinalizationResult(profileAttempt('verifying'), {
      verifiedTenantId: TENANT_ID, result: { success: false, errorCode: code },
    });

    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'pending-consent', lastErrorCode: code });
    expect(dbMocks.updateSets[0]).not.toHaveProperty('tenantId');
  });

  it('only applies a finalization to a verifying attempt', async () => {
    await expect(service().applyConsentFinalizationResult(profileAttempt('pending-consent'), { verifiedTenantId: TENANT_ID, result: okFor(TENANT_ID) }))
      .rejects.toMatchObject({ code: 'stale_attempt' });
    expect(dbMocks.updateSets).toHaveLength(0);
  });
});

it('no longer exports the admin-consent-first lifecycle functions', () => {
  for (const removed of [
    'markAdminConsentReturned',
    'transitionAdminConsentToIdentity',
    'transitionUpgradeConsentToIdentity',
    'applyIdentityVerificationResult',
    'applyUpgradeVerificationResult',
  ]) {
    expect(removed in connectionServiceModule, removed).toBe(false);
  }
});
