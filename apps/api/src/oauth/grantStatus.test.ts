import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { oauthAuthorizationCodes, oauthGrants, oauthRefreshTokens } from '../db/schema';
import {
  activeGrantCondition,
  isOAuthGrantActiveInCurrentDbContext,
  revokeGrantsDurablyInCurrentDbContext,
} from './grantStatus';

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

const selectMock = vi.mocked(db.select);
const updateMock = vi.mocked(db.update);

/** Every `db.update(...)` issued, in order, with its table and set/where args. */
function captureUpdates() {
  const calls: { table: unknown; set: unknown; where: unknown }[] = [];
  updateMock.mockImplementation(((table: unknown) => {
    const entry: { table: unknown; set: unknown; where: unknown } = { table, set: undefined, where: undefined };
    calls.push(entry);
    return {
      set: (value: unknown) => {
        entry.set = value;
        return {
          where: async (clause: unknown) => {
            entry.where = clause;
            return [];
          },
        };
      },
    };
  }) as unknown as typeof db.update);
  return calls;
}

function mockSelectRow(row: unknown) {
  const where = vi.fn(async () => (row === undefined ? [] : [row]));
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where };
}

/**
 * Reduce a drizzle clause to the columns it names and the literal SQL it
 * renders, so a predicate can be asserted structurally rather than by a
 * string match on the whole statement (which would also match bound values).
 */
function inspectClause(clause: unknown): { columns: string[]; sql: string } {
  const columns: string[] = [];
  const fragments: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      chunks.forEach(visit);
      return;
    }
    const { name, table, value } = node as { name?: unknown; table?: unknown; value?: unknown };
    if (typeof name === 'string' && table) {
      columns.push(name);
      return;
    }
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      fragments.push(...(value as string[]));
    }
  };
  visit(clause);
  return { columns, sql: fragments.join('').toLowerCase().replace(/\s+/g, ' ') };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('activeGrantCondition', () => {
  it('requires the exact id, an unrevoked row and an unexpired row', () => {
    const { columns, sql } = inspectClause(activeGrantCondition('grant-1', new Date()));

    expect(columns).toEqual(expect.arrayContaining([
      oauthGrants.id.name,
      oauthGrants.revokedAt.name,
      oauthGrants.expiresAt.name,
    ]));
    expect(sql).toContain('is null');
    expect(sql).toContain('>=');
    // `revoked_at IS NOT NULL` / `expires_at <= now` would touch the same
    // columns and invert the meaning, so pin the direction too.
    expect(sql).not.toContain('is not null');
    expect(sql).not.toContain('<=');
  });
});

describe('isOAuthGrantActiveInCurrentDbContext', () => {
  it('is true only when the active predicate returns the row', async () => {
    mockSelectRow({ id: 'grant-1' });
    await expect(isOAuthGrantActiveInCurrentDbContext('grant-1')).resolves.toBe(true);

    mockSelectRow(undefined);
    await expect(isOAuthGrantActiveInCurrentDbContext('grant-1')).resolves.toBe(false);
  });
});

describe('revokeGrantsDurablyInCurrentDbContext', () => {
  it('is a no-op on an empty grant list', async () => {
    const updates = captureUpdates();

    await revokeGrantsDurablyInCurrentDbContext({ grantIds: [], reason: 'noop' });

    expect(updates).toHaveLength(0);
  });

  it('consumes live authorization codes BEFORE stamping revoked_at', async () => {
    // Order is the whole point: a Grant stamped revoked while a live code is
    // still unconsumed reads as dead in the DB but can still mint a successor
    // family through the code-exchange path.
    const updates = captureUpdates();

    await revokeGrantsDurablyInCurrentDbContext({ grantIds: ['g1', 'g2'], reason: 'disconnect' });

    expect(updates.map((u) => u.table)).toEqual([oauthAuthorizationCodes, oauthGrants]);

    const codes = updates[0]!;
    expect(codes.set).toEqual(expect.objectContaining({ consumedAt: expect.any(Date) }));
    // The provider reads `payload.consumed` to fire its own replay handling,
    // so the canonical payload stamp must travel with consumed_at.
    expect(inspectClause((codes.set as { payload?: unknown }).payload).sql).toContain('jsonb_set');
    const codeWhere = inspectClause(codes.where);
    expect(codeWhere.columns).toEqual(expect.arrayContaining([
      oauthAuthorizationCodes.consumedAt.name,
      oauthAuthorizationCodes.expiresAt.name,
    ]));
    expect(codeWhere.sql).toContain('is null');
  });

  it('stamps revoked_at only on Grants that are not already revoked', async () => {
    const updates = captureUpdates();

    await revokeGrantsDurablyInCurrentDbContext({ grantIds: ['g1'], reason: 'refresh-token-reuse' });

    const grantUpdate = updates.find((u) => u.table === oauthGrants);
    expect(grantUpdate?.set).toEqual({ revokedAt: expect.any(Date), revokedReason: 'refresh-token-reuse' });
    const where = inspectClause(grantUpdate?.where);
    expect(where.columns).toEqual(expect.arrayContaining([oauthGrants.id.name, oauthGrants.revokedAt.name]));
    // Re-stamping would overwrite the first revocation's reason and timestamp.
    expect(where.sql).toContain('is null');
  });

  it('records revoked_by_user_id only when the caller supplies an actor', async () => {
    const withActor = captureUpdates();
    await revokeGrantsDurablyInCurrentDbContext({ grantIds: ['g1'], reason: 'r', revokedByUserId: 'user-1' });
    expect(withActor.find((u) => u.table === oauthGrants)?.set).toEqual(
      expect.objectContaining({ revokedByUserId: 'user-1' }),
    );

    vi.clearAllMocks();
    const withoutActor = captureUpdates();
    await revokeGrantsDurablyInCurrentDbContext({ grantIds: ['g1'], reason: 'r' });
    expect(withoutActor.find((u) => u.table === oauthGrants)?.set).not.toHaveProperty('revokedByUserId');
  });

  it('cascades to sibling refresh tokens by payload grantId when asked', async () => {
    const updates = captureUpdates();

    await revokeGrantsDurablyInCurrentDbContext({
      grantIds: ['g1'],
      reason: 'refresh-token-reuse',
      cascadeRefreshTokens: true,
    });

    expect(updates.map((u) => u.table)).toEqual([
      oauthAuthorizationCodes,
      oauthRefreshTokens,
      oauthGrants,
    ]);
    const refresh = updates[1]!;
    expect(refresh.set).toEqual({ revokedAt: expect.any(Date) });
    const where = inspectClause(refresh.where);
    expect(where.columns).toContain(oauthRefreshTokens.revokedAt.name);
    expect(where.sql).toContain("->>'grantid'");
    expect(where.sql).toContain('is null');
  });

  it('leaves sibling refresh tokens alone when the caller revokes explicit ids itself', async () => {
    const updates = captureUpdates();

    await revokeGrantsDurablyInCurrentDbContext({ grantIds: ['g1'], reason: 'scoped-disconnect' });

    expect(updates.map((u) => u.table)).not.toContain(oauthRefreshTokens);
  });
});
