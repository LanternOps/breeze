/**
 * Unit tests for the Stripe account-cache bootstrap/refresh worker (#3777
 * review F6). BullMQ + the partnerStripe service are stubbed so we can assert
 * on schedule registration (daily repeatable + boot one-shot), processor
 * dispatch, and the per-partner error isolation without Redis or Stripe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock,
  getRepeatableJobsMock,
  removeRepeatableByKeyMock,
  queueCloseMock,
  workerCloseMock,
  listMock,
  refreshMock,
  capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  queueCloseMock: vi.fn(),
  workerCloseMock: vi.fn(),
  listMock: vi.fn(),
  refreshMock: vi.fn(),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
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
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/partnerStripe')>();
  return {
    PartnerStripeError: actual.PartnerStripeError,
    listPartnersNeedingStripeAccountBootstrap: (...args: unknown[]) => listMock(...(args as [])),
    refreshPartnerStripeAccount: (...args: unknown[]) => refreshMock(...(args as [])),
  };
});

import { PartnerStripeError } from '../services/partnerStripe';
import {
  __testOnly,
  createStripeAccountCacheRefreshWorker,
  refreshUncachedStripeAccounts,
  scheduleStripeAccountCacheRefresh,
  shutdownStripeAccountCacheRefreshWorker,
} from './stripeAccountCacheRefresh';

const ORIGINAL_FLAG = process.env.STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED;

describe('stripeAccountCacheRefresh worker', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getRepeatableJobsMock.mockResolvedValue([]);
    addMock.mockResolvedValue(undefined);
    removeRepeatableByKeyMock.mockResolvedValue(undefined);
    queueCloseMock.mockResolvedValue(undefined);
    workerCloseMock.mockResolvedValue(undefined);
    listMock.mockResolvedValue([]);
    capturedWorkerProcessor.current = null;
    delete process.env.STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED;
  });

  afterEach(async () => {
    await shutdownStripeAccountCacheRefreshWorker();
    if (ORIGINAL_FLAG === undefined) delete process.env.STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED;
    else process.env.STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED = ORIGINAL_FLAG;
  });

  it('registers a daily repeatable AND a run-once-at-boot job, both with stable ids for multi-replica dedup', async () => {
    await scheduleStripeAccountCacheRefresh();
    expect(addMock).toHaveBeenCalledTimes(2);
    const [dailyName, dailyData, dailyOpts] = addMock.mock.calls[0]!;
    expect(dailyName).toBe(__testOnly.JOB_NAME);
    expect(dailyData).toEqual({});
    expect(dailyOpts).toMatchObject({ jobId: __testOnly.REPEAT_JOB_ID, repeat: { pattern: __testOnly.DAILY_CRON } });

    const [bootName, bootData, bootOpts] = addMock.mock.calls[1]!;
    expect(bootName).toBe(__testOnly.JOB_NAME);
    expect(bootData).toEqual({ reason: 'boot' });
    expect(bootOpts).toMatchObject({ jobId: __testOnly.BOOT_JOB_ID, removeOnComplete: true, removeOnFail: true });
    expect((bootOpts as { repeat?: unknown }).repeat).toBeUndefined();
  });

  it('removes prior repeatables before re-adding (cron change takes effect on redeploy)', async () => {
    getRepeatableJobsMock.mockResolvedValue([
      { name: __testOnly.JOB_NAME, key: 'old-key' },
      { name: 'unrelated-job', key: 'other-key' },
    ]);
    await scheduleStripeAccountCacheRefresh();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledTimes(1);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
  });

  it('skips registration entirely when STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED=false', async () => {
    process.env.STRIPE_ACCOUNT_CACHE_REFRESH_ENABLED = 'false';
    await scheduleStripeAccountCacheRefresh();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('worker processor delegates to refreshUncachedStripeAccounts for the right job name and ignores others', async () => {
    createStripeAccountCacheRefreshWorker();
    expect(capturedWorkerProcessor.current).toBeTypeOf('function');
    const ok = (await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME, id: 'j1', data: {} })) as { candidates: number };
    expect(ok.candidates).toBe(0);
    expect(listMock).toHaveBeenCalledTimes(1);

    const skipped = (await capturedWorkerProcessor.current!({ name: 'nope', id: 'j2', data: {} })) as { skipped: boolean };
    expect(skipped.skipped).toBe(true);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  describe('refreshUncachedStripeAccounts', () => {
    it('refreshes every candidate partner and isolates failures per partner (transient vs permanent vs unknown counted separately)', async () => {
      listMock.mockResolvedValue([
        { partnerId: 'p-ok' },
        { partnerId: 'p-transient' },
        { partnerId: 'p-revoked' },
        { partnerId: 'p-restricted' },
        { partnerId: 'p-raced' },
        { partnerId: 'p-ok2' },
      ]);
      refreshMock.mockImplementation(async (partnerId: string) => {
        if (partnerId === 'p-transient') throw new PartnerStripeError('down', 'STRIPE_UNAVAILABLE');
        if (partnerId === 'p-revoked') throw new PartnerStripeError('bad key', 'INVALID_STRIPE_KEY');
        // A restricted key that cannot call accounts.retrieve is NOT a dead
        // connection — it must not be counted as a partner who must reconnect.
        if (partnerId === 'p-restricted') throw new PartnerStripeError('no account access', 'STRIPE_ACCOUNT_UNKNOWN');
        // A local key-replacement race is not a Stripe outage (review F4).
        if (partnerId === 'p-raced') throw new PartnerStripeError('connection changed', 'STRIPE_CONNECTION_CHANGED');
        return { stripeAccountId: 'acct', last4: '1', livemode: false, defaultCurrency: 'EUR', accountCountry: 'DE', accountRefreshedAt: new Date() };
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const stats = await refreshUncachedStripeAccounts();
        expect(stats).toEqual({ candidates: 6, refreshed: 2, transientFailures: 1, permanentFailures: 1, unknownFailures: 2, unexpectedFailures: 0 });
      } finally {
        errSpy.mockRestore();
        warnSpy.mockRestore();
      }
      // Every candidate was attempted — one dead key never stops the sweep.
      expect(refreshMock).toHaveBeenCalledTimes(6);
      expect(refreshMock.mock.calls.map((c) => c[0])).toEqual(['p-ok', 'p-transient', 'p-revoked', 'p-restricted', 'p-raced', 'p-ok2']);
    });

    it('a non-PartnerStripeError from one partner is counted as unexpected and does not abort the sweep', async () => {
      listMock.mockResolvedValue([{ partnerId: 'p-boom' }, { partnerId: 'p-ok' }]);
      refreshMock
        .mockRejectedValueOnce(new Error('db hiccup'))
        .mockResolvedValueOnce({ stripeAccountId: 'acct', last4: '1', livemode: false, defaultCurrency: 'USD', accountCountry: 'US', accountRefreshedAt: new Date() });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const stats = await refreshUncachedStripeAccounts();
        expect(stats).toMatchObject({ candidates: 2, refreshed: 1, unexpectedFailures: 1 });
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});
