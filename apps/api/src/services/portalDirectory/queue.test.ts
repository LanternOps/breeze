import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enqueue: vi.fn(), created: [] as Array<{ name: string }> }));

vi.mock('../bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn((name: string) => {
    const q = { name, close: vi.fn(async () => undefined) };
    h.created.push(q);
    return q;
  }),
}));
vi.mock('../bullmqUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bullmqUtils')>()),
  enqueueOrReplaceStale: h.enqueue,
}));

import {
  PORTAL_DIRECTORY_APPLY_JOB,
  PORTAL_DIRECTORY_JOB_OPTS,
  PORTAL_DIRECTORY_QUEUE,
  applyRunJobId,
  enqueueApplyRun,
  portalDirectoryBackoff,
} from './queue';

const RUN = '9f8e7d6c-5b4a-4398-8776-655443322110';
const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';

beforeEach(() => {
  h.enqueue.mockReset();
  h.enqueue.mockResolvedValue({ id: `portal-dir-apply-${RUN}` });
});

describe('portal directory queue (D10)', () => {
  it('names the queue and the apply job id with no colons', () => {
    expect(PORTAL_DIRECTORY_QUEUE).toBe('portal-directory-deprovision');
    expect(applyRunJobId(RUN)).toBe(`portal-dir-apply-${RUN}`);
    expect(applyRunJobId(RUN)).not.toContain(':');
  });

  it('job options: 3 attempts, custom 1/5/15 min backoff, removeOnComplete, failures kept 7 days', () => {
    expect(PORTAL_DIRECTORY_JOB_OPTS).toEqual({
      attempts: 3, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: { age: 7 * 86400 },
    });
    expect([1, 2, 3].map(portalDirectoryBackoff)).toEqual([60_000, 300_000, 900_000]);
    expect(portalDirectoryBackoff(0)).toBe(60_000);
    expect(portalDirectoryBackoff(9)).toBe(900_000);
  });

  it('enqueueApplyRun replaces a spent job record and returns true', async () => {
    await expect(enqueueApplyRun(RUN, ORG)).resolves.toBe(true);
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: PORTAL_DIRECTORY_QUEUE }),
      PORTAL_DIRECTORY_APPLY_JOB,
      `portal-dir-apply-${RUN}`,
      { runId: RUN, orgId: ORG },
      PORTAL_DIRECTORY_JOB_OPTS,
      '[portal-directory]',
    );
  });

  it('an enqueue failure returns false and never throws (the run row is the outbox)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.enqueue.mockRejectedValueOnce(new Error('redis down'));
    await expect(enqueueApplyRun(RUN, ORG)).resolves.toBe(false);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
