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
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { createManualStepsOutcome, loadOutcomeSummaries, recordBuiltinOutcome, recordExecutionOutcome, recordOutcomeVote } from './outcomeRecorder';
import { captureException } from '../sentry';

// ONE top-level reset of ALL shared mock state. Every describe in this file
// (including the ones Task 19 appends) starts clean — no test may inherit
// insertThrows / insertResult / queued rows from another.
beforeEach(() => {
  h.rows.length = 0;
  h.values.mockReset();
  h.insertResult = [{ state: 'pending', stateReason: null, humanVote: null }];
  h.insertThrows = false;
  vi.mocked(captureException).mockReset();
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
    expect(captureException).not.toHaveBeenCalled();
  });

  it('never throws: a failed insert returns null, reports to Sentry, and leaves the dispatched script alone', async () => {
    h.rows.push([{ partnerId: 'p-1' }], [{ isSystem: true, orgId: null, partnerId: null }], [{ scriptVersionId: null }]);
    h.insertThrows = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordExecutionOutcome({ suggestion, deviceId: 'd-1', scriptExecutionId: 'e-1' })).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { component: 'fixMemory.outcomeRecorder' },
    );
    err.mockRestore();
  });

  it('warns and returns null (without throwing) when the org lookup misses', async () => {
    h.rows.push([], [{ isSystem: false, orgId: null, partnerId: 'p-1' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordExecutionOutcome({ suggestion, deviceId: 'd-1', scriptExecutionId: 'e-1' })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    // ids only — never suggestion title/rationale/output text.
    expect(warn.mock.calls[0]![0]).toContain(suggestion.id);
    expect(warn.mock.calls[0]![0]).toContain(suggestion.orgId);
    expect(h.values).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and returns null (without throwing) when the script lookup misses', async () => {
    h.rows.push([{ partnerId: 'p-1' }], []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordExecutionOutcome({ suggestion, deviceId: 'd-1', scriptExecutionId: 'e-1' })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(suggestion.id);
    expect(warn.mock.calls[0]![0]).toContain(suggestion.scriptId);
    expect(h.values).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is a silent idempotent no-op when the unique suggestion_id conflict fires (already recorded)', async () => {
    h.rows.push([{ partnerId: 'p-1' }], [{ isSystem: false, orgId: null, partnerId: 'p-1' }], [{ scriptVersionId: 'v-7' }]);
    h.insertResult = [];
    await expect(recordExecutionOutcome({ suggestion, deviceId: 'd-1', scriptExecutionId: 'e-1' })).resolves.toBeNull();
    expect(h.values).toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('votes and Done', () => {
  it('a vote requests a recount and replaces any earlier vote', async () => {
    h.rows.push([{ state: 'verified', stateReason: 'held_with_fresh_telemetry', humanVote: 'down' }]);
    await expect(recordOutcomeVote({ suggestionId: 'sg-1', orgId: 'org-1', vote: 'down', userId: 'u-1' }))
      .resolves.toEqual({ state: 'verified', stateReason: 'held_with_fresh_telemetry', humanVote: 'down' });
  });

  it('a vote on a suggestion with no recorded attempt returns null', async () => {
    h.rows.push([]);
    await expect(recordOutcomeVote({ suggestionId: 'sg-x', orgId: 'org-1', vote: 'up', userId: 'u-1' })).resolves.toBeNull();
  });

  it('Done starts a manual-steps attempt in awaiting_recovery with no aggregatable identity', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    h.insertResult = [{ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null }];
    await expect(createManualStepsOutcome({ suggestion: { id: 'sg-2', orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1' }, deviceId: 'd-1' }))
      .resolves.toEqual({ state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      fixKind: 'manual_steps', fixIdentity: null, state: 'awaiting_recovery', stateReason: 'manual_steps_done',
    }));
  });

  it('a second Done is reported as already recorded (null), not a new attempt', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    h.insertResult = [];
    await expect(createManualStepsOutcome({ suggestion: { id: 'sg-2', orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1' }, deviceId: 'd-1' }))
      .resolves.toBeNull();
  });

  it('summaries are keyed by suggestion id', async () => {
    h.rows.push([{ suggestionId: 'sg-1', state: 'holding', stateReason: 'condition_cleared', humanVote: null }]);
    const map = await loadOutcomeSummaries(['sg-1', 'sg-2']);
    expect(map.get('sg-1')).toEqual({ state: 'holding', stateReason: 'condition_cleared', humanVote: null });
    expect(map.has('sg-2')).toBe(false);
  });
});

describe('recordBuiltinOutcome (W2 Task 15)', () => {
  const builtin = { id: 'sg-2', orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1', builtinAction: 'restart_service' as const };
  it('writes a builtin_action attempt that follows the command and aggregates by action', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    await expect(recordBuiltinOutcome({ suggestion: builtin, deviceId: 'd-1', commandId: 'cmd-1', cleanupRunId: null }))
      .resolves.toEqual({ state: 'pending', stateReason: null, humanVote: null });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      fixKind: 'builtin_action', fixIdentity: 'builtin:restart_service', builtinAction: 'restart_service',
      actionCommandId: 'cmd-1', actionCleanupRunId: null, state: 'pending',
    }));
    expect(h.values.mock.calls[0]![0]).not.toHaveProperty('scriptExecutionId');
  });
  it('disk_cleanup carries the cleanup run id', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    await recordBuiltinOutcome({ suggestion: { ...builtin, builtinAction: 'disk_cleanup' }, deviceId: 'd-1', commandId: 'cmd-1', cleanupRunId: 'run-1' });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({ fixIdentity: 'builtin:disk_cleanup', actionCleanupRunId: 'run-1' }));
  });
  it('a row without a built-in action records nothing', async () => {
    await expect(recordBuiltinOutcome({ suggestion: { ...builtin, builtinAction: null }, deviceId: 'd-1', commandId: 'cmd-1', cleanupRunId: null })).resolves.toBeNull();
    expect(h.values).not.toHaveBeenCalled();
  });
  it('never throws and reports to Sentry', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    h.insertThrows = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordBuiltinOutcome({ suggestion: builtin, deviceId: 'd-1', commandId: 'cmd-1', cleanupRunId: null })).resolves.toBeNull();
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('Done with reviewed steps (W2 Task 16)', () => {
  const manual = { id: 'sg-3', orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1' };
  it('reviewed steps give a shareable identity', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    await createManualStepsOutcome({ suggestion: manual, deviceId: 'd-1', instructionsId: 'fi-1' });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({ fixKind: 'manual_steps', instructionsRef: 'fi-1', fixIdentity: 'instructions:fi-1' }));
  });
  it('unreviewed AI steps never aggregate (identity stays null)', async () => {
    h.rows.push([{ partnerId: 'p-1' }]);
    await createManualStepsOutcome({ suggestion: manual, deviceId: 'd-1' });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({ instructionsRef: null, fixIdentity: null }));
  });
});
