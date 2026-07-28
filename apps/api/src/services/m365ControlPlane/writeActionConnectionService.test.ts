import { beforeEach, describe, expect, it, vi } from 'vitest';
import { M365_PERMISSION_PROFILES } from '@breeze/shared/m365';

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
    runOutside: vi.fn(<T>(fn: () => T) => fn()),
    withSystem: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    withCaller: vi.fn(async <T>(_context: unknown, fn: () => Promise<T>) => fn()),
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
      return { userId: '66666666-6666-4666-8666-666666666666' };
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
  createAdminConsentSessionInTransaction: consentMocks.createAdmin,
  consumeConsentSessionInTransaction: consentMocks.consumeAdmin,
  insertPreparedIdentityVerificationSessionInTransaction: consentMocks.insertIdentity,
}));

vi.mock('./metrics', () => ({
  recordM365CustomerGraphActionsEvent: vi.fn(),
  recordM365CustomerGraphActionsMetric: vi.fn(),
}));

const ACTIONS_CLIENT_ID = '99999999-9999-4999-8999-999999999999';
const ACTIONS_CALLBACK_URL = 'https://console.example.test/api/v1/m365/actions-consent/callback';

vi.mock('./writeActionRuntimeConfig', () => ({
  loadM365CustomerGraphActionsRuntimeConfig: vi.fn(() => ({
    clientId: ACTIONS_CLIENT_ID,
    vaultRef: 'akv://vault.example/m365-customer-graph-actions/0123456789abcdef0123456789abcdef',
    credentialVersion: '0123456789abcdef0123456789abcdef',
    callbackUrl: ACTIONS_CALLBACK_URL,
    executorUrl: 'https://actions-executor.internal.example.test',
    executorAudience: 'm365-graph-actions-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'key-1',
    onboardingOrgIds: '*',
  })),
}));

import {
  actionsConnectionService,
  applyIdentityVerificationResult,
  applyRetestResult,
  disconnectCustomerGraphActionsConnection,
  initiateCustomerGraphActionsConsent,
  listCustomerGraphActionsConnections,
  loadRetestSnapshot,
  markAdminConsentReturned,
  markConsentAttemptFailed,
  retestCustomerGraphActionsConnection,
  transitionAdminConsentToIdentity,
} from './writeActionConnectionService';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '66666666-6666-4666-8666-666666666666';
const REQUIRED = M365_PERMISSION_PROFILES['customer-graph-actions'].applicationPermissionAssignments;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    orgId: ORG_ID,
    userId: null,
    tenantId: TENANT_ID,
    clientId: ACTIONS_CLIENT_ID,
    clientSecret: null,
    profile: 'customer-graph-actions' as const,
    authMode: 'application-certificate' as const,
    credentialDomain: 'customer-graph-actions' as const,
    vaultRef: 'akv://vault/version',
    credentialVersion: 'version',
    permissionManifestVersion: M365_PERMISSION_PROFILES['customer-graph-actions'].version,
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

describe('customer Graph-actions connection service instance', () => {
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
  });

  it('initiates actions consent with the actions app client id + callback', async () => {
    dbMocks.selectResults.push([]);
    dbMocks.insertResults.push((values) => [row({ ...values })]);

    const { consentUrl, connection } = await initiateCustomerGraphActionsConsent({
      orgId: ORG_ID,
      actorId: ACTOR_ID,
    });

    expect(connection.profile).toBe('customer-graph-actions');
    expect(consentUrl).toContain(`client_id=${ACTIONS_CLIENT_ID}`);
    expect(consentUrl).toContain(encodeURIComponent('/api/v1/m365/actions-consent/callback'));
  });

  it('rejects a read-profile connection id when retesting through the actions surface', async () => {
    dbMocks.selectResults.push([]);

    await expect(retestCustomerGraphActionsConnection({
      id: CONNECTION_ID,
      orgId: ORG_ID,
      auth: { scope: 'organization', orgId: ORG_ID, accessibleOrgIds: [ORG_ID], partnerId: null, user: { id: ACTOR_ID } } as never,
    })).rejects.toMatchObject({ code: 'connection_not_found' });
  });

  it('lists connections scoped to the customer-graph-actions profile', async () => {
    dbMocks.selectResults.push([row()]);

    const listed = await listCustomerGraphActionsConnections(ORG_ID);

    expect(listed).toHaveLength(1);
    expect(listed[0]!.profile).toBe('customer-graph-actions');
    expect(listed[0]!.grantHealth.state).toBe('active');
  });

  it('disconnects a connection bound to the customer-graph-actions profile', async () => {
    dbMocks.selectResults.push([row()]);
    dbMocks.updateResults.push((set) => [row({ ...set })]);

    const result = await disconnectCustomerGraphActionsConnection({
      id: CONNECTION_ID,
      orgId: ORG_ID,
      actorId: ACTOR_ID,
    });

    expect(result.profile).toBe('customer-graph-actions');
    expect(dbMocks.updateSets[0]).toMatchObject({ status: 'revoked' });
  });

  it('exports the callback-facing lifecycle functions bound to the actions instance', () => {
    expect(markAdminConsentReturned).toBe(actionsConnectionService.markAdminConsentReturned);
    expect(transitionAdminConsentToIdentity).toBe(actionsConnectionService.transitionAdminConsentToIdentity);
    expect(markConsentAttemptFailed).toBe(actionsConnectionService.markConsentAttemptFailed);
    expect(applyIdentityVerificationResult).toBe(actionsConnectionService.applyIdentityVerificationResult);
    expect(loadRetestSnapshot).toBe(actionsConnectionService.loadRetestSnapshot);
    expect(applyRetestResult).toBe(actionsConnectionService.applyRetestResult);
    expect(listCustomerGraphActionsConnections).toBe(actionsConnectionService.listConnections);
    expect(retestCustomerGraphActionsConnection).toBe(actionsConnectionService.retestConnection);
    expect(disconnectCustomerGraphActionsConnection).toBe(actionsConnectionService.disconnectConnection);
    expect(initiateCustomerGraphActionsConsent).toBe(actionsConnectionService.initiateConsent);
  });
});
