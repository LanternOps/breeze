import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks, contextMocks, sessionColumns } = vi.hoisted(() => ({
  dbMocks: {
    insertResults: [] as Array<'row' | 'collision'>,
    insertedValues: [] as Record<string, unknown>[],
    conflictTargets: [] as unknown[],
    deleteResults: [] as unknown[][],
    deleteWhere: vi.fn(),
    selectResults: [] as unknown[][],
    selectWhere: [] as unknown[],
    selectProjections: [] as unknown[],
  },
  contextMocks: {
    runOutside: vi.fn(<T>(fn: () => T) => fn()),
    withSystem: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  },
  sessionColumns: {
    stateHash: { name: 'state_hash' },
    phase: { name: 'phase' },
    connectionId: { name: 'connection_id' },
    orgId: { name: 'org_id' },
    profile: { name: 'profile' },
    consentAttemptId: { name: 'consent_attempt_id' },
    purpose: { name: 'purpose' },
    flowVersion: { name: 'flow_version' },
    expiresAt: { name: 'expires_at' },
  },
}));

vi.mock('../../db/schema', () => ({
  m365ConsentSessions: sessionColumns,
}));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
    eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
    gt: vi.fn((column: unknown, value: unknown) => ({ op: 'gt', column, value })),
    lte: vi.fn((column: unknown, value: unknown) => ({ op: 'lte', column, value })),
    sql: vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => ({
      op: 'sql', strings: [...strings], params,
    })),
  };
});

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        dbMocks.insertedValues.push(values);
        return {
          onConflictDoNothing: vi.fn(({ target }: { target: unknown }) => {
            dbMocks.conflictTargets.push(target);
            return {
              returning: vi.fn(async () => {
                const result = dbMocks.insertResults.shift() ?? 'row';
                return result === 'collision' ? [] : [sessionRow(values)];
              }),
            };
          }),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: dbMocks.deleteWhere.mockImplementation(() => ({
        returning: vi.fn(async () => dbMocks.deleteResults.shift() ?? []),
      })),
    })),
    select: vi.fn((projection: unknown) => {
      dbMocks.selectProjections.push(projection);
      return {
        from: vi.fn(() => ({
          where: vi.fn((where: unknown) => {
            dbMocks.selectWhere.push(where);
            return {
              limit: vi.fn(async () => dbMocks.selectResults.shift() ?? []),
            };
          }),
        })),
      };
    }),
  },
  runOutsideDbContext: contextMocks.runOutside,
  withSystemDbAccessContext: contextMocks.withSystem,
}));

import { m365ConsentSessions } from '../../db/schema';
import {
  consumeConsentSession,
  consumeConsentSessionInTransaction,
  createIdentitySessionInTransaction,
  deleteConsentSessionsForAttempt,
  deleteConsentSessionsForAttemptInTransaction,
  deleteConsentSessionsForConnection,
  hashTenantHint,
  insertVerifiedConsentSessionInTransaction,
  readConsentSessionPurpose,
  verifiedIdentityFromSession,
  type VerifiedConsentIdentity,
} from './consentSessionService';
import * as consentSessionService from './consentSessionService';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';
const ADMIN_ID = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-07-14T16:00:00.000Z');

function sessionRow(values: Record<string, unknown> = {}) {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    stateHash: 'a'.repeat(64),
    phase: 'admin_consent' as const,
    connectionId: CONNECTION_ID,
    orgId: ORG_ID,
    profile: 'customer-graph-read' as const,
    consentAttemptId: ATTEMPT_ID,
    userId: USER_ID,
    tenantHintHash: null,
    nonce: null,
    codeVerifier: null,
    purpose: 'initial' as const,
    flowVersion: 2 as const,
    verifiedTenantId: null,
    verifiedAdminObjectId: null,
    verifiedAdminUsername: null,
    identityVerifiedAt: null,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    createdAt: NOW,
    ...values,
  };
}

const owner = {
  connectionId: CONNECTION_ID,
  orgId: ORG_ID,
  consentAttemptId: ATTEMPT_ID,
  userId: USER_ID,
  profile: 'customer-graph-read' as const,
};

const verified: VerifiedConsentIdentity = {
  tenantId: TENANT_ID,
  administratorObjectId: ADMIN_ID,
  administratorUsername: 'admin@tenant.example',
  verifiedAt: new Date('2026-07-14T15:59:30.000Z'),
};

const FLOW_2_CONDITION = { op: 'eq', column: m365ConsentSessions.flowVersion, value: 2 };

describe('M365 consent sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbMocks.insertResults.length = 0;
    dbMocks.insertedValues.length = 0;
    dbMocks.conflictTargets.length = 0;
    dbMocks.deleteResults.length = 0;
    dbMocks.selectResults.length = 0;
    dbMocks.selectWhere.length = 0;
    dbMocks.selectProjections.length = 0;
  });

  describe('identity-first sessions (flow_version 2)', () => {
    it('creates a flow-2 identity session with a null hint hash for /organizations', async () => {
      const created = await createIdentitySessionInTransaction({ ...owner, expectedTenantId: null });
      const values = dbMocks.insertedValues[0]!;

      expect(values).toMatchObject({
        phase: 'identity_verification',
        flowVersion: 2,
        tenantHintHash: null,
        purpose: 'initial',
        expiresAt: new Date('2026-07-14T16:10:00.000Z'),
      });
      expect(values.codeVerifier).toHaveLength(43);
      expect(Buffer.from(values.codeVerifier as string, 'base64url')).toHaveLength(32);
      expect(Buffer.from(values.nonce as string, 'base64url')).toHaveLength(32);
      expect(created.codeChallenge).toBe(
        createHash('sha256').update(values.codeVerifier as string).digest('base64url'),
      );
      expect(created.nonce).toBe(values.nonce);
      expect(Buffer.from(created.rawState, 'base64url')).toHaveLength(32);
      expect(values.stateHash).toBe(createHash('sha256').update(created.rawState).digest('hex'));
      expect(JSON.stringify(values)).not.toContain(created.rawState);
      expect(contextMocks.runOutside).not.toHaveBeenCalled();
      expect(contextMocks.withSystem).not.toHaveBeenCalled();
    });

    it('hashes the expected tenant when one is pinned and never stores it raw', async () => {
      await createIdentitySessionInTransaction({ ...owner, expectedTenantId: TENANT_ID, purpose: 'upgrade' });
      const values = dbMocks.insertedValues[0]!;

      expect(values.tenantHintHash).toBe(hashTenantHint(TENANT_ID));
      expect(values.purpose).toBe('upgrade');
      expect(JSON.stringify(values)).not.toContain(TENANT_ID);
    });

    it('stores the verified identity on a flow-2 admin_consent row and nothing PKCE-shaped', async () => {
      await insertVerifiedConsentSessionInTransaction({ ...owner, phase: 'admin_consent', verified });

      expect(dbMocks.insertedValues[0]).toMatchObject({
        phase: 'admin_consent',
        flowVersion: 2,
        purpose: 'initial',
        tenantHintHash: null,
        nonce: null,
        codeVerifier: null,
        verifiedTenantId: TENANT_ID,
        verifiedAdminObjectId: ADMIN_ID,
        verifiedAdminUsername: 'admin@tenant.example',
        identityVerifiedAt: verified.verifiedAt,
      });
    });

    it('rotates state: the verified row never reuses the identity state', async () => {
      const identity = await createIdentitySessionInTransaction({ ...owner, expectedTenantId: null });
      const consent = await insertVerifiedConsentSessionInTransaction({ ...owner, phase: 'admin_consent', verified });

      expect(consent.rawState).not.toBe(identity.rawState);
      expect(dbMocks.insertedValues[0]?.stateHash).not.toBe(dbMocks.insertedValues[1]?.stateHash);
    });

    it('regenerates raw state after a state-hash collision', async () => {
      dbMocks.insertResults.push('collision', 'row');

      const result = await insertVerifiedConsentSessionInTransaction({ ...owner, phase: 'admin_consent', verified });

      expect(dbMocks.insertedValues).toHaveLength(2);
      expect(dbMocks.insertedValues[0]?.stateHash).not.toBe(dbMocks.insertedValues[1]?.stateHash);
      expect(dbMocks.insertedValues[1]?.stateHash).toBe(
        createHash('sha256').update(result.rawState).digest('hex'),
      );
      expect(dbMocks.conflictTargets).toEqual([m365ConsentSessions.stateHash, m365ConsentSessions.stateHash]);
    });

    it('rejects a non-canonical expected tenant or verified tenant before any write', async () => {
      await expect(createIdentitySessionInTransaction({ ...owner, expectedTenantId: 'organizations' }))
        .rejects.toThrow('m365_consent_session_invalid');
      await expect(createIdentitySessionInTransaction({ ...owner, expectedTenantId: TENANT_ID.toUpperCase().replace(/5/g, 'A') }))
        .rejects.toThrow('m365_consent_session_invalid');
      await expect(insertVerifiedConsentSessionInTransaction({
        ...owner, phase: 'admin_consent', verified: { ...verified, tenantId: 'common' },
      })).rejects.toThrow('m365_consent_session_invalid');
      expect(dbMocks.insertedValues).toEqual([]);
    });

    it('reads the verified identity only from a complete flow-2 post-identity row', () => {
      const row = sessionRow({
        verifiedTenantId: TENANT_ID,
        verifiedAdminObjectId: ADMIN_ID,
        verifiedAdminUsername: null,
        identityVerifiedAt: verified.verifiedAt,
      });
      expect(verifiedIdentityFromSession(row as never)).toEqual({
        tenantId: TENANT_ID,
        administratorObjectId: ADMIN_ID,
        administratorUsername: null,
        verifiedAt: verified.verifiedAt,
      });
      expect(verifiedIdentityFromSession({ ...row, flowVersion: 1 } as never)).toBeNull();
      expect(verifiedIdentityFromSession({ ...row, verifiedTenantId: null } as never)).toBeNull();
      expect(verifiedIdentityFromSession({ ...row, verifiedAdminObjectId: null } as never)).toBeNull();
      expect(verifiedIdentityFromSession({ ...row, identityVerifiedAt: null } as never)).toBeNull();
      expect(verifiedIdentityFromSession({ ...row, phase: 'identity_verification' } as never)).toBeNull();
    });

    it('no longer exports the admin-consent-first session helpers', () => {
      for (const removed of [
        'createAdminConsentSessionInTransaction',
        'createAdminConsentSession',
        'createIdentityVerificationSession',
        'createIdentityVerificationSessionInTransaction',
        'prepareIdentityVerificationSession',
        'insertPreparedIdentityVerificationSessionInTransaction',
      ]) {
        expect(removed in consentSessionService, removed).toBe(false);
      }
    });
  });

  describe('consent session purpose', () => {
    it('reads a purpose without deleting the session, from flow-2 rows only', async () => {
      // The callback needs the purpose BEFORE it decides which connection
      // statuses are legal; the authoritative consume happens later and
      // re-checks every binding column. This lookup is a router, never an
      // authorization — so it must not consume.
      dbMocks.selectResults.push([{ purpose: 'upgrade' }]);

      const purpose = await readConsentSessionPurpose({
        rawState: 'raw-state',
        phase: 'admin_consent',
        connectionId: CONNECTION_ID,
        consentAttemptId: ATTEMPT_ID,
        profile: 'customer-graph-read',
      });

      expect(purpose).toBe('upgrade');
      expect(dbMocks.deleteWhere).not.toHaveBeenCalled();
      expect(dbMocks.selectWhere[0]).toMatchObject({
        op: 'and',
        conditions: expect.arrayContaining([
          {
            op: 'eq',
            column: m365ConsentSessions.stateHash,
            value: createHash('sha256').update('raw-state').digest('hex'),
          },
          { op: 'eq', column: m365ConsentSessions.consentAttemptId, value: ATTEMPT_ID },
          FLOW_2_CONDITION,
        ]),
      });
    });

    it('returns null when no live session matches', async () => {
      dbMocks.selectResults.push([]);

      await expect(readConsentSessionPurpose({
        rawState: 'raw-state',
        phase: 'admin_consent',
        connectionId: CONNECTION_ID,
        consentAttemptId: ATTEMPT_ID,
        profile: 'customer-graph-read',
      })).resolves.toBeNull();
    });

    it('deletes every session of a connection regardless of attempt', async () => {
      // Used before an attempt-id rotation, which has no ON UPDATE CASCADE: an
      // upgrade session on an executable connection would otherwise raise 23503.
      await deleteConsentSessionsForConnection({
        connectionId: CONNECTION_ID,
        orgId: ORG_ID,
        profile: 'customer-graph-read',
      });

      expect(dbMocks.deleteWhere).toHaveBeenCalledWith({
        op: 'and',
        conditions: [
          { op: 'eq', column: m365ConsentSessions.connectionId, value: CONNECTION_ID },
          { op: 'eq', column: m365ConsentSessions.orgId, value: ORG_ID },
          { op: 'eq', column: m365ConsentSessions.profile, value: 'customer-graph-read' },
        ],
      });
    });
  });

  it('hashes canonical tenant hints as a fixed-width SHA-256 value', () => {
    const expected = createHash('sha256').update(TENANT_ID).digest('hex');

    expect(hashTenantHint(` ${TENANT_ID.toUpperCase()} `)).toBe(expected);
    expect(hashTenantHint(TENANT_ID)).toHaveLength(64);
  });

  it('atomically consumes once using state, phase, expiry, owner, profile, attempt and flow-2 constraints', async () => {
    const rawState = 'one-time-state';
    const stored = sessionRow({
      stateHash: createHash('sha256').update(rawState).digest('hex'),
    });
    dbMocks.deleteResults.push([stored], []);
    const input = {
      rawState,
      phase: 'admin_consent' as const,
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      profile: 'customer-graph-read' as const,
    };

    await expect(consumeConsentSession(input)).resolves.toEqual(stored);
    await expect(consumeConsentSession(input)).resolves.toBeNull();

    expect(dbMocks.deleteWhere).toHaveBeenNthCalledWith(1, {
      op: 'and',
      conditions: [
        {
          op: 'eq', column: m365ConsentSessions.stateHash,
          value: createHash('sha256').update(rawState).digest('hex'),
        },
        { op: 'eq', column: m365ConsentSessions.phase, value: 'admin_consent' },
        FLOW_2_CONDITION,
        {
          op: 'gt', column: m365ConsentSessions.expiresAt,
          value: { op: 'sql', strings: ['now()'], params: [] },
        },
        { op: 'eq', column: m365ConsentSessions.connectionId, value: CONNECTION_ID },
        { op: 'eq', column: m365ConsentSessions.orgId, value: ORG_ID },
        { op: 'eq', column: m365ConsentSessions.profile, value: 'customer-graph-read' },
        { op: 'eq', column: m365ConsentSessions.consentAttemptId, value: ATTEMPT_ID },
      ],
    });
  });

  it('exposes exact session consumption inside an existing system transaction', async () => {
    const stored = sessionRow();
    dbMocks.deleteResults.push([stored]);

    await expect(consumeConsentSessionInTransaction({
      rawState: 'one-time-state',
      phase: 'admin_consent',
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      profile: 'customer-graph-read',
    })).resolves.toEqual(stored);

    expect(contextMocks.runOutside).not.toHaveBeenCalled();
    expect(contextMocks.withSystem).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', { rawState: 'expired' }],
    ['wrong phase', { phase: 'identity_verification' as const }],
    ['wrong connection', { connectionId: '77777777-7777-4777-8777-777777777777' }],
    ['wrong organization', { orgId: '88888888-8888-4888-8888-888888888888' }],
    ['wrong attempt', { consentAttemptId: '99999999-9999-4999-8999-999999999999' }],
  ])('returns null for an %s or mismatched session', async (_label, overrides) => {
    dbMocks.deleteResults.push([]);

    await expect(consumeConsentSession({
      rawState: 'state',
      phase: 'admin_consent',
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      profile: 'customer-graph-read',
      ...overrides,
    })).resolves.toBeNull();
  });

  it('scopes sessions by profile', async () => {
    const { rawState } = await insertVerifiedConsentSessionInTransaction({
      ...owner, profile: 'customer-graph-actions', phase: 'admin_consent', verified,
    });

    expect(dbMocks.insertedValues[0]).toEqual(expect.objectContaining({ profile: 'customer-graph-actions' }));

    dbMocks.deleteResults.push([]);
    expect(await consumeConsentSession({
      connectionId: CONNECTION_ID, orgId: ORG_ID, consentAttemptId: ATTEMPT_ID, rawState, phase: 'admin_consent',
      profile: 'customer-graph-read',
    })).toBeNull();
    expect(dbMocks.deleteWhere).toHaveBeenNthCalledWith(1, expect.objectContaining({
      conditions: expect.arrayContaining([
        { op: 'eq', column: m365ConsentSessions.profile, value: 'customer-graph-read' },
      ]),
    }));
  });

  it('deletes only the fixed-profile sessions owned by an exact attempt', async () => {
    await deleteConsentSessionsForAttempt({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      profile: 'customer-graph-read',
    });

    expect(dbMocks.deleteWhere).toHaveBeenCalledWith({
      op: 'and',
      conditions: [
        { op: 'eq', column: m365ConsentSessions.connectionId, value: CONNECTION_ID },
        { op: 'eq', column: m365ConsentSessions.orgId, value: ORG_ID },
        { op: 'eq', column: m365ConsentSessions.profile, value: 'customer-graph-read' },
        { op: 'eq', column: m365ConsentSessions.consentAttemptId, value: ATTEMPT_ID },
      ],
    });
    expect(contextMocks.runOutside).toHaveBeenCalledOnce();
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
  });

  it('exposes a delete helper that reuses an existing system transaction', async () => {
    await deleteConsentSessionsForAttemptInTransaction({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      profile: 'customer-graph-read',
    });

    expect(contextMocks.runOutside).not.toHaveBeenCalled();
    expect(contextMocks.withSystem).not.toHaveBeenCalled();
  });
});
