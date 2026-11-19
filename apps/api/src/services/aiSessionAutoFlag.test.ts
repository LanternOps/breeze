import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateSets, updateImpl } = vi.hoisted(() => ({
  updateSets: [] as Array<Record<string, unknown>>,
  updateImpl: { fail: false },
}));

vi.mock('../db', () => ({
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  db: {
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        if (updateImpl.fail) throw new Error('db down');
        updateSets.push(values);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
    })),
  },
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import {
  flushDeferredToolFailureFlags,
  isCorrectableInputRefusal,
  isMcpInputValidationErrorText,
  recordToolOutcomeForAutoFlag,
  type AutoFlagSession,
} from './aiSessionAutoFlag';
import { captureException } from './sentry';
import { AUTO_FLAG_REASON_PREFIXES } from './aiModels/qualityQueries';

function session(): AutoFlagSession {
  return { breezeSessionId: 'sess-1', orgId: 'org-1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateSets.length = 0;
  updateImpl.fail = false;
});

describe('isCorrectableInputRefusal', () => {
  it('accepts the schema refusal and the coordinator invalid_params code only', () => {
    expect(isCorrectableInputRefusal('invalid_params')).toBe(true);
    expect(isCorrectableInputRefusal('Invalid input: limit: Too big')).toBe(true);
    expect(isCorrectableInputRefusal('Device is offline')).toBe(false);
    expect(isCorrectableInputRefusal('wisp_grant_required')).toBe(false);
    // Free text that merely mentions the code is not the code.
    expect(isCorrectableInputRefusal('upstream said invalid_params')).toBe(false);
    expect(isCorrectableInputRefusal(undefined)).toBe(false);
    expect(isCorrectableInputRefusal({ error: 'invalid_params' })).toBe(false);
  });
});

describe('isMcpInputValidationErrorText', () => {
  it('matches the MCP SDK input-validation refusal and nothing else', () => {
    expect(isMcpInputValidationErrorText(
      'MCP error -32602: Input validation error: Invalid arguments for tool set_device_context: [...]',
    )).toBe(true);
    expect(isMcpInputValidationErrorText('<tool_use_error>Error: No such tool available: x</tool_use_error>')).toBe(false);
  });
});

describe('recordToolOutcomeForAutoFlag + flushDeferredToolFailureFlags', () => {
  it('writes a held refusal at the turn end with the time the call failed, then forgets it', async () => {
    const s = session();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
      await recordToolOutcomeForAutoFlag(s, 'launch_specialist', { isError: true, errorCode: 'invalid_params', errorMsg: 'invalid_params' });
      vi.setSystemTime(new Date('2026-11-16T10:00:30Z'));
      expect(updateSets).toHaveLength(0);

      await flushDeferredToolFailureFlags(s);
    } finally {
      vi.useRealTimers();
    }

    expect(updateSets).toEqual([{
      flaggedAt: new Date('2026-11-16T10:00:00Z'),
      flagReason: 'Tool failed: launch_specialist — invalid_params',
    }]);
    // The quality report still recognises the reason as a platform flag.
    expect(AUTO_FLAG_REASON_PREFIXES.some((p) => String(updateSets[0]!.flagReason).startsWith(p))).toBe(true);

    await flushDeferredToolFailureFlags(s);
    expect(updateSets).toHaveLength(1);
  });

  it('flags the first uncorrected refusal when several tools were refused', async () => {
    const s = session();
    await recordToolOutcomeForAutoFlag(s, 'a_tool', { isError: true, errorCode: 'invalid_params', errorMsg: 'first' });
    await recordToolOutcomeForAutoFlag(s, 'a_tool', { isError: true, errorCode: 'invalid_params', errorMsg: 'second' });
    await recordToolOutcomeForAutoFlag(s, 'b_tool', { isError: true, errorCode: 'Invalid input: x', errorMsg: 'Invalid input: x' });
    await recordToolOutcomeForAutoFlag(s, 'a_tool', { isError: false, errorCode: undefined, errorMsg: '' });

    await flushDeferredToolFailureFlags(s);

    expect(updateSets.map((u) => u.flagReason)).toEqual(['Tool failed: b_tool — Invalid input: x']);
  });

  it('is a no-op at the turn end when nothing was held', async () => {
    await flushDeferredToolFailureFlags(session());
    expect(updateSets).toHaveLength(0);
  });

  it('a failed flag write is reported, never thrown', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    updateImpl.fail = true;

    await expect(recordToolOutcomeForAutoFlag(session(), 'execute_command', { isError: true, errorCode: 'boom', errorMsg: 'boom' }))
      .resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('[AI-SDK] Failed to auto-flag session:', 'sess-1', 'db down');
    errSpy.mockRestore();
  });
});
