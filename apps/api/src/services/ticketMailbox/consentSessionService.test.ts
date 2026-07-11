import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks, generatorMocks, contextMocks } = vi.hoisted(() => ({
  dbMocks: {
    insertResults: [] as unknown[][],
    insertedValues: [] as Record<string, unknown>[],
    conflictTargets: [] as unknown[],
    deleteResults: [] as unknown[][],
    deleteWhere: vi.fn(),
  },
  generatorMocks: {
    generateState: vi.fn(),
    generateNonce: vi.fn(),
    generatePKCEChallenge: vi.fn(),
  },
  contextMocks: {
    runOutside: vi.fn(<T>(fn: () => T) => fn()),
    withSystem: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  },
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        dbMocks.insertedValues.push(values);
        return {
          onConflictDoNothing: vi.fn(({ target }: { target: unknown }) => {
            dbMocks.conflictTargets.push(target);
            return {
              returning: vi.fn(async () => dbMocks.insertResults.shift() ?? []),
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

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return {
    ...actual,
    and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
    eq: vi.fn((column: unknown, value: unknown) => ({ op: 'eq', column, value })),
    gt: vi.fn((column: unknown, value: unknown) => ({ op: 'gt', column, value })),
    sql: vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => ({
      op: 'sql', strings: [...strings], params,
    })),
  };
});

vi.mock('../sso', () => generatorMocks);

import { ticketMailboxConsentSessions } from '../../db/schema';
import {
  consumeConsentSession,
  createAdminConsentSession,
  createIdentityVerificationSession,
} from './consentSessionService';

const PARTNER_ID = '11111111-1111-1111-1111-111111111111';
const CONNECTION_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const TENANT_ID = '44444444-4444-4444-4444-444444444444';
const NOW = new Date('2026-07-11T12:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    state: 'state-1',
    phase: 'admin_consent',
    partnerId: PARTNER_ID,
    connectionId: CONNECTION_ID,
    userId: USER_ID,
    tenantHint: null,
    nonce: null,
    codeVerifier: null,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    createdAt: NOW,
    ...overrides,
  };
}

describe('ticket mailbox consent sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dbMocks.insertResults.length = 0;
    dbMocks.insertedValues.length = 0;
    dbMocks.conflictTargets.length = 0;
    dbMocks.deleteResults.length = 0;
    generatorMocks.generateState.mockReset();
    generatorMocks.generateState.mockReturnValue('state-1');
    generatorMocks.generateNonce.mockReset();
    generatorMocks.generateNonce.mockReturnValue('nonce-1');
    generatorMocks.generatePKCEChallenge.mockReset();
    generatorMocks.generatePKCEChallenge.mockReturnValue({
      codeVerifier: 'verifier-1', codeChallenge: 'challenge-1', codeChallengeMethod: 'S256',
    });
  });

  it('creates a ten-minute admin-consent session in system context', async () => {
    dbMocks.insertResults.push([row()]);

    await expect(createAdminConsentSession({
      partnerId: PARTNER_ID, connectionId: CONNECTION_ID, userId: USER_ID,
    })).resolves.toEqual(expect.objectContaining({
      state: 'state-1', phase: 'admin_consent', partnerId: PARTNER_ID,
      connectionId: CONNECTION_ID, userId: USER_ID, tenantHint: null,
      nonce: null, codeVerifier: null,
      expiresAt: new Date('2026-07-11T12:10:00.000Z'),
    }));
    expect(dbMocks.insertedValues).toEqual([expect.objectContaining({
      state: 'state-1', phase: 'admin_consent', expiresAt: new Date('2026-07-11T12:10:00.000Z'),
    })]);
    expect(dbMocks.conflictTargets).toEqual([ticketMailboxConsentSessions.state]);
    expect(contextMocks.runOutside).toHaveBeenCalledOnce();
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
  });

  it('regenerates state when a unique-state collision prevents insertion', async () => {
    generatorMocks.generateState.mockReturnValueOnce('colliding-state').mockReturnValueOnce('fresh-state');
    dbMocks.insertResults.push([], [row({ state: 'fresh-state' })]);

    const session = await createAdminConsentSession({
      partnerId: PARTNER_ID, connectionId: CONNECTION_ID, userId: null,
    });

    expect(session.state).toBe('fresh-state');
    expect(generatorMocks.generateState).toHaveBeenCalledTimes(2);
    expect(dbMocks.insertedValues.map((value) => value.state)).toEqual(['colliding-state', 'fresh-state']);
  });

  it('creates an identity-verification session with tenant hint, nonce, and PKCE verifier', async () => {
    dbMocks.insertResults.push([row({
      phase: 'identity_verification', tenantHint: TENANT_ID,
      nonce: 'nonce-1', codeVerifier: 'verifier-1',
    })]);

    const result = await createIdentityVerificationSession({
      partnerId: PARTNER_ID, connectionId: CONNECTION_ID, userId: USER_ID, tenantHint: TENANT_ID,
    });

    expect(result).toEqual({
      session: expect.objectContaining({
        phase: 'identity_verification', tenantHint: TENANT_ID,
        nonce: 'nonce-1', codeVerifier: 'verifier-1',
      }),
      codeChallenge: 'challenge-1',
    });
    expect(dbMocks.insertedValues[0]).toEqual(expect.objectContaining({
      tenantHint: TENANT_ID, nonce: 'nonce-1', codeVerifier: 'verifier-1',
    }));
  });

  it('atomically consumes a matching unexpired session only once', async () => {
    dbMocks.deleteResults.push([row()], []);

    const first = await consumeConsentSession('state-1', 'admin_consent');
    const replay = await consumeConsentSession('state-1', 'admin_consent');

    expect(first).toMatchObject({
      partnerId: PARTNER_ID, connectionId: CONNECTION_ID,
      userId: USER_ID, phase: 'admin_consent',
    });
    expect(replay).toBeNull();
    expect(dbMocks.deleteWhere).toHaveBeenCalledTimes(2);
    expect(dbMocks.deleteWhere).toHaveBeenNthCalledWith(1, {
      op: 'and',
      conditions: [
        { op: 'eq', column: ticketMailboxConsentSessions.state, value: 'state-1' },
        { op: 'eq', column: ticketMailboxConsentSessions.phase, value: 'admin_consent' },
        {
          op: 'gt',
          column: ticketMailboxConsentSessions.expiresAt,
          value: { op: 'sql', strings: ['now()'], params: [] },
        },
      ],
    });
  });

  it.each([
    ['expired', 'expired-state', 'admin_consent'],
    ['wrong phase', 'state-1', 'identity_verification'],
  ] as const)('returns null for an %s session', async (_label, state, phase) => {
    dbMocks.deleteResults.push([]);

    await expect(consumeConsentSession(state, phase)).resolves.toBeNull();

    expect(dbMocks.deleteWhere).toHaveBeenCalledOnce();
    expect(contextMocks.runOutside).toHaveBeenCalledOnce();
    expect(contextMocks.withSystem).toHaveBeenCalledOnce();
  });
});
