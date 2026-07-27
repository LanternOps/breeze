import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromEnvMock, revokeCertificateMock, captureExceptionMock, queueAddMock, FakeBullMQWorker } = vi.hoisted(() => {
  class FakeBullMQWorkerImpl {
    on() { return this; }
    async close() { /* no-op */ }
  }
  return {
    fromEnvMock: vi.fn(),
    revokeCertificateMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    queueAddMock: vi.fn(async (_name: string, _data: unknown, _opts?: Record<string, unknown>) => undefined),
    FakeBullMQWorker: FakeBullMQWorkerImpl,
  };
});

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  return { ...actual, Worker: FakeBullMQWorker };
});

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/cloudflareMtls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/cloudflareMtls')>();
  return {
    ...actual,
    CloudflareMtlsService: { fromEnv: fromEnvMock },
  };
});

vi.mock('../services/bullmqQueue', () => ({
  createInstrumentedQueue: () => ({ add: queueAddMock }),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({
  captureException: captureExceptionMock,
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, lte: vi.fn(actual.lte) };
});

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { lte } from 'drizzle-orm';
import { deviceMtlsCertificates } from '../db/schema';
import { CloudflareMtlsError } from '../services/cloudflareMtls';
import {
  initializeMtlsCertificateRevocationWorker,
  processMtlsCertificateRevocationJob,
  shutdownMtlsCertificateRevocationWorker,
  sweepDueMtlsCertificateRevocations,
  __testOnly,
} from './mtlsCertificateRevocation';
import { __resetMtlsCertificateRevocationQueueForTests } from '../services/deviceMtlsCertificateLifecycle';

const CERT_ID = '11111111-1111-4111-8111-111111111111';
const ACTIVATION_EXPIRED_ID = '44444444-4444-4444-8444-444444444444';
const SENSITIVE_PROVIDER_ID = 'cf-provider-id-should-never-leak';

function pendingRevocationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CERT_ID,
    state: 'pending_revocation',
    providerCertificateId: SENSITIVE_PROVIDER_ID,
    revokeAttempts: 0,
    ...overrides,
  };
}

function mockSelectOnce(rows: unknown[]) {
  const resultArray = rows as unknown[] & { for?: ReturnType<typeof vi.fn> };
  const forUpdate = vi.fn(async () => rows);
  resultArray.for = forUpdate;
  const limit = vi.fn(() => resultArray);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  const from = vi.fn(() => ({ where }));
  vi.mocked(db.select).mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where, limit, orderBy, forUpdate };
}

function mockUpdate(returningRows: unknown[] = []) {
  const returning = vi.fn(async () => returningRows);
  const whereResult: Record<string, unknown> & { then: (resolve: (v: undefined) => void) => void } = {
    returning,
    then: (resolve: (v: undefined) => void) => resolve(undefined),
  };
  const whereFn = vi.fn(() => whereResult);
  const set = vi.fn((_payload: Record<string, unknown>) => ({ where: whereFn }));
  vi.mocked(db.update).mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);
  return { set, where: whereFn, returning };
}

function job(certificateId: string) {
  return { data: { certificateId } } as Parameters<typeof processMtlsCertificateRevocationJob>[0];
}

beforeEach(async () => {
  await shutdownMtlsCertificateRevocationWorker();
  vi.clearAllMocks();
  __resetMtlsCertificateRevocationQueueForTests();
  vi.mocked(runOutsideDbContext).mockImplementation((fn: () => unknown) => fn() as never);
  vi.mocked(withSystemDbAccessContext).mockImplementation(
    (async (fn: () => Promise<unknown>) => fn()) as never,
  );
  fromEnvMock.mockReturnValue({ revokeCertificate: revokeCertificateMock });
  queueAddMock.mockResolvedValue(undefined);
});

describe('processMtlsCertificateRevocationJob', () => {
  it('marks a pending_revocation row revoked on provider success', async () => {
    mockSelectOnce([pendingRevocationRow()]);
    const update = mockUpdate();
    revokeCertificateMock.mockResolvedValue('revoked');

    await expect(processMtlsCertificateRevocationJob(job(CERT_ID))).resolves.toBeUndefined();
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'revoked' }));
  });

  it('treats provider 404 (not_found) as a completed revocation', async () => {
    mockSelectOnce([pendingRevocationRow()]);
    const update = mockUpdate();
    revokeCertificateMock.mockResolvedValue('not_found');

    await processMtlsCertificateRevocationJob(job(CERT_ID));
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'revoked' }));
  });

  it('returns success (no provider call, no throw) for an already-revoked row — safe under duplicate delivery', async () => {
    mockSelectOnce([pendingRevocationRow({ state: 'revoked' })]);

    await expect(processMtlsCertificateRevocationJob(job(CERT_ID))).resolves.toBeUndefined();
    expect(revokeCertificateMock).not.toHaveBeenCalled();
  });

  it('is idempotent under two sequential deliveries of the same job (second is a no-op success)', async () => {
    // First delivery: row is pending_revocation, provider succeeds -> revoked.
    mockSelectOnce([pendingRevocationRow()]);
    mockUpdate();
    revokeCertificateMock.mockResolvedValue('revoked');
    await processMtlsCertificateRevocationJob(job(CERT_ID));

    // Second (duplicate) delivery: the row is now already revoked.
    mockSelectOnce([pendingRevocationRow({ state: 'revoked' })]);
    await expect(processMtlsCertificateRevocationJob(job(CERT_ID))).resolves.toBeUndefined();
    expect(revokeCertificateMock).toHaveBeenCalledTimes(1);
  });

  it('on forced provider failure, does not throw and durably records the backoff', async () => {
    mockSelectOnce([pendingRevocationRow({ revokeAttempts: 3 })]);
    const update = mockUpdate();
    revokeCertificateMock.mockRejectedValue(new CloudflareMtlsError('revoke', 503, true, 'boom'));

    await expect(processMtlsCertificateRevocationJob(job(CERT_ID))).resolves.toBeUndefined();
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      revokeAttempts: 4,
      lastRevokeError: 'provider_5xx',
    }));
  });

  it('caps the backoff at 24 hours after many prior failures', async () => {
    mockSelectOnce([pendingRevocationRow({ revokeAttempts: 20 })]);
    const update = mockUpdate();
    revokeCertificateMock.mockRejectedValue(new CloudflareMtlsError('revoke', 503, true, 'boom'));

    const before = Date.now();
    await processMtlsCertificateRevocationJob(job(CERT_ID));

    const setPayload = update.set.mock.calls[0]![0] as { nextRevokeAttemptAt: Date };
    const delayMs = setPayload.nextRevokeAttemptAt.getTime() - before;
    expect(delayMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    expect(delayMs).toBeGreaterThan(23 * 60 * 60 * 1000);
  });
});

describe('sweepDueMtlsCertificateRevocations', () => {
  it('enqueues due pending_revocation rows', async () => {
    mockSelectOnce([{ id: CERT_ID }]);
    mockUpdate([]); // expired-activations UPDATE returns none

    const result = await sweepDueMtlsCertificateRevocations();

    expect(result).toEqual({ dueRevocationsQueued: 1, expiredActivationsQueued: 0 });
    expect(queueAddMock).toHaveBeenCalledWith(
      'revoke',
      { certificateId: CERT_ID },
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });

  it('IMPORTANT 1 (audit): the sweep enqueues WITHOUT a delay — rows found here are already due, unlike the inline-failure branch which intentionally delays', async () => {
    mockSelectOnce([{ id: CERT_ID }]);
    mockUpdate([]);

    await sweepDueMtlsCertificateRevocations();

    const opts = queueAddMock.mock.calls[0]![2] as { delay?: number };
    expect(opts.delay).toBeUndefined();
  });

  it('CRITICAL regression: the due-query is built from lte(nextRevokeAttemptAt, now) — the exact column queueCertificateRevocationCore\'s demotion write now populates (a NULL there would never match `lte` and would permanently hide the row from this sweep)', async () => {
    mockSelectOnce([{ id: CERT_ID }]);
    mockUpdate([]);

    await sweepDueMtlsCertificateRevocations();

    const lteCalls = vi.mocked(lte).mock.calls;
    expect(lteCalls.some(([column]) => column === deviceMtlsCertificates.nextRevokeAttemptAt)).toBe(true);
  });

  it('transitions expired pending_activation rows to pending_revocation and queues them, without a separate touch of any active row', async () => {
    mockSelectOnce([]); // no due pending_revocation rows
    const update = mockUpdate([{ id: ACTIVATION_EXPIRED_ID }]);

    const result = await sweepDueMtlsCertificateRevocations();

    expect(result).toEqual({ dueRevocationsQueued: 0, expiredActivationsQueued: 1 });
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ state: 'pending_revocation' }));
    expect(queueAddMock).toHaveBeenCalledWith(
      'revoke',
      { certificateId: ACTIVATION_EXPIRED_ID },
      expect.anything(),
    );
  });

  it('does not throw when the Redis enqueue fails after the DB transition commits (best-effort; next sweep repairs it)', async () => {
    mockSelectOnce([{ id: CERT_ID }]);
    mockUpdate([]);
    queueAddMock.mockRejectedValueOnce(new Error('redis connection refused'));

    await expect(sweepDueMtlsCertificateRevocations()).resolves.toEqual({
      dueRevocationsQueued: 1,
      expiredActivationsQueued: 0,
    });
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

describe('initializeMtlsCertificateRevocationWorker / shutdown', () => {
  it('registers a periodic sweep and stops it on shutdown', async () => {
    vi.useFakeTimers();
    mockSelectOnce([]);
    mockUpdate([]);

    initializeMtlsCertificateRevocationWorker();
    await vi.advanceTimersByTimeAsync(__testOnly.SWEEP_INTERVAL_MS);
    expect(db.select).toHaveBeenCalled();

    await shutdownMtlsCertificateRevocationWorker();
    const callsAtShutdown = vi.mocked(db.select).mock.calls.length;
    await vi.advanceTimersByTimeAsync(__testOnly.SWEEP_INTERVAL_MS * 2);
    expect(db.select).toHaveBeenCalledTimes(callsAtShutdown);
    vi.useRealTimers();
  });
});
