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

// R2a review: a secret-bearing result (m365_create_user / reset) is sealed on
// `action_intents.result`, where the one-time reveal and the expiry reaper burn
// it. The operation row is never burned, so it must never receive the sealed
// (or a legacy plaintext) credential; every other key is kept.
describe('recordOperationResult: sealed-secret keys never reach the operation row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips the sealed and legacy credential keys and keeps every other key', async () => {
    const { db } = await import('../../db');
    const { TEMP_PASSWORD_ENC_KEY, TEMP_PASSWORD_LEGACY_KEY, TEMP_PASSWORD_SEAL_FAILED_KEY } = await import('../actionIntents/resultSecrets');
    updateWhereMock.mockResolvedValueOnce(undefined);
    const result = {
      success: true, action: 'm365.user.create', userId: '00000000-0000-4000-8000-0000000a0001',
      userPrincipalName: 'priya@customer.example', forceChangeNextSignIn: true, noop: false, verified: true,
      [TEMP_PASSWORD_ENC_KEY]: 'enc:v3:sealed-test-value', [TEMP_PASSWORD_LEGACY_KEY]: 'legacy-test-value',
    };
    await recordOperationResult({ intentId: INTENT_ID, resultState: 'succeeded', result });

    const update = vi.mocked(db.update);
    expect(update).toHaveBeenCalledTimes(1);
    const setFn = (update.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> }).set;
    const written = (setFn.mock.calls[0]![0] as { result: Record<string, unknown> }).result;
    expect(written).toEqual({
      success: true, action: 'm365.user.create', userId: '00000000-0000-4000-8000-0000000a0001',
      userPrincipalName: 'priya@customer.example', forceChangeNextSignIn: true, noop: false, verified: true,
    });
    expect(JSON.stringify(written)).not.toContain('test-value');
    // The caller's object is not mutated (the intent row keeps its sealed form).
    expect(result[TEMP_PASSWORD_ENC_KEY]).toBe('enc:v3:sealed-test-value');
    // A seal-failed marker carries no secret and is kept.
    updateWhereMock.mockResolvedValueOnce(undefined);
    await recordOperationResult({ intentId: INTENT_ID, resultState: 'succeeded', result: { success: true, [TEMP_PASSWORD_SEAL_FAILED_KEY]: true } });
    const setFn2 = (update.mock.results[1]!.value as { set: ReturnType<typeof vi.fn> }).set;
    expect((setFn2.mock.calls[0]![0] as { result: unknown }).result).toEqual({ success: true, [TEMP_PASSWORD_SEAL_FAILED_KEY]: true });
  });
});
