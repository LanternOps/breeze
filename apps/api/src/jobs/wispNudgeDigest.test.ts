/**
 * Wisp W06a Task 5 — the 15-minute digest + morning-brief job. BullMQ and the
 * two sweeps are mocked; the Worker is constructed unconditionally.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runNudgeDigest: vi.fn(),
  runMorningBriefs: vi.fn(),
  captureException: vi.fn(),
  add: vi.fn(),
  getRepeatableJobs: vi.fn(async () => [] as Array<{ key: string }>),
  removeRepeatableByKey: vi.fn(),
  workerCtor: vi.fn(),
  workerClose: vi.fn(),
  queueClose: vi.fn(),
  order: [] as string[],
  processor: { current: null as null | ((job: { data: unknown }) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...args: unknown[]) => { h.order.push('add'); return h.add(...args); };
    getRepeatableJobs = () => h.getRepeatableJobs();
    removeRepeatableByKey = (key: string) => { h.order.push(`remove:${key}`); return h.removeRepeatableByKey(key); };
    close = () => h.queueClose();
  },
  Worker: class {
    constructor(name: string, processor: (job: { data: unknown }) => Promise<unknown>, opts: unknown) {
      h.workerCtor(name, opts);
      h.processor.current = processor;
    }
    on = vi.fn();
    close = () => h.workerClose();
  },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: (...a: unknown[]) => h.captureException(...a), captureMessage: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/wisp/nudgeDigest', () => ({ runNudgeDigest: (...a: unknown[]) => h.runNudgeDigest(...a) }));
vi.mock('../services/wisp/brief', () => ({ runMorningBriefs: (...a: unknown[]) => h.runMorningBriefs(...a) }));

import {
  WISP_NUDGE_DIGEST_QUEUE,
  initializeWispNudgeDigestWorker,
  shutdownWispNudgeDigestWorker,
} from './wispNudgeDigest';

beforeEach(async () => {
  await shutdownWispNudgeDigestWorker();
  for (const f of [h.runNudgeDigest, h.runMorningBriefs, h.captureException, h.add, h.workerCtor, h.removeRepeatableByKey]) f.mockReset();
  h.order = [];
  h.getRepeatableJobs.mockImplementation(async () => []);
  h.runNudgeDigest.mockResolvedValue({ candidates: 2, sent: 1, suppressed: 0 });
  h.runMorningBriefs.mockResolvedValue({ due: 1, sent: 1, suppressed: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('wispNudgeDigest worker', () => {
  it('constructs the Worker and registers the 15-minute repeatable', async () => {
    h.getRepeatableJobs.mockImplementation(async () => [{ key: 'old' }]);
    await initializeWispNudgeDigestWorker();
    expect(WISP_NUDGE_DIGEST_QUEUE).toBe('wisp-nudge-digest');
    expect(h.workerCtor).toHaveBeenCalledWith('wisp-nudge-digest', expect.objectContaining({ concurrency: 1 }));
    expect(h.order).toEqual(['remove:old', 'add']);
    const [, , opts] = h.add.mock.calls[0] as [string, unknown, { jobId: string; repeat: unknown }];
    expect(opts.jobId).toBe('wisp-nudge-digest');
    expect(opts.repeat).toEqual({ pattern: '13,28,43,58 * * * *' });
  });

  it('the processor runs the digest then the briefs', async () => {
    await initializeWispNudgeDigestWorker();
    const out = await h.processor.current!({ data: {} });
    expect(out).toEqual({
      digest: { candidates: 2, sent: 1, suppressed: 0 },
      briefs: { due: 1, sent: 1, suppressed: 0 },
    });
    expect(h.runNudgeDigest.mock.invocationCallOrder[0]!).toBeLessThan(h.runMorningBriefs.mock.invocationCallOrder[0]!);
  });

  it('a throwing digest is captured and the briefs still run', async () => {
    h.runNudgeDigest.mockRejectedValue(new Error('digest down'));
    await initializeWispNudgeDigestWorker();
    const out = await h.processor.current!({ data: {} }) as { briefs: unknown };
    expect(h.runMorningBriefs).toHaveBeenCalled();
    expect(out.briefs).toEqual({ due: 1, sent: 1, suppressed: 0 });
    expect(h.captureException).toHaveBeenCalled();
  });

  it('a throwing brief is captured and the digest result still returns', async () => {
    h.runMorningBriefs.mockRejectedValue(new Error('brief down'));
    await initializeWispNudgeDigestWorker();
    const out = await h.processor.current!({ data: {} }) as { digest: unknown };
    expect(out.digest).toEqual({ candidates: 2, sent: 1, suppressed: 0 });
    expect(h.captureException).toHaveBeenCalled();
  });
});
