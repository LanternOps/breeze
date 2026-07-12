import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./tokenRevocation', () => ({ revokeAllUserTokens: vi.fn(async () => undefined) }));
vi.mock('./permissions', () => ({ clearPermissionCache: vi.fn(async () => undefined) }));
vi.mock('../oauth/grantRevocation', () => ({
  revokeAllUserOauthArtifacts: vi.fn(async () => ({ grantsRevoked: 1, refreshTokensRevoked: 2, jtisRevoked: 3 })),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import {
  advanceUserEpochs,
  revokeAllRefreshFamilies,
  revokeRefreshFamilyById,
  runPostCommitCleanup,
} from './authLifecycle';
import { revokeAllUserTokens } from './tokenRevocation';
import { clearPermissionCache } from './permissions';
import { revokeAllUserOauthArtifacts } from '../oauth/grantRevocation';
import { captureException } from './sentry';
// NOT mocked — the real pg-core table object, so captured set/where args can be
// compared against the real column references by identity.
import { refreshTokenFamilies } from '../db/schema/refreshTokenFamilies';

function makeTx() {
  const setCalls: Record<string, unknown>[] = [];
  const whereCalls: unknown[] = [];
  const updateTables: unknown[] = [];
  const updateChain = {
    set: (v: Record<string, unknown>) => { setCalls.push(v); return updateChain; },
    where: (w: unknown) => { whereCalls.push(w); return updateChain; },
    returning: () => Promise.resolve([
      { authEpoch: 2, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 1 },
    ]),
    // The revoke* helpers end their chain at .where() and await it — mirror the
    // real Drizzle update builder, which is thenable.
    then: (resolve: (v: unknown) => void) => resolve(undefined),
  };
  const tx = { update: (table: unknown) => { updateTables.push(table); return updateChain; } };
  return { tx: tx as never, setCalls, whereCalls, updateTables };
}

/**
 * Flatten a Drizzle SQL object's literal string chunks so tests can assert the
 * raw SQL text (e.g. that the COALESCE survived). Bound params are surfaced
 * separately via extractParamValues.
 */
function sqlText(v: unknown): string {
  expect(v).toBeInstanceOf(SQL);
  const chunks = (v as SQL).queryChunks as unknown[];
  return chunks
    .map((c) => {
      if (c && typeof c === 'object' && 'value' in c && Array.isArray((c as { value: unknown }).value)) {
        return ((c as { value: string[] }).value).join('');
      }
      return '';
    })
    .join('');
}

/**
 * Bound parameter values embedded in a Drizzle SQL object, in order. Plain
 * sql`` templates keep interpolated primitives as raw chunks; comparison
 * builders like eq() wrap them in Param objects with a `.value`.
 */
function extractParamValues(v: unknown): unknown[] {
  const out: unknown[] = [];
  for (const c of (v as SQL).queryChunks as unknown[]) {
    if (typeof c === 'string' || typeof c === 'number') {
      out.push(c);
    } else if (
      c && typeof c === 'object' && 'value' in c
      && !Array.isArray((c as { value: unknown }).value)
      && !(c instanceof SQL)
    ) {
      out.push((c as { value: unknown }).value);
    }
  }
  return out;
}

describe('advanceUserEpochs', () => {
  it('increments only requested epochs and returns the new row', async () => {
    const { tx, setCalls } = makeTx();
    const result = await advanceUserEpochs(tx, 'u1', { auth: true });
    expect(result.authEpoch).toBe(2);
    // The SET payload must be a server-side SQL increment for auth only — a JS
    // read-modify-write number literal (racy, lost-update-prone) must fail this.
    expect(setCalls.length).toBe(1);
    const set = setCalls[0]!;
    expect(set.authEpoch).toBeInstanceOf(SQL);
    expect(set.mfaEpoch).toBeUndefined();
    expect(set.emailEpoch).toBeUndefined();
    expect(set.passwordResetEpoch).toBeUndefined();
  });
});

describe('revokeAllRefreshFamilies', () => {
  it('stamps revokedAt/revokedReason via COALESCE on refreshTokenFamilies WHERE userId', async () => {
    const { tx, setCalls, whereCalls, updateTables } = makeTx();
    await revokeAllRefreshFamilies(tx, 'user-1', 'password_changed');

    expect(updateTables).toEqual([refreshTokenFamilies]);
    expect(setCalls.length).toBe(1);
    const set = setCalls[0]!;

    // Both stamps must be SQL COALESCE expressions so an already-revoked family
    // keeps its original revocation timestamp/reason. A plain Date / string
    // literal (which would overwrite the audit trail) must fail here.
    expect(set.revokedAt).toBeInstanceOf(SQL);
    expect(sqlText(set.revokedAt)).toBe('COALESCE(revoked_at, now())');
    expect(set.revokedReason).toBeInstanceOf(SQL);
    expect(sqlText(set.revokedReason)).toContain('COALESCE(revoked_reason, ');
    expect(extractParamValues(set.revokedReason)).toEqual(['password_changed']);

    // Scoped by user (ALL the user's families), NOT by familyId.
    expect(whereCalls.length).toBe(1);
    const where = whereCalls[0] as SQL;
    expect(where).toBeInstanceOf(SQL);
    expect(where.queryChunks).toContain(refreshTokenFamilies.userId);
    expect(where.queryChunks).not.toContain(refreshTokenFamilies.familyId);
    expect(extractParamValues(where)).toEqual(['user-1']);
  });

  it('truncates a reason longer than 64 chars before it hits the varchar(64) column', async () => {
    const { tx, setCalls } = makeTx();
    await revokeAllRefreshFamilies(tx, 'user-1', 'x'.repeat(100));
    expect(extractParamValues(setCalls[0]!.revokedReason)).toEqual(['x'.repeat(64)]);
  });
});

describe('revokeRefreshFamilyById', () => {
  it('stamps revokedAt/revokedReason via COALESCE on refreshTokenFamilies WHERE familyId', async () => {
    const { tx, setCalls, whereCalls, updateTables } = makeTx();
    await revokeRefreshFamilyById(tx, 'fam-1', 'logout');

    expect(updateTables).toEqual([refreshTokenFamilies]);
    const set = setCalls[0]!;
    expect(set.revokedAt).toBeInstanceOf(SQL);
    expect(sqlText(set.revokedAt)).toBe('COALESCE(revoked_at, now())');
    expect(set.revokedReason).toBeInstanceOf(SQL);
    expect(sqlText(set.revokedReason)).toContain('COALESCE(revoked_reason, ');
    expect(extractParamValues(set.revokedReason)).toEqual(['logout']);

    // Scoped to the single family, NOT the whole user.
    const where = whereCalls[0] as SQL;
    expect(where).toBeInstanceOf(SQL);
    expect(where.queryChunks).toContain(refreshTokenFamilies.familyId);
    expect(where.queryChunks).not.toContain(refreshTokenFamilies.userId);
    expect(extractParamValues(where)).toEqual(['fam-1']);
  });

  it('truncates a reason longer than 64 chars', async () => {
    const { tx, setCalls } = makeTx();
    await revokeRefreshFamilyById(tx, 'fam-1', 'y'.repeat(65));
    expect(extractParamValues(setCalls[0]!.revokedReason)).toEqual(['y'.repeat(64)]);
  });
});

describe('runPostCommitCleanup', () => {
  beforeEach(() => {
    vi.mocked(captureException).mockClear();
  });

  it('runs all three cleanups and reports success', async () => {
    const result = await runPostCommitCleanup('u1');
    expect(result).toMatchObject({ redisOk: true, permissionCacheOk: true, oauthOk: true });
    expect(result.oauthResult).toMatchObject({ grantsRevoked: 1 });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a Redis failure does not short-circuit the OAuth sweep and is reported, not thrown', async () => {
    vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));
    const result = await runPostCommitCleanup('u1');
    expect(result.redisOk).toBe(false);
    expect(result.oauthOk).toBe(true);
    expect(clearPermissionCache).toHaveBeenCalled();
    expect(revokeAllUserOauthArtifacts).toHaveBeenCalled();
    // Degraded cleanup must surface to Sentry (observable/retryable), not
    // just the console — a Redis cutoff failure leaves a live-JWT window
    // that operators must be able to alert on.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('resolves (never throws) even when ALL THREE cleanups fail, including a synchronous throw', async () => {
    vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));
    // Synchronous throw — not a rejected promise — must be caught too.
    vi.mocked(clearPermissionCache).mockImplementationOnce(() => { throw new Error('sync'); });
    vi.mocked(revokeAllUserOauthArtifacts).mockRejectedValueOnce(new Error('oauth down'));

    const result = await runPostCommitCleanup('u1');
    expect(result).toEqual({ redisOk: false, permissionCacheOk: false, oauthOk: false });
    expect(result.oauthResult).toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(3);
  });
});
