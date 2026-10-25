import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool catalog W04 (#5219), plan Task A8 / Decision 15 — the run lease and the
 * fenced checkpoint. Branch logic only: the SQL is mocked at the module
 * boundary (runStore.ts) and the token / now() semantics are proven on a real
 * database (flowRunLease.integration.test.ts).
 */
const h = vi.hoisted(() => ({
  store: {
    casAcquireLease: vi.fn(),
    fencedRunUpdate: vi.fn(),
    insertStepRow: vi.fn(async () => {}),
    updateStepRow: vi.fn(async () => {}),
    renewLease: vi.fn(),
    releaseLease: vi.fn(async () => {}),
  },
  order: [] as string[],
}));

vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: async (fn: () => unknown) => {
    h.order.push('tx:begin');
    try {
      const out = await fn();
      h.order.push('tx:commit');
      return out;
    } catch (err) {
      h.order.push('tx:rollback');
      throw err;
    }
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./runStore', () => ({ ...h.store, TERMINAL_FLOW_RUN_STATUSES: ['completed', 'failed', 'cancelled', 'expired'] }));

import { acquireRunLease, checkpoint, releaseRunLease, startLeaseHeartbeat } from './runLease';

const RUN_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const TOKEN = 'aaaaaaaa-0000-4000-8000-000000000009';

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('acquireRunLease', () => {
  it('returns the fresh token', async () => {
    h.store.casAcquireLease.mockResolvedValueOnce({ id: RUN_ID, leaseToken: TOKEN, status: 'queued' });
    await expect(acquireRunLease(RUN_ID, ['queued'])).resolves.toEqual({ token: TOKEN });
    expect(h.store.casAcquireLease).toHaveBeenCalledWith(RUN_ID, ['queued']);
  });

  it('a second acquire while the first is live returns null', async () => {
    h.store.casAcquireLease.mockResolvedValueOnce({ id: RUN_ID, leaseToken: TOKEN, status: 'queued' });
    h.store.casAcquireLease.mockResolvedValueOnce(null); // the CAS predicate: lease live ⇒ zero rows
    await expect(acquireRunLease(RUN_ID, ['queued'])).resolves.toEqual({ token: TOKEN });
    await expect(acquireRunLease(RUN_ID, ['queued'])).resolves.toBeNull();
  });

  it('an expired lease is taken over (a new token)', async () => {
    const NEW = 'aaaaaaaa-0000-4000-8000-00000000000a';
    h.store.casAcquireLease.mockResolvedValueOnce({ id: RUN_ID, leaseToken: NEW, status: 'running' });
    await expect(acquireRunLease(RUN_ID, ['running'])).resolves.toEqual({ token: NEW });
  });
});

describe('checkpoint', () => {
  it('writes the fenced run row FIRST, then the step, in one transaction', async () => {
    h.store.fencedRunUpdate.mockImplementationOnce(async () => { h.order.push('run'); return true; });
    h.store.insertStepRow.mockImplementationOnce(async () => { h.order.push('step'); });
    const ok = await checkpoint(RUN_ID, TOKEN, { currentStepId: 's1' }, { insert: { id: 'x', runId: RUN_ID } as never });
    expect(ok).toBe(true);
    expect(h.order).toEqual(['tx:begin', 'run', 'step', 'tx:commit']);
    expect(h.store.fencedRunUpdate).toHaveBeenCalledWith(RUN_ID, TOKEN, { currentStepId: 's1' }, 'renew');
  });

  it('a superseded token writes nothing and returns false', async () => {
    h.store.fencedRunUpdate.mockResolvedValueOnce(false);
    const ok = await checkpoint(RUN_ID, TOKEN, { status: 'completed', finishedAt: new Date() },
      { update: { id: 'row', values: { status: 'completed' } } });
    expect(ok).toBe(false);
    expect(h.store.updateStepRow).not.toHaveBeenCalled();
    expect(h.store.insertStepRow).not.toHaveBeenCalled();
  });

  it('checkpoint on a terminal run returns false', async () => {
    // The fence includes status NOT IN terminal; a run an outside writer
    // finished matches zero rows exactly like a lost lease.
    h.store.fencedRunUpdate.mockResolvedValueOnce(false);
    await expect(checkpoint(RUN_ID, TOKEN, { currentStepId: 's2' })).resolves.toBe(false);
  });

  it('a terminal or park patch releases the lease; anything else renews it', async () => {
    h.store.fencedRunUpdate.mockResolvedValue(true);
    await checkpoint(RUN_ID, TOKEN, { status: 'failed', finishedAt: new Date(), errorCode: 'step_failed' });
    await checkpoint(RUN_ID, TOKEN, { status: 'awaiting_approval' }, undefined, { releaseLease: true });
    await checkpoint(RUN_ID, TOKEN, { activeMs: 5 });
    expect(h.store.fencedRunUpdate.mock.calls.map((c) => c[3])).toEqual(['release', 'release', 'renew']);
  });

  it('a step unique-key conflict rolls the whole checkpoint back and returns false', async () => {
    h.store.fencedRunUpdate.mockResolvedValueOnce(true);
    const conflict = Object.assign(new Error('duplicate key'), { code: '23505' });
    h.store.insertStepRow.mockRejectedValueOnce(conflict);
    const ok = await checkpoint(RUN_ID, TOKEN, {}, { insert: { id: 'x' } as never });
    expect(ok).toBe(false);
    expect(h.order).toContain('tx:rollback');
  });

  it('any other error propagates', async () => {
    h.store.fencedRunUpdate.mockRejectedValueOnce(new Error('connection reset'));
    await expect(checkpoint(RUN_ID, TOKEN, {})).rejects.toThrow('connection reset');
  });
});

describe('startLeaseHeartbeat', () => {
  it('renews every leaseRenewEveryMs while the step runs', async () => {
    vi.useFakeTimers();
    h.store.renewLease.mockResolvedValue(true);
    const hb = startLeaseHeartbeat(RUN_ID, TOKEN);
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(h.store.renewLease).toHaveBeenCalledTimes(3);
    expect(hb.lost()).toBe(false);
    hb.stop();
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(h.store.renewLease).toHaveBeenCalledTimes(3);
  });

  it('heartbeat renewal failure marks the slice lost', async () => {
    vi.useFakeTimers();
    h.store.renewLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const hb = startLeaseHeartbeat(RUN_ID, TOKEN);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hb.lost()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hb.lost()).toBe(true);
    hb.stop();
  });

  it('a throwing renewal also marks the slice lost', async () => {
    vi.useFakeTimers();
    h.store.renewLease.mockRejectedValueOnce(new Error('db down'));
    const hb = startLeaseHeartbeat(RUN_ID, TOKEN);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hb.lost()).toBe(true);
    hb.stop();
  });
});

describe('releaseRunLease', () => {
  it('releases only this token', async () => {
    await releaseRunLease(RUN_ID, TOKEN);
    expect(h.store.releaseLease).toHaveBeenCalledWith(RUN_ID, TOKEN);
  });
});
