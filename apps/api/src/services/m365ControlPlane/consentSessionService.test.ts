import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks, contextMocks, sessionColumns } = vi.hoisted(() => ({
  dbMocks: {
    insertResults: [] as Array<'row' | 'collision'>,
    insertedValues: [] as Record<string, unknown>[],
    conflictTargets: [] as unknown[],
    deleteResults: [] as unknown[][],
    deleteWhere: vi.fn(),
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
  },
  runOutsideDbContext: contextMocks.runOutside,
  withSystemDbAccessContext: contextMocks.withSystem,
}));

import { m365ConsentSessions } from '../../db/schema';
import {
  consumeConsentSession,
  consumeConsentSessionInTransaction,
  createAdminConsentSession,
  createAdminConsentSessionInTransaction,
  createIdentityVerificationSession,
  insertPreparedIdentityVerificationSessionInTransaction,
  prepareIdentityVerificationSession,
  deleteConsentSessionsForAttempt,
  deleteConsentSessionsForAttemptInTransaction,
  hashTenantHint,
} from './consentSessionService';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '55555555-5555-4555-8555-555555555555';
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
};

describe('M365 consent sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbMocks.insertResults.length = 0;
    dbMocks.insertedValues.length = 0;
    dbMocks.conflictTargets.length = 0;
    dbMocks.deleteResults.length = 0;
  });

  it('stores only the hash of a 32-byte random state with a ten-minute expiry', async () => {
    const result = await createAdminConsentSession(owner);

    expect(Buffer.from(result.rawState, 'base64url')).toHaveLength(32);
    expect(result.session).toMatchObject({
      stateHash: createHash('sha256').update(result.rawState).digest('hex'),
      phase: 'admin_consent',
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      profile: 'customer-graph-read',
      consentAttemptId: ATTEMPT_ID,
      userId: USER_ID,
      tenantHintHash: null,
      nonce: null,
      codeVerifier: null,
      expiresAt: new Date('2026-07-14T16:10:00.000Z'),
    });
    expect(dbMocks.insertedValues).toEqual([expect.objectContaining({
      stateHash: createHash('sha256').update(result.rawState).digest('hex'),
      expiresAt: new Date('2026-07-14T16:10:00.000Z'),
    })]);
    expect(dbMocks.insertedValues[0]).not.toHaveProperty('rawState');
    expect(JSON.stringify(dbMocks.insertedValues[0])).not.toContain(result.rawState);
    expect(dbMocks.conflictTargets).toEqual([m365ConsentSessions.stateHash]);
    expect(contextMocks.runOutside).toHaveBeenCalledOnce();
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
  });

  it('regenerates raw state after a state-hash collision', async () => {
    dbMocks.insertResults.push('collision', 'row');

    const result = await createAdminConsentSession(owner);

    expect(dbMocks.insertedValues).toHaveLength(2);
    expect(dbMocks.insertedValues[0]?.stateHash).not.toBe(dbMocks.insertedValues[1]?.stateHash);
    expect(dbMocks.insertedValues[1]?.stateHash).toBe(
      createHash('sha256').update(result.rawState).digest('hex'),
    );
  });

  it('does not purge unrelated sessions while creating a session', async () => {
    await createAdminConsentSession(owner);

    expect(dbMocks.deleteWhere).not.toHaveBeenCalled();
  });

  it('creates an identity session with a normalized tenant hash, 32-byte nonce, and S256 PKCE', async () => {
    const result = await createIdentityVerificationSession({
      ...owner,
      tenantHint: `  ${TENANT_ID.toUpperCase()}  `,
    });

    expect(Buffer.from(result.rawState, 'base64url')).toHaveLength(32);
    expect(Buffer.from(result.session.nonce!, 'base64url')).toHaveLength(32);
    expect(Buffer.from(result.session.codeVerifier!, 'base64url')).toHaveLength(32);
    expect(result.codeChallenge).toBe(
      createHash('sha256').update(result.session.codeVerifier!).digest('base64url'),
    );
    expect(result.session).toMatchObject({
      phase: 'identity_verification',
      tenantHintHash: hashTenantHint(TENANT_ID),
      expiresAt: new Date('2026-07-14T16:10:00.000Z'),
    });
    expect(dbMocks.insertedValues[0]).toEqual(expect.objectContaining({
      tenantHintHash: hashTenantHint(TENANT_ID),
      nonce: result.session.nonce,
      codeVerifier: result.session.codeVerifier,
    }));
    expect(dbMocks.insertedValues[0]).not.toHaveProperty('tenantHint');
    expect(JSON.stringify(dbMocks.insertedValues[0])).not.toContain(TENANT_ID);
  });

  it('prepares identity artifacts without DB access and inserts those exact artifacts in the caller transaction', async () => {
    const prepared = prepareIdentityVerificationSession({ tenantHint: TENANT_ID });

    expect(dbMocks.insertedValues).toEqual([]);
    expect(contextMocks.runOutside).not.toHaveBeenCalled();
    expect(contextMocks.withSystem).not.toHaveBeenCalled();
    expect(Buffer.from(prepared.rawState, 'base64url')).toHaveLength(32);
    expect(Buffer.from(prepared.nonce, 'base64url')).toHaveLength(32);
    expect(Buffer.from(prepared.codeVerifier, 'base64url')).toHaveLength(32);
    expect(prepared.codeChallenge).toBe(
      createHash('sha256').update(prepared.codeVerifier).digest('base64url'),
    );

    const inserted = await insertPreparedIdentityVerificationSessionInTransaction(owner, prepared);

    expect(inserted.rawState).toBe(prepared.rawState);
    expect(inserted.codeChallenge).toBe(prepared.codeChallenge);
    expect(dbMocks.insertedValues).toEqual([expect.objectContaining({
      stateHash: createHash('sha256').update(prepared.rawState).digest('hex'),
      phase: 'identity_verification',
      tenantHintHash: hashTenantHint(TENANT_ID),
      nonce: prepared.nonce,
      codeVerifier: prepared.codeVerifier,
      expiresAt: prepared.expiresAt,
    })]);
  });

  it('hashes canonical tenant hints as a fixed-width SHA-256 value', () => {
    const expected = createHash('sha256').update(TENANT_ID).digest('hex');

    expect(hashTenantHint(` ${TENANT_ID.toUpperCase()} `)).toBe(expected);
    expect(hashTenantHint(TENANT_ID)).toHaveLength(64);
  });

  it('atomically consumes once using state, phase, expiry, owner, profile, and attempt constraints', async () => {
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
      ...overrides,
    })).resolves.toBeNull();
  });

  it('deletes only the fixed-profile sessions owned by an exact attempt', async () => {
    await deleteConsentSessionsForAttempt({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
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

  it('exposes insert and delete helpers that reuse an existing system transaction', async () => {
    const created = await createAdminConsentSessionInTransaction(owner);
    await deleteConsentSessionsForAttemptInTransaction({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
    });

    expect(created.session.phase).toBe('admin_consent');
    expect(contextMocks.runOutside).not.toHaveBeenCalled();
    expect(contextMocks.withSystem).not.toHaveBeenCalled();
  });
});
