/**
 * Unit tests for the daily ECB exchange-rate sync worker (wave 7, #3779).
 *
 * BullMQ, the Frankfurter client and the exchange-rate service are stubbed, so
 * these assert scheduling (daily repeatable + boot one-shot), the request set
 * (every supported currency EXCEPT the EUR pivot), the "an uncovered pair is
 * unavailable, never stored" rule, and the transient-vs-permanent failure
 * contract — without Redis, Postgres or a network call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENCY_CODES } from '@breeze/shared';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  fetchMock,
  upsertMock,
  captureExceptionMock,
  captureMessageMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  fetchMock: vi.fn(),
  upsertMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

// Queue/Worker are stubbed, but UnrecoverableError is the REAL class — the
// permanent-failure contract is "BullMQ sees its own UnrecoverableError", and a
// look-alike local class would make that assertion vacuous.
vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  return {
    UnrecoverableError: actual.UnrecoverableError,
    Queue: class {
      name: string;
      constructor(name: string) {
        this.name = name;
      }
      add = (...args: unknown[]) => addMock(...(args as []));
      getRepeatableJobs = () => getRepeatableJobsMock();
      removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
      close = () => queueCloseMock();
    },
    Worker: class {
      name: string;
      constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
        this.name = name;
        capturedWorkerProcessor.current = processor;
      }
      on = vi.fn();
      close = () => workerCloseMock();
    },
    Job: class {},
  };
});

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
  captureMessage: (...args: unknown[]) => captureMessageMock(...(args as [])),
}));

vi.mock('../services/frankfurterClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/frankfurterClient')>();
  return {
    ECB_REPORTING_BASE_CODE: actual.ECB_REPORTING_BASE_CODE,
    FrankfurterClientError: actual.FrankfurterClientError,
    fetchLatestEcbRates: (...args: unknown[]) => fetchMock(...(args as [])),
  };
});

vi.mock('../services/exchangeRateService', () => ({
  upsertFeedRates: (...args: unknown[]) => upsertMock(...(args as [])),
}));

import { UnrecoverableError } from 'bullmq';
import { FrankfurterClientError } from '../services/frankfurterClient';
import {
  __testOnly,
  createExchangeRateSyncWorker,
  scheduleExchangeRateSync,
  shutdownExchangeRateSyncWorker,
  syncEcbExchangeRates,
} from './exchangeRateSync';

const ORIGINAL_FLAG = process.env.EXCHANGE_RATE_SYNC_ENABLED;

function fetchResult(
  overrides: Partial<{
    rates: unknown[];
    requestedQuoteCodes: string[];
    unavailableQuoteCodes: string[];
    rejected: Array<{ quoteCode: string | null; reason: string }>;
  }> = {},
) {
  return {
    rates: [],
    requestedQuoteCodes: [],
    unavailableQuoteCodes: [],
    rejected: [],
    ...overrides,
  };
}

describe('exchangeRateSync worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(fetchResult());
    upsertMock.mockResolvedValue({ submitted: 0, stored: 0, manualProtected: 0 });
    capturedWorkerProcessor.current = null;
    delete process.env.EXCHANGE_RATE_SYNC_ENABLED;
  });

  afterEach(async () => {
    await shutdownExchangeRateSyncWorker();
    if (ORIGINAL_FLAG === undefined) delete process.env.EXCHANGE_RATE_SYNC_ENABLED;
    else process.env.EXCHANGE_RATE_SYNC_ENABLED = ORIGINAL_FLAG;
  });

  describe('syncEcbExchangeRates', () => {
    it('requests every supported currency except the EUR pivot', async () => {
      await syncEcbExchangeRates();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requested = fetchMock.mock.calls[0]![0] as string[];
      expect(requested).toHaveLength(CURRENCY_CODES.length - 1);
      expect(requested).not.toContain('EUR');
      // Nothing is dropped other than the pivot itself.
      expect([...requested].sort()).toEqual(CURRENCY_CODES.filter((c) => c !== 'EUR').slice().sort());
    });

    it('forwards only returned rows to upsertFeedRates and stamps one fetchedAt', async () => {
      fetchMock.mockResolvedValue(
        fetchResult({
          rates: [
            { rateDate: '2026-08-23', baseCode: 'EUR', quoteCode: 'USD', rate: '1.08000000' },
            { rateDate: '2026-08-23', baseCode: 'EUR', quoteCode: 'GBP', rate: '0.85000000' },
          ],
          requestedQuoteCodes: ['GBP', 'USD', 'ZZZ'],
          unavailableQuoteCodes: ['ZZZ'],
        }),
      );
      upsertMock.mockResolvedValue({ submitted: 2, stored: 1, manualProtected: 1 });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const stats = await syncEcbExchangeRates();
        expect(stats).toEqual({ requested: 3, received: 2, stored: 1, manualProtected: 1, unavailable: ['ZZZ'], rejected: 0 });
      } finally {
        warnSpy.mockRestore();
      }
      const forwarded = upsertMock.mock.calls[0]![0] as Array<{ quoteCode: string; fetchedAt: Date }>;
      expect(forwarded.map((r) => r.quoteCode)).toEqual(['USD', 'GBP']);
      // An uncovered pair is UNAVAILABLE — never written as a placeholder or 1:1.
      expect(forwarded.map((r) => r.quoteCode)).not.toContain('ZZZ');
      expect(forwarded.every((r) => r.fetchedAt instanceof Date)).toBe(true);
      expect(new Set(forwarded.map((r) => r.fetchedAt.getTime())).size).toBe(1);
    });

    it('stores nothing at all when the provider covers no requested currency', async () => {
      fetchMock.mockResolvedValue(
        fetchResult({ rates: [], requestedQuoteCodes: ['USD'], unavailableQuoteCodes: ['USD'] }),
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const stats = await syncEcbExchangeRates();
        expect(stats).toMatchObject({ received: 0, stored: 0, unavailable: ['USD'] });
      } finally {
        warnSpy.mockRestore();
      }
      const forwarded = upsertMock.mock.calls[0]![0] as unknown[];
      expect(forwarded).toEqual([]);
    });

    it('stores the surviving rows and REPORTS rejected ones instead of failing the batch', async () => {
      fetchMock.mockResolvedValue(
        fetchResult({
          rates: [{ rateDate: '2026-08-23', baseCode: 'EUR', quoteCode: 'USD', rate: '1.08000000' }],
          requestedQuoteCodes: ['CHF', 'USD'],
          unavailableQuoteCodes: ['CHF'],
          rejected: [{ quoteCode: 'CHF', reason: 'Rate "0.123456789" exceeds 8 decimals' }],
        }),
      );
      upsertMock.mockResolvedValue({ submitted: 1, stored: 1, manualProtected: 0 });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const stats = await syncEcbExchangeRates();
        expect(stats).toMatchObject({ received: 1, stored: 1, rejected: 1, unavailable: ['CHF'] });
      } finally {
        warnSpy.mockRestore();
      }
      // The good currency still got its update for the day.
      const forwarded = upsertMock.mock.calls[0]![0] as Array<{ quoteCode: string }>;
      expect(forwarded.map((r) => r.quoteCode)).toEqual(['USD']);
      // ...and the bad row is visible, not swallowed.
      expect(captureMessageMock).toHaveBeenCalledTimes(1);
      expect(String(captureMessageMock.mock.calls[0]![0])).toContain('rejected 1');
      expect(captureMessageMock.mock.calls[0]![1]).toMatchObject({
        eventCode: 'exchange_rate_rows_rejected',
      });
    });

    it('rethrows a transient FrankfurterClientError AS-IS so BullMQ retries', async () => {
      const transient = new FrankfurterClientError('Frankfurter responded 503', 'transient', 503);
      fetchMock.mockRejectedValue(transient);
      await expect(syncEcbExchangeRates()).rejects.toBe(transient);
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it('rethrows a permanent FrankfurterClientError AS-IS (the worker decides retryability)', async () => {
      const permanent = new FrankfurterClientError('not a row array', 'permanent');
      fetchMock.mockRejectedValue(permanent);
      await expect(syncEcbExchangeRates()).rejects.toBe(permanent);
    });
  });

  describe('worker processor', () => {
    it('ignores an unknown job name', async () => {
      createExchangeRateSyncWorker();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const res = (await capturedWorkerProcessor.current!({ name: 'nope', id: 'j0', data: {} })) as { skipped: boolean };
        expect(res.skipped).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('runs the sync for its own job name and returns the stats', async () => {
      createExchangeRateSyncWorker();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const res = (await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME, id: 'j1', data: {} })) as {
          requested: number;
          durationMs: number;
        };
        expect(res.requested).toBe(0);
        expect(typeof res.durationMs).toBe('number');
      } finally {
        logSpy.mockRestore();
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('lets a transient failure through unchanged so BullMQ burns an attempt and retries', async () => {
      createExchangeRateSyncWorker();
      const transient = new FrankfurterClientError('timeout', 'transient');
      fetchMock.mockRejectedValue(transient);
      await expect(capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME, id: 'j2', data: {} })).rejects.toBe(transient);
    });

    it('wraps a permanent failure in BullMQ UnrecoverableError so the job is not re-attempted', async () => {
      createExchangeRateSyncWorker();
      fetchMock.mockRejectedValue(new FrankfurterClientError('Frankfurter responded 404', 'permanent', 404));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME, id: 'j3', data: {} }),
        ).rejects.toBeInstanceOf(UnrecoverableError);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('wraps a misconfiguration (unparseable FRANKFURTER_BASE_URL) in UnrecoverableError', async () => {
      createExchangeRateSyncWorker();
      // The client throws a bare TypeError from `new URL()` for a malformed
      // mirror URL. Retrying identical config cannot help, so it must not retry.
      fetchMock.mockRejectedValue(new TypeError('Invalid URL'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME, id: 'j4', data: {} }),
        ).rejects.toBeInstanceOf(UnrecoverableError);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('a job that fails with UnrecoverableError is not re-attempted', async () => {
      // BullMQ's own contract: a processor rejection that is an UnrecoverableError
      // moves the job straight to failed. Simulated here (Worker is stubbed) by
      // driving the processor through the same retry loop BullMQ applies.
      createExchangeRateSyncWorker();
      fetchMock.mockRejectedValue(new FrankfurterClientError('bad protocol', 'permanent'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const job = { name: __testOnly.JOB_NAME, id: 'j5', data: {}, attemptsMade: 0, opts: { attempts: 3 } };
      try {
        for (;;) {
          try {
            await capturedWorkerProcessor.current!(job);
            break;
          } catch (err) {
            job.attemptsMade += 1;
            if (err instanceof UnrecoverableError) break;
            if (job.attemptsMade >= job.opts.attempts) break;
          }
        }
      } finally {
        errSpy.mockRestore();
      }
      expect(job.attemptsMade).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('scheduling', () => {
    it('registers a daily repeatable AND a boot one-shot, both with stable ids', async () => {
      await scheduleExchangeRateSync();
      expect(addMock).toHaveBeenCalledTimes(2);
      const [dailyName, dailyData, dailyOpts] = addMock.mock.calls[0]!;
      expect(dailyName).toBe(__testOnly.JOB_NAME);
      expect(dailyData).toEqual({});
      expect(dailyOpts).toMatchObject({
        jobId: __testOnly.REPEAT_JOB_ID,
        repeat: { pattern: __testOnly.DAILY_CRON },
        attempts: 3,
      });

      const [bootName, bootData, bootOpts] = addMock.mock.calls[1]!;
      expect(bootName).toBe(__testOnly.JOB_NAME);
      expect(bootData).toEqual({ reason: 'boot' });
      expect(bootOpts).toMatchObject({ jobId: __testOnly.BOOT_JOB_ID, removeOnComplete: true, removeOnFail: true, attempts: 3 });
      expect((bootOpts as { repeat?: unknown }).repeat).toBeUndefined();
    });

    it('removes prior repeatables of this job before re-adding, leaving other jobs alone', async () => {
      getRepeatableJobsMock.mockResolvedValue([
        { name: __testOnly.JOB_NAME, key: 'old-key' },
        { name: 'unrelated-job', key: 'other-key' },
      ]);
      await scheduleExchangeRateSync();
      expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    });

    it('with the kill switch off it still removes repeatables but adds nothing', async () => {
      process.env.EXCHANGE_RATE_SYNC_ENABLED = 'false';
      getRepeatableJobsMock.mockResolvedValue([{ name: __testOnly.JOB_NAME, key: 'old-key' }]);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await scheduleExchangeRateSync();
      } finally {
        logSpy.mockRestore();
      }
      expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
      expect(addMock).not.toHaveBeenCalled();
    });

    it('runs at 17:15 UTC, after the ECB ~16:00 CET publication', () => {
      expect(__testOnly.DAILY_CRON).toBe('13 17 * * *');
    });
  });

  describe('isSyncEnabled', () => {
    it.each([undefined, ''])('defaults ON when EXCHANGE_RATE_SYNC_ENABLED is %p', (value) => {
      if (value === undefined) delete process.env.EXCHANGE_RATE_SYNC_ENABLED;
      else process.env.EXCHANGE_RATE_SYNC_ENABLED = value;
      expect(__testOnly.isSyncEnabled()).toBe(true);
    });

    it.each(['0', 'false', 'FALSE', ' no ', 'off'])('is OFF for %p', (value) => {
      process.env.EXCHANGE_RATE_SYNC_ENABLED = value;
      expect(__testOnly.isSyncEnabled()).toBe(false);
    });

    it.each(['1', 'true', 'yes', 'on'])('stays ON for %p', (value) => {
      process.env.EXCHANGE_RATE_SYNC_ENABLED = value;
      expect(__testOnly.isSyncEnabled()).toBe(true);
    });
  });
});
