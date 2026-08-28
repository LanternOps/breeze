import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  selectRows: [] as Array<Record<string, unknown>>,
  updateRows: [{ familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  verified: null as Record<string, unknown> | null,
}));

const columns = vi.hoisted(() => ({
  familyId: 'familyId',
  userId: 'userId',
  absoluteExpiresAt: 'absoluteExpiresAt',
  revokedAt: 'revokedAt',
  currentRefreshJtiDigest: 'currentRefreshJtiDigest',
  lastUsedAt: 'lastUsedAt',
}));

function queryReturning(rows: Array<Record<string, unknown>>) {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    for: () => query,
    limit: async (count = 1) => rows.slice(0, count),
  };
  return query;
}

function fakeExecutor() {
  return {
    insert: vi.fn(() => ({
      values: async (values: Record<string, unknown>) => {
        harness.inserts.push(values);
      },
    })),
    select: vi.fn(() => queryReturning(harness.selectRows)),
    update: vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        harness.updates.push(values);
        return {
          where: () => ({
            returning: async () => harness.updateRows,
          }),
        };
      },
    })),
  };
}

const systemDb = vi.hoisted(() => ({ current: null as ReturnType<typeof fakeExecutor> | null }));

vi.mock('../db', () => ({
  db: new Proxy({}, {
    get: (_target, property) => {
      const executor = systemDb.current;
      if (!executor) throw new Error('test executor not initialized');
      return executor[property as keyof typeof executor];
    },
  }),
  runOutsideDbContext: (callback: () => unknown) => callback(),
  withSystemDbAccessContext: (callback: () => unknown) => callback(),
}));

vi.mock('../db/schema/refreshTokenFamilies', () => ({ refreshTokenFamilies: columns }));
vi.mock('../db/schema/users', () => ({
  users: {
    id: 'id',
    status: 'status',
    authEpoch: 'authEpoch',
    mfaEpoch: 'mfaEpoch',
  },
}));
vi.mock('drizzle-orm', () => ({
  and: (...values: unknown[]) => ({ and: values }),
  eq: (left: unknown, right: unknown) => ({ eq: [left, right] }),
  isNull: (value: unknown) => ({ isNull: value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));
vi.mock('./jwt', () => ({ verifyToken: vi.fn(async () => harness.verified) }));
vi.mock('./tokenRevocation', () => ({ rememberJtiFamily: vi.fn() }));

import {
  RefreshTokenCurrentnessError,
  classifyRefreshTokenAuthority,
  digestRefreshTokenJti,
  mintRefreshTokenFamily,
  rotateRefreshTokenFamilyCurrentJti,
} from './refreshTokenFamily';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRESENTED_JTI = 'presented-jti';
const SUCCESSOR_JTI = 'successor-jti';
const NOW = new Date('2026-08-23T12:00:00.000Z');

function expectedDigest(jti: string): string {
  return createHash('sha256')
    .update(`auth-refresh-jti:v1\0${jti}`, 'utf8')
    .digest('hex');
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: USER_ID,
    email: 'user@example.test',
    roleId: null,
    orgId: null,
    partnerId: null,
    scope: 'organization',
    type: 'refresh',
    mfa: true,
    fam: FAMILY_ID,
    jti: PRESENTED_JTI,
    aep: 3,
    mep: 5,
    ...overrides,
  };
}

function liveFamily(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    familyId: FAMILY_ID,
    userId: USER_ID,
    revokedAt: null,
    absoluteExpiresAt: new Date('2026-08-24T12:00:00.000Z'),
    currentRefreshJtiDigest: expectedDigest(PRESENTED_JTI),
    databaseNow: NOW,
    status: 'active',
    authEpoch: 3,
    mfaEpoch: 5,
    ...overrides,
  };
}

beforeEach(() => {
  harness.inserts.length = 0;
  harness.selectRows = [];
  harness.updateRows = [{ familyId: FAMILY_ID }];
  harness.updates.length = 0;
  harness.verified = null;
  systemDb.current = fakeExecutor();
  vi.clearAllMocks();
});

describe('mintRefreshTokenFamily rollout overloads', () => {
  it('keeps the frozen one-argument issuer seam and writes a null current digest', async () => {
    await mintRefreshTokenFamily(USER_ID);
    expect(harness.inserts).toHaveLength(1);
    expect(harness.inserts[0]).toMatchObject({
      userId: USER_ID,
      currentRefreshJtiDigest: null,
      absoluteExpiresAt: expect.any(Date),
    });
  });

  it('writes the domain-separated digest with guarded initial issuance', async () => {
    const tx = fakeExecutor();
    await mintRefreshTokenFamily(USER_ID, PRESENTED_JTI, { tx: tx as never });
    expect(harness.inserts[0]).toMatchObject({
      userId: USER_ID,
      currentRefreshJtiDigest: expectedDigest(PRESENTED_JTI),
    });
    expect(digestRefreshTokenJti(PRESENTED_JTI)).toBe(expectedDigest(PRESENTED_JTI));
  });
});

describe('rotateRefreshTokenFamilyCurrentJti', () => {
  it('locks the live owner family, compares the predecessor, and stores its successor', async () => {
    harness.selectRows = [liveFamily()];
    const tx = fakeExecutor();

    await rotateRefreshTokenFamilyCurrentJti(tx as never, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      presentedJti: PRESENTED_JTI,
      successorJti: SUCCESSOR_JTI,
    });

    expect(harness.updates).toEqual([
      expect.objectContaining({
        currentRefreshJtiDigest: expectedDigest(SUCCESSOR_JTI),
      }),
    ]);
  });

  it.each([
    ['wrong current digest', liveFamily({ currentRefreshJtiDigest: expectedDigest('other') })],
    ['wrong owner', liveFamily({ userId: '22222222-2222-4222-8222-222222222222' })],
    ['revoked family', liveFamily({ revokedAt: NOW })],
    ['expired family', liveFamily({ absoluteExpiresAt: NOW })],
  ])('rejects a %s without advancing currentness', async (_name, row) => {
    harness.selectRows = [row];
    const tx = fakeExecutor();
    await expect(rotateRefreshTokenFamilyCurrentJti(tx as never, {
      familyId: FAMILY_ID,
      userId: USER_ID,
      presentedJti: PRESENTED_JTI,
      successorJti: SUCCESSOR_JTI,
    })).rejects.toBeInstanceOf(RefreshTokenCurrentnessError);
    expect(harness.updates).toHaveLength(0);
  });
});

describe('classifyRefreshTokenAuthority', () => {
  it('returns current only for the exact digest with a live owner, epochs, and family', async () => {
    harness.verified = validPayload();
    harness.selectRows = [liveFamily()];
    await expect(classifyRefreshTokenAuthority(fakeExecutor() as never, 'signed-token'))
      .resolves.toEqual({ kind: 'current', userId: USER_ID, familyId: FAMILY_ID });
  });

  it.each([
    ['legacy null currentness', null],
    ['rotated ancestor', expectedDigest('another-jti')],
  ])('returns exact-family-only authority for %s', async (_name, currentRefreshJtiDigest) => {
    harness.verified = validPayload();
    harness.selectRows = [liveFamily({ currentRefreshJtiDigest })];
    await expect(classifyRefreshTokenAuthority(fakeExecutor() as never, 'signed-token'))
      .resolves.toEqual({ kind: 'legacy_or_stale_family', familyId: FAMILY_ID });
  });

  it.each([
    ['malformed token', null, liveFamily()],
    ['access token', validPayload({ type: 'access' }), liveFamily()],
    ['missing family', validPayload({ fam: undefined }), liveFamily()],
    ['wrong owner', validPayload(), null],
    ['revoked family', validPayload(), liveFamily({ revokedAt: NOW })],
    ['expired family', validPayload(), liveFamily({ absoluteExpiresAt: NOW })],
    ['disabled owner', validPayload(), liveFamily({ status: 'disabled' })],
    ['stale auth epoch', validPayload({ aep: 2 }), liveFamily()],
    ['stale mfa epoch', validPayload({ mep: 4 }), liveFamily()],
  ])('returns invalid for %s', async (_name, payload, row) => {
    harness.verified = payload;
    harness.selectRows = row ? [row] : [];
    await expect(classifyRefreshTokenAuthority(fakeExecutor() as never, 'token'))
      .resolves.toEqual({ kind: 'invalid' });
  });
});
