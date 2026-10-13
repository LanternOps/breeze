import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getRepeatableJobsMock, removeRepeatableByKeyMock, passMock, workerOpts, capturedProcessor, workerClose, queueClose } =
  vi.hoisted(() => ({
    addMock: vi.fn(),
    getRepeatableJobsMock: vi.fn(),
    removeRepeatableByKeyMock: vi.fn(),
    passMock: vi.fn(),
    workerOpts: { current: null as null | Record<string, unknown> },
    capturedProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
    workerClose: vi.fn(),
    queueClose: vi.fn(),
  }));

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = (...args: unknown[]) => addMock(...args);
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...args);
    close = queueClose;
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>, opts: Record<string, unknown>) {
      capturedProcessor.current = processor;
      workerOpts.current = opts;
    }
    on = vi.fn();
    close = workerClose;
  },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/imageCurrency/pass', () => ({ runImageCurrencyPass: (...a: unknown[]) => passMock(...a) }));

import {
  IMAGE_CURRENCY_INTERVAL_MS,
  IMAGE_CURRENCY_QUEUE,
  initializeImageCurrencyWorker,
  shutdownImageCurrencyWorker,
} from './imageCurrencyWorker';

beforeEach(() => {
  vi.clearAllMocks();
  getRepeatableJobsMock.mockResolvedValue([{ key: 'stale-key' }]);
});

describe('imageCurrencyWorker', () => {
  it('registers a single repeatable pass every 30 minutes, replacing stale repeatables', async () => {
    await initializeImageCurrencyWorker();
    expect(IMAGE_CURRENCY_QUEUE).toBe('image-currency');
    expect(IMAGE_CURRENCY_INTERVAL_MS).toBe(30 * 60_000);
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('stale-key');
    expect(addMock).toHaveBeenCalledWith(
      'image-currency-pass',
      { type: 'pass' },
      expect.objectContaining({ jobId: 'image-currency-pass', repeat: { every: 30 * 60_000 } }),
    );
    // One pass at a time, and a lock long enough for a slow registry pass.
    expect(workerOpts.current).toMatchObject({ concurrency: 1 });
    expect(Number(workerOpts.current!.lockDuration)).toBeGreaterThanOrEqual(300_000);
    await shutdownImageCurrencyWorker();
    expect(workerClose).toHaveBeenCalled();
    expect(queueClose).toHaveBeenCalled();
  });

  it('the processor runs one pass and returns its summary', async () => {
    await initializeImageCurrencyWorker();
    passMock.mockResolvedValue({ groups: 3 });
    await expect(capturedProcessor.current!({ data: { type: 'pass' } })).resolves.toEqual({ groups: 3 });
    expect(passMock).toHaveBeenCalledTimes(1);
    await shutdownImageCurrencyWorker();
  });
});
