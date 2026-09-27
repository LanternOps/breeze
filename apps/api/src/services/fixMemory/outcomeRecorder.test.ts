import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[][],
  values: vi.fn(),
  insertResult: [] as unknown[],
  insertThrows: false,
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  // select/update chains share one thenable: every awaited chain yields the next queued `rows` entry.
  for (const m of ['select', 'from', 'where', 'limit', 'update', 'set', 'returning']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(r);
  (chain as { insert: unknown }).insert = vi.fn(() => ({
    values: (v: unknown) => {
      h.values(v);
      return { onConflictDoNothing: () => ({ returning: async () => { if (h.insertThrows) throw new Error('23503'); return h.insertResult; } }) };
    },
  }));
  return { db: chain, withDbTransaction: (fn: () => unknown) => fn() };
});

import { recordExecutionOutcome } from './outcomeRecorder';

// ONE top-level reset of ALL shared mock state. Every describe in this file
// (including the ones Task 19 appends) starts clean — no test may inherit
// insertThrows / insertResult / queued rows from another.
beforeEach(() => {
  h.rows.length = 0;
  h.values.mockReset();
  h.insertResult = [{ state: 'pending', stateReason: null, humanVote: null }];
  h.insertThrows = false;
});

const suggestion = { id: 'sg-1', orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1', scriptId: 's-1' };

describe('recordExecutionOutcome', () => {
  it('records a pending attempt pinned to the dispatched script version and returns its summary', async () => {
    h.rows.push([{ partnerId: 'p-1' }], [{ isSystem: false, orgId: null, partnerId: 'p-1' }], [{ scriptVersionId: 'v-7' }]);
    await expect(recordExecutionOutcome({ suggestion, deviceId: 'd-1', scriptExecutionId: 'e-1' }))
      .resolves.toEqual({ state: 'pending', stateReason: null, humanVote: null });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', suggestionId: 'sg-1', sourceType: 'alert', sourceId: 'a-1',
      alertId: 'a-1', fixKind: 'partner_script', fixIdentity: 'script_version:v-7', scriptVersionId: 'v-7',
      scriptExecutionId: 'e-1', state: 'pending',
    }));
    const deadline = (h.values.mock.calls[0]![0] as { deadlineAt: Date }).deadlineAt.getTime();
    expect(deadline - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });

  it('never throws: a failed insert returns null and leaves the dispatched script alone', async () => {
    h.rows.push([{ partnerId: 'p-1' }], [{ isSystem: true, orgId: null, partnerId: null }], [{ scriptVersionId: null }]);
    h.insertThrows = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordExecutionOutcome({ suggestion, deviceId: 'd-1', scriptExecutionId: 'e-1' })).resolves.toBeNull();
    err.mockRestore();
  });
});
