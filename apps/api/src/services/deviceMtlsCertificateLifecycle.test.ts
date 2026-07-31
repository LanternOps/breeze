import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromEnvMock, revokeCertificateMock, captureExceptionMock, queueAddMock } = vi.hoisted(() => ({
  fromEnvMock: vi.fn(),
  revokeCertificateMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  queueAddMock: vi.fn(async (_name: string, _data: unknown, _opts?: Record<string, unknown>) => undefined),
}));

vi.mock('../db', () => {
  const dbMock: { select: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; transaction: ReturnType<typeof vi.fn> } = {
    select: vi.fn(),
    update: vi.fn(),
    // `db.transaction(fn)` just invokes `fn` with the SAME mocked db object as
    // `tx` — queueCertificateRevocationCore's tx.select/tx.update calls then
    // hit the exact same mockSelectOnce/mockUpdate wiring the rest of this
    // file already uses.
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbMock)),
  };
  return {
    db: dbMock,
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('./cloudflareMtls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cloudflareMtls')>();
  return {
    ...actual,
    CloudflareMtlsService: { fromEnv: fromEnvMock },
  };
});

vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: () => ({ add: queueAddMock }),
}));

vi.mock('./sentry', () => ({
  captureException: captureExceptionMock,
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: vi.fn(actual.eq) };
});

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { eq } from 'drizzle-orm';
import { CloudflareMtlsError } from './cloudflareMtls';
import {
  attemptCertificateRevocation,
  computeNextRevokeAttemptAt,
  enqueueCertificateRevocationJob,
  queueCertificateRevocation,
  queueCertificateRevocationCore,
  revokeCertificateNowOrEnqueue,
  __resetMtlsCertificateRevocationQueueForTests,
} from './deviceMtlsCertificateLifecycle';

const OLD_CERT_ID = '11111111-1111-4111-8111-111111111111';
const NEW_CERT_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const SENSITIVE_PROVIDER_ID = 'cf-provider-id-should-never-leak';

function pendingRevocationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: OLD_CERT_ID,
    state: 'pending_revocation',
    providerCertificateId: SENSITIVE_PROVIDER_ID,
    revokeAttempts: 0,
    ...overrides,
  };
}

/** Builds a select-chain mock result usable both as `await .limit(n)` (a plain
 * array is not thenable, so awaiting it just returns itself) and as
 * `await .limit(n).for('update')`. */
function mockSelectOnce(rows: unknown[]) {
  const resultArray = rows as unknown[] & { for?: ReturnType<typeof vi.fn> };
  const forUpdate = vi.fn(async () => rows);
  resultArray.for = forUpdate;
  const limit = vi.fn(() => resultArray);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  vi.mocked(db.select).mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where, limit, forUpdate };
}

function mockUpdate() {
  const returning = vi.fn(async (): Promise<unknown[]> => []);
  const where = vi.fn(() => ({ returning })) as unknown as ReturnType<typeof vi.fn> & { mockResolvedValueImpl?: never };
  // where() must ALSO be awaitable directly (no .returning() call) for the
  // plain revoke/backoff updates — attach a resolved-promise `then` isn't
  // straightforward on a function, so make `where` return a thenable object.
  const whereResult: Record<string, unknown> & { then: (resolve: (v: undefined) => void) => void } = {
    returning,
    then: (resolve: (v: undefined) => void) => resolve(undefined),
  };
  const whereFn = vi.fn(() => whereResult);
  const set = vi.fn((_payload: Record<string, unknown>) => ({ where: whereFn }));
  vi.mocked(db.update).mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);
  return { set, where: whereFn, returning };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetMtlsCertificateRevocationQueueForTests();
  vi.mocked(runOutsideDbContext).mockImplementation((fn: () => unknown) => fn() as never);
  vi.mocked(withSystemDbAccessContext).mockImplementation(
    (async (fn: () => Promise<unknown>) => fn()) as never,
  );
  fromEnvMock.mockReturnValue({ revokeCertificate: revokeCertificateMock });
  queueAddMock.mockResolvedValue(undefined);
});

describe('computeNextRevokeAttemptAt', () => {
  it('is 60s for the first failure (priorAttempts=0)', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(computeNextRevokeAttemptAt(0, now).getTime() - now.getTime()).toBe(60_000);
  });

  it('doubles per prior attempt', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(computeNextRevokeAttemptAt(1, now).getTime() - now.getTime()).toBe(120_000);
    expect(computeNextRevokeAttemptAt(2, now).getTime() - now.getTime()).toBe(240_000);
  });

  it('caps at 24 hours', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(computeNextRevokeAttemptAt(20, now).getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('attemptCertificateRevocation', () => {
  it('marks the row revoked on an inline 2xx ("revoked")', async () => {
    mockSelectOnce([pendingRevocationRow()]);
    const update = mockUpdate();
    revokeCertificateMock.mockResolvedValue('revoked');

    await expect(attemptCertificateRevocation(OLD_CERT_ID)).resolves.toEqual({ outcome: 'revoked' });

    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      state: 'revoked',
      revokedAt: expect.any(Date),
      lastRevokeError: null,
    }));
  });

  it('marks the row revoked on an inline 404 ("not_found")', async () => {
    mockSelectOnce([pendingRevocationRow()]);
    const update = mockUpdate();
    revokeCertificateMock.mockResolvedValue('not_found');

    await expect(attemptCertificateRevocation(OLD_CERT_ID)).resolves.toEqual({ outcome: 'not_found' });
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'revoked' }));
  });

  it('returns success (no provider call) for an already-revoked row', async () => {
    mockSelectOnce([pendingRevocationRow({ state: 'revoked' })]);

    await expect(attemptCertificateRevocation(OLD_CERT_ID)).resolves.toEqual({ outcome: 'already_revoked' });
    expect(revokeCertificateMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a row that is not pending_revocation (e.g. active)', async () => {
    mockSelectOnce([pendingRevocationRow({ state: 'active' })]);

    await expect(attemptCertificateRevocation(OLD_CERT_ID)).resolves.toEqual({ outcome: 'not_applicable' });
    expect(revokeCertificateMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the row does not exist', async () => {
    mockSelectOnce([]);

    await expect(attemptCertificateRevocation(OLD_CERT_ID)).resolves.toEqual({ outcome: 'not_applicable' });
  });

  for (const [label, error] of [
    ['timeout', new CloudflareMtlsError('revoke', undefined, true, 'x')],
    ['rate_limited (429)', new CloudflareMtlsError('revoke', 429, true, 'x')],
    ['provider_5xx', new CloudflareMtlsError('revoke', 503, true, 'x')],
  ] as const) {
    it(`durably falls back (stays pending_revocation, schedules backoff) on ${label}`, async () => {
      mockSelectOnce([pendingRevocationRow({ revokeAttempts: 0 })]);
      const update = mockUpdate();
      revokeCertificateMock.mockRejectedValue(error);

      const outcome = await attemptCertificateRevocation(OLD_CERT_ID);
      expect(outcome.outcome).toBe('retry_scheduled');
      expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
        revokeAttempts: 1,
        nextRevokeAttemptAt: expect.any(Date),
      }));
      // never a raw message, never the provider id — only the bounded category.
      const setPayload = update.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(['timeout', 'rate_limited', 'provider_5xx', 'provider_4xx']).toContain(setPayload.lastRevokeError);
      expect(JSON.stringify(setPayload)).not.toContain(SENSITIVE_PROVIDER_ID);
    });
  }

  it('sanitizes a non-retryable provider 4xx the same way (still pending_revocation + backoff)', async () => {
    mockSelectOnce([pendingRevocationRow({ revokeAttempts: 2 })]);
    const update = mockUpdate();
    revokeCertificateMock.mockRejectedValue(new CloudflareMtlsError('revoke', 400, false, 'bad request detail xyz'));

    const outcome = await attemptCertificateRevocation(OLD_CERT_ID);
    expect(outcome.outcome).toBe('retry_scheduled');
    const setPayload = update.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(setPayload.lastRevokeError).toBe('provider_4xx');
    expect(JSON.stringify(setPayload)).not.toContain('bad request detail xyz');
  });
});

describe('revokeCertificateNowOrEnqueue', () => {
  it('completes immediately on revoked/not_found without enqueueing anything', async () => {
    mockSelectOnce([pendingRevocationRow()]);
    mockUpdate();
    revokeCertificateMock.mockResolvedValue('revoked');

    await revokeCertificateNowOrEnqueue(OLD_CERT_ID);

    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('enqueues a durable retry job (keyed only by the history-row UUID) on failure', async () => {
    mockSelectOnce([pendingRevocationRow()]);
    mockUpdate();
    revokeCertificateMock.mockRejectedValue(new CloudflareMtlsError('revoke', 503, true, 'x'));

    await revokeCertificateNowOrEnqueue(OLD_CERT_ID);

    expect(queueAddMock).toHaveBeenCalledWith(
      'revoke',
      { certificateId: OLD_CERT_ID },
      expect.objectContaining({ jobId: expect.stringMatching(/^[^:]+$/) }),
    );
    // jobId must not contain a colon (repo-wide BullMQ rule).
    const jobId = (queueAddMock.mock.calls[0]![2] as { jobId: string }).jobId;
    expect(jobId).not.toContain(':');
  });

  it('passes a BullMQ delay matching the computed backoff on the inline-failure enqueue (IMPORTANT 1) — first retry is NOT immediate', async () => {
    mockSelectOnce([pendingRevocationRow({ revokeAttempts: 0 })]);
    mockUpdate();
    revokeCertificateMock.mockRejectedValue(new CloudflareMtlsError('revoke', 503, true, 'x'));

    await revokeCertificateNowOrEnqueue(OLD_CERT_ID);

    const opts = queueAddMock.mock.calls[0]![2] as { delay?: number };
    expect(opts.delay).toBeDefined();
    // First failure (priorAttempts=0) backs off ~60s — allow scheduling slop.
    expect(opts.delay).toBeGreaterThan(55_000);
    expect(opts.delay).toBeLessThanOrEqual(60_000);
  });

  it('on Redis enqueue failure after the DB commit, forces next_revoke_attempt_at to now so the sweep repairs the handoff', async () => {
    mockSelectOnce([pendingRevocationRow()]);
    const firstUpdate = mockUpdate();
    revokeCertificateMock.mockRejectedValue(new CloudflareMtlsError('revoke', 503, true, 'x'));
    queueAddMock.mockRejectedValueOnce(new Error('redis connection refused'));

    const beforeCall = Date.now();
    await revokeCertificateNowOrEnqueue(OLD_CERT_ID);

    // Two updates: (1) schedule the computed backoff, (2) repair-write forcing
    // next_revoke_attempt_at <= now().
    expect(firstUpdate.set).toHaveBeenCalledTimes(2);
    const repairPayload = firstUpdate.set.mock.calls[1]![0] as { nextRevokeAttemptAt: Date };
    expect(repairPayload.nextRevokeAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(repairPayload.nextRevokeAttemptAt.getTime()).toBeGreaterThanOrEqual(beforeCall - 1000);
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('a failed inline revoke never references any row id other than the one being revoked', async () => {
    mockSelectOnce([pendingRevocationRow()]);
    mockUpdate();
    revokeCertificateMock.mockRejectedValue(new CloudflareMtlsError('revoke', 503, true, 'x'));

    await revokeCertificateNowOrEnqueue(OLD_CERT_ID);

    const idArgsSeen = vi.mocked(eq).mock.calls
      .filter(([, value]) => typeof value === 'string')
      .map(([, value]) => value);
    expect(idArgsSeen).toContain(OLD_CERT_ID);
    expect(idArgsSeen).not.toContain(NEW_CERT_ID);
  });
});

describe('queueCertificateRevocation', () => {
  it('demotes active -> pending_revocation when a replacement (pending_activation/active) exists', async () => {
    mockSelectOnce([{ id: OLD_CERT_ID, deviceId: DEVICE_ID, state: 'active' }]);
    mockSelectOnce([{ id: NEW_CERT_ID }]);
    const update = mockUpdate();
    update.returning.mockResolvedValue([{ id: OLD_CERT_ID }]);

    await expect(queueCertificateRevocation(OLD_CERT_ID)).resolves.toBe(true);
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'pending_revocation' }));
  });

  it('CRITICAL regression: the demotion write sets nextRevokeAttemptAt (no DB default; NULL never matches the sweep\'s lte due-query, so a crash right after this commit would otherwise strand the row invisibly)', async () => {
    mockSelectOnce([{ id: OLD_CERT_ID, deviceId: DEVICE_ID, state: 'active' }]);
    mockSelectOnce([{ id: NEW_CERT_ID }]);
    const update = mockUpdate();
    update.returning.mockResolvedValue([{ id: OLD_CERT_ID }]);

    const before = Date.now();
    await queueCertificateRevocation(OLD_CERT_ID);
    const after = Date.now();

    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      state: 'pending_revocation',
      nextRevokeAttemptAt: expect.any(Date),
    }));
    const setPayload = update.set.mock.calls[0]![0] as { nextRevokeAttemptAt: Date };
    expect(setPayload.nextRevokeAttemptAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(setPayload.nextRevokeAttemptAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('no-ops when the row is not currently active', async () => {
    mockSelectOnce([{ id: OLD_CERT_ID, deviceId: DEVICE_ID, state: 'pending_revocation' }]);

    await expect(queueCertificateRevocation(OLD_CERT_ID)).resolves.toBe(false);
  });

  it('no-ops when no replacement certificate exists for the device', async () => {
    mockSelectOnce([{ id: OLD_CERT_ID, deviceId: DEVICE_ID, state: 'active' }]);
    mockSelectOnce([]);

    await expect(queueCertificateRevocation(OLD_CERT_ID)).resolves.toBe(false);
  });

  it('no-ops when the row does not exist', async () => {
    mockSelectOnce([]);

    await expect(queueCertificateRevocation(OLD_CERT_ID)).resolves.toBe(false);
  });
});

describe('queueCertificateRevocationCore (injected tx — IMPORTANT 2)', () => {
  it('composes into a CALLER-supplied transaction handle instead of opening its own', async () => {
    // A standalone fake tx — deliberately NOT the module-level `db` mock —
    // proving the core takes whatever transaction handle a caller (e.g. a
    // future activation-confirmation route) passes in.
    const forUpdateRows = [{ id: OLD_CERT_ID, deviceId: DEVICE_ID, state: 'active' }];
    const replacementRows = [{ id: NEW_CERT_ID }];
    let selectCall = 0;

    const returning = vi.fn(async () => [{ id: OLD_CERT_ID }]);
    const updateWhere = vi.fn(() => ({ returning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));

    const fakeTx = {
      select: vi.fn(() => {
        selectCall += 1;
        const rows = selectCall === 1 ? forUpdateRows : replacementRows;
        const limit = vi.fn(() => rows);
        const where = vi.fn(() => ({ limit }));
        return { from: vi.fn(() => ({ where })) };
      }),
      update: vi.fn(() => ({ set: updateSet })),
    };

    // db.select/db.update (the module-level mock) must NEVER be touched —
    // everything routes through fakeTx.
    await expect(queueCertificateRevocationCore(fakeTx as never, OLD_CERT_ID)).resolves.toBe(true);

    expect(fakeTx.select).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      state: 'pending_revocation',
      nextRevokeAttemptAt: expect.any(Date),
    }));
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('enqueueCertificateRevocationJob', () => {
  it('uses a jobId with no colon, derived from the certificate id', async () => {
    await enqueueCertificateRevocationJob(OLD_CERT_ID);
    const jobId = (queueAddMock.mock.calls[0]![2] as { jobId: string }).jobId;
    expect(jobId).toContain(OLD_CERT_ID);
    expect(jobId).not.toContain(':');
  });
});
