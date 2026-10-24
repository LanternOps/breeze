/**
 * Wisp W04 Task 5 — closeSession recomputes the thread summary after the
 * status write, best effort.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  finalize: vi.fn(async (_id: string) => ({ updated: false })),
  capture: vi.fn(),
}));

vi.mock('./topology/aiSessionAccess', () => ({ topologySessionAccessCondition: vi.fn(async () => undefined) }));
vi.mock('./wisp/threadSummary', () => ({ finalizeWispSessionSummary: h.finalize }));
vi.mock('./sentry', () => ({ captureException: h.capture }));
vi.mock('../db', () => ({
  db: {
    select: () => {
      const self: any = { from: () => self, where: () => self, limit: () => Promise.resolve([{ id: 's1', orgId: 'org-1' }]) };
      return self;
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => { h.order.push(`update:${String(v.status)}`); },
      }),
    }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runAfterDbContextCommit: (_label: string, work: () => unknown) => { h.order.push('scheduled'); void work(); },
}));

import { closeSession } from './aiAgent';

const auth = { user: { id: 'u1' }, orgCondition: () => undefined } as any;

describe('closeSession (W04 T5)', () => {
  beforeEach(() => {
    h.order.length = 0;
    h.finalize.mockReset();
    h.finalize.mockResolvedValue({ updated: false });
    h.capture.mockReset();
  });

  it('finalizes the thread summary for the closed session after the status write', async () => {
    await expect(closeSession('s1', auth)).resolves.toEqual({ orgId: 'org-1' });
    await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledWith('s1'));
    expect(h.order).toEqual(['update:closed', 'scheduled']);
  });

  it('a rejected finalize is captured, logged with the session id, and does not fail the close', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.finalize.mockRejectedValueOnce(new Error('summary boom'));
    await expect(closeSession('s1', auth)).resolves.toEqual({ orgId: 'org-1' });
    await vi.waitFor(() => expect(h.capture).toHaveBeenCalledWith(expect.objectContaining({ message: 'summary boom' })));
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes('s1'))).toBe(true);
    errSpy.mockRestore();
  });
});
