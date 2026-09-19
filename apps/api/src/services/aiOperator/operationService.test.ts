import { describe, it, expect, vi, beforeEach } from 'vitest';

// #5205 W04 (#5209), baseline §4: `recordOperationResult` / `recordOperationExecutionRef` /
// `markOperationDispatchFailed` run AFTER a real-world side effect has
// already happened (a device command dispatched, a result arrived, a claim
// was lost). Throwing out of one of them would fail an action that already
// succeeded, so `runOperationWrite` (operationService.ts) swallows the
// underlying write's rejection, logs it, and reports it to Sentry instead.
// This file is the one place that proves the SWALLOW itself — every other
// operationService test exercises these functions through the release
// worker, where a rejection would otherwise be invisible (the worker never
// awaits-and-catches these calls; it relies on them never throwing).
//
// `../../db` is stubbed rather than imported for real: these functions issue
// exactly one `db.update(...).set(...).where(...)` statement each, and what
// this file needs to control is whether THAT final promise resolves or
// rejects — not drizzle-orm's query-builder behavior, which the real
// dialect/integration suites already cover.
const { updateWhereMock, sentryMock } = vi.hoisted(() => ({
  /** The mocked terminal `.where(...)` call every writer here ends on. Each
   *  test sets its own resolution via `mockResolvedValueOnce`/
   *  `mockRejectedValueOnce` — no shared default, so a forgotten prime fails
   *  loud (unhandled mock call) rather than silently passing either way. */
  updateWhereMock: vi.fn(),
  sentryMock: { captureException: vi.fn() },
}));

vi.mock('../../db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: updateWhereMock,
      })),
    })),
  },
  // Real callers wrap every write in its own system-scoped context
  // (runOperationWrite); the mock just runs the callback inline, which is
  // enough to prove the try/catch around it, not the context boundary
  // itself (that belongs to db/index.ts's own tests).
  withSystemDbAccessContext: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../sentry', () => ({
  captureException: sentryMock.captureException,
}));

import {
  recordOperationResult,
  recordOperationExecutionRef,
  markOperationDispatchFailed,
} from './operationService';

const INTENT_ID = 'intent-1';

describe('operationService: runOperationWrite swallow contract (#5205 W04, baseline §4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('recordOperationResult', () => {
    it('resolves rather than throws when the underlying update REJECTS, and reports it to Sentry', async () => {
      updateWhereMock.mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        recordOperationResult({ intentId: INTENT_ID, resultState: 'succeeded', result: { ok: true } }),
      ).resolves.toBeUndefined();

      expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    });

    it('positive control: a successful write resolves and does NOT call captureException', async () => {
      // Without this control, the rejection case above could pass on a
      // stubbed no-op writer that never really calls captureException on
      // ANY input — this proves the mock (and the real function) actually
      // discriminates between the two outcomes.
      updateWhereMock.mockResolvedValueOnce(undefined);

      await expect(
        recordOperationResult({ intentId: INTENT_ID, resultState: 'succeeded', result: { ok: true } }),
      ).resolves.toBeUndefined();

      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });
  });

  describe('recordOperationExecutionRef', () => {
    it('resolves rather than throws when the underlying update REJECTS, and reports it to Sentry', async () => {
      updateWhereMock.mockRejectedValueOnce(new Error('connection reset'));

      await expect(
        recordOperationExecutionRef(INTENT_ID, { kind: 'device_command', id: 'cmd-1' }),
      ).resolves.toBeUndefined();

      expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    });

    it('positive control: a successful write resolves and does NOT call captureException', async () => {
      updateWhereMock.mockResolvedValueOnce(undefined);

      await expect(
        recordOperationExecutionRef(INTENT_ID, { kind: 'device_command', id: 'cmd-1' }),
      ).resolves.toBeUndefined();

      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });
  });

  describe('markOperationDispatchFailed', () => {
    it('resolves rather than throws when the underlying update REJECTS, and reports it to Sentry', async () => {
      updateWhereMock.mockRejectedValueOnce(new Error('connection reset'));

      await expect(markOperationDispatchFailed(INTENT_ID, 'claim_refused')).resolves.toBeUndefined();

      expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    });

    it('positive control: a successful write resolves and does NOT call captureException', async () => {
      updateWhereMock.mockResolvedValueOnce(undefined);

      await expect(markOperationDispatchFailed(INTENT_ID, 'claim_refused')).resolves.toBeUndefined();

      expect(sentryMock.captureException).not.toHaveBeenCalled();
    });
  });
});
