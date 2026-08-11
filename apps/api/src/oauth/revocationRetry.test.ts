import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeGrant, revokeJti } from './revocationCache';
import {
  buildRetryConflictUpdate,
  writeOAuthRevocationMarkerDurably,
  type DbTransaction,
} from './revocationRetry';

vi.mock('./revocationCache', () => ({
  revokeGrant: vi.fn(async () => undefined),
  revokeJti: vi.fn(async () => undefined),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

function fakeTransaction(returningRows: unknown[] = [{ userId: USER_ID }]) {
  const returning = vi.fn(async () => returningRows);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return {
    tx: { insert } as unknown as DbTransaction,
    insert,
    values,
    onConflictDoUpdate,
    returning,
  };
}

describe('writeOAuthRevocationMarkerDurably', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the requested marker with its exact remaining lifetime and creates no retry row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
    const fake = fakeTransaction();

    await expect(writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'grant-secret',
      expiresAt: new Date('2026-08-06T00:02:00.000Z'),
    })).resolves.toEqual({ status: 'written' });

    expect(revokeGrant).toHaveBeenCalledWith('grant-secret', 120);
    expect(revokeJti).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('queues one exact-user retry intent when Redis is unavailable', async () => {
    vi.mocked(revokeJti).mockRejectedValueOnce(new Error('OAuth revocation cache unavailable'));
    const fake = fakeTransaction();

    await expect(writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'jti',
      markerId: 'jti-secret',
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toEqual({ status: 'retry_queued', errorCode: 'redis_unavailable' });

    expect(fake.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      markerType: 'jti',
      markerId: 'jti-secret',
      attempts: 1,
      lastErrorCode: 'redis_unavailable',
    }));
  });

  it('uses an ownership-preserving incomplete-marker upsert for repeated failures', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('write failed'));
    const fake = fakeTransaction();

    await writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'grant-secret',
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(fake.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.any(Array),
      targetWhere: expect.anything(),
      set: expect.objectContaining({
        attempts: expect.anything(),
        nextAttemptAt: expect.anything(),
        lastErrorCode: 'redis_write_failed',
      }),
      setWhere: expect.anything(),
    }));
  });

  it('fails closed when an incomplete marker belongs to another user', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('write failed'));
    const fake = fakeTransaction([]);

    await expect(writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: OTHER_USER_ID,
      markerType: 'grant',
      markerId: 'already-owned-marker',
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow(/owner/i);
  });

  it('fails closed when the durable enqueue itself fails', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('write failed'));
    const fake = fakeTransaction();
    fake.returning.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'grant-secret',
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow('database unavailable');
  });

  it('does not log marker identifiers on failure', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('write failed'));
    const fake = fakeTransaction();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'never-log-this-marker',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const serializedLogs = JSON.stringify([
      ...consoleError.mock.calls,
      ...consoleWarn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain('never-log-this-marker');
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });
});

describe('buildRetryConflictUpdate (#3369)', () => {
  const dialect = new PgDialect();
  const ATTEMPTED_AT = new Date('2026-08-10T06:14:42.123Z');
  const EXPIRES_AT = new Date('2026-08-10T07:00:00.000Z');

  const update = () => buildRetryConflictUpdate({
    attemptedAt: ATTEMPTED_AT,
    expiresAt: EXPIRES_AT,
    errorCode: 'redis_unavailable',
  });

  /**
   * The bug: both timestamps were interpolated bare into `sql` templates, so
   * Drizzle bound them with the NOOP encoder and postgres.js received live
   * `Date` objects, throwing ERR_INVALID_ARG_TYPE at Bind.
   *
   * The severity is in *which* branch this is. `onConflictDoUpdate` fires only
   * when an open retry row already exists — i.e. exactly when a prior Redis
   * revocation write failed. `jobs/oauthRevocationRetryWorker.ts` re-runs those
   * rows every 30s, so the throw rolled back the whole
   * `withSystemDbAccessContext` batch and was swallowed by the generic `.catch`
   * in `runScheduledDrain`. The revocation retry queue could therefore never
   * drain or heal during a Redis outage, silently.
   */
  it.each(['nextAttemptAt', 'expiresAt'] as const)('binds no raw Date in %s', (key) => {
    const { params } = dialect.sqlToQuery(update()[key]);

    expect(params.length).toBeGreaterThan(0);
    for (const param of params) expect(param).not.toBeInstanceOf(Date);
  });

  it('casts both timestamps to timestamptz so the arithmetic and GREATEST resolve', () => {
    // Unlike the device filter columns, `oauth_revocation_retries.expires_at` /
    // `next_attempt_at` really are `timestamptz`, and neither context can infer
    // the parameter's type: `$1 + interval` has no unique operator resolution,
    // and GREATEST would resolve off its other argument.
    const next = dialect.sqlToQuery(update().nextAttemptAt);
    const expires = dialect.sqlToQuery(update().expiresAt);

    expect(next.sql).toContain('::timestamptz');
    expect(next.params).toContain(ATTEMPTED_AT.toISOString());
    expect(expires.sql).toContain('::timestamptz');
    expect(expires.params).toContain(EXPIRES_AT.toISOString());
  });

  it('backs off exponentially, capped at 300s, and never shortens the marker lifetime', () => {
    const next = dialect.sqlToQuery(update().nextAttemptAt).sql;
    const expires = dialect.sqlToQuery(update().expiresAt).sql;
    const attempts = dialect.sqlToQuery(update().attempts).sql;

    expect(next).toContain('LEAST(300');
    expect(next).toContain('POWER(2');
    expect(next).toContain("interval '1 second'");
    // GREATEST(existing, incoming): a later retry must never pull the marker's
    // expiry in, or the defense-in-depth marker would lapse early.
    expect(expires).toContain('GREATEST');
    expect(expires).toContain('"expires_at"');
    expect(attempts).toContain('+ 1');
  });

  it('is what the conflict branch actually installs', async () => {
    // Guards against the extraction drifting from its only caller.
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('redis is required'));
    const fake = fakeTransaction();

    await writeOAuthRevocationMarkerDurably(fake.tx, {
      userId: USER_ID,
      markerType: 'grant',
      markerId: 'grant-secret',
      expiresAt: EXPIRES_AT,
    });

    // The mock records untyped args; the shape is asserted, not assumed.
    const [conflictArgs] = fake.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: Record<string, SQL<unknown>> },
    ];
    const set = conflictArgs.set;
    expect(Object.keys(set).sort()).toEqual(Object.keys(update()).sort());
    for (const key of ['nextAttemptAt', 'expiresAt'] as const) {
      const fragment = set[key];
      expect(fragment, `missing ${key}`).toBeDefined();
      for (const param of dialect.sqlToQuery(fragment!).params) {
        expect(param).not.toBeInstanceOf(Date);
      }
    }
  });
});
