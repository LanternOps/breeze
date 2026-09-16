/**
 * #6022 — the post-handoff terminal read-back.
 *
 * Two contracts live here:
 *  1. `TERMINAL_INTENT_STATUSES` (duplicated as plain strings in the LEAF
 *     module `services/aiToolHandoff.ts`) agrees with the schema's
 *     `actionIntentStatusEnum`. If someone adds a ninth intent status, this
 *     fails and forces a decision about whether the chat should report it.
 *  2. `waitForIntentTerminalOutcome` is an OBSERVER: it returns the terminal
 *     snapshot when there is one, gives up on budget/abort without writing
 *     anything, and never mistakes an unreadable row for a failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('../../db', () => ({
  db: { select: selectMock, update: vi.fn(), insert: vi.fn() },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { waitForIntentTerminalOutcome } from './intentService';
import { actionIntentStatusEnum } from '../../db/schema/actionIntents';
import { TERMINAL_INTENT_STATUSES, isTerminalIntentStatus } from '../aiToolHandoff';

/** One `db.select(...).from(...).where(...).limit(1)` chain returning `rows`. */
function queueRows(...batches: Array<Array<Record<string, unknown>>>) {
  selectMock.mockReset();
  for (const rows of batches) {
    selectMock.mockImplementationOnce(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }));
  }
}

describe('TERMINAL_INTENT_STATUSES parity with the schema enum', () => {
  it('every terminal status is a real intent status', () => {
    for (const status of TERMINAL_INTENT_STATUSES) {
      expect(actionIntentStatusEnum).toContain(status);
    }
  });

  it('every schema status is classified as terminal or live — none unaccounted for', () => {
    const live = ['pending_approval', 'approved', 'executing'];
    for (const status of actionIntentStatusEnum) {
      expect(isTerminalIntentStatus(status) || live.includes(status)).toBe(true);
    }
    expect(TERMINAL_INTENT_STATUSES.length + live.length).toBe(actionIntentStatusEnum.length);
  });
});

describe('waitForIntentTerminalOutcome (#6022)', () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it('returns the terminal snapshot with the error the tool actually reported', async () => {
    const guardrail = 'Arming autoInstall requires a human operator with devices.execute and MFA;';
    queueRows([{ status: 'failed', errorCode: 'tool_returned_error', result: { error: guardrail } }]);

    await expect(waitForIntentTerminalOutcome('intent-1', 2000)).resolves.toEqual({
      status: 'failed',
      errorCode: 'tool_returned_error',
      result: { error: guardrail },
    });
    // Terminal on the FIRST read — no polling, no extra latency on the turn.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('polls past a non-terminal read until the worker terminalizes', async () => {
    queueRows(
      [{ status: 'executing', errorCode: null, result: null }],
      [{ status: 'completed', errorCode: null, result: { ok: true } }],
    );

    await expect(waitForIntentTerminalOutcome('intent-2', 2000)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on the budget and returns the last NON-terminal snapshot, writing nothing', async () => {
    queueRows([{ status: 'executing', errorCode: null, result: null }]);

    // Budget 0 still takes exactly one read (a sibling wait may have drained
    // the shared approval budget, and the refusal is already committed).
    await expect(waitForIntentTerminalOutcome('intent-3', 0)).resolves.toEqual({
      status: 'executing',
      errorCode: null,
      result: null,
    });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('returns null — never a fabricated failure — when the row cannot be read', async () => {
    queueRows([]);
    await expect(waitForIntentTerminalOutcome('intent-4', 2000)).resolves.toBeNull();
  });

  it('returns null when the query throws for the whole budget', async () => {
    selectMock.mockReset();
    selectMock.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(waitForIntentTerminalOutcome('intent-5', 0)).resolves.toBeNull();
  });

  it('stops immediately when the wait is settled (new user message / interrupt)', async () => {
    queueRows([{ status: 'executing', errorCode: null, result: null }]);
    const aborted = AbortSignal.abort();
    await expect(waitForIntentTerminalOutcome('intent-6', 5000, aborted)).resolves.toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });
});
