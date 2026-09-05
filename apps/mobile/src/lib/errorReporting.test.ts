import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the service layer so importing errorReporting never pulls
// expo-secure-store (the node-only vitest runtime can't parse native modules).
vi.mock('../services/api', () => ({
  DEVICE_BLOCKED_CODE: 'device_blocked',
}));

const sentry = { captureException: vi.fn() };
vi.mock('@sentry/react-native', () => ({
  captureException: (...a: unknown[]) => sentry.captureException(...a),
}));

import { reportInternalError } from './errorReporting';

beforeEach(() => {
  sentry.captureException.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('reportInternalError', () => {
  it('passes real Error instances through unchanged, tagged with the area', () => {
    const err = new Error('getAiSessionMessages failed: 404');
    reportInternalError(err, 'ai-sessions-history');

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, hint] = sentry.captureException.mock.calls[0];
    expect(captured).toBe(err);
    expect(hint).toEqual({ tags: { area: 'ai-sessions-history' } });
  });

  it('normalizes plain-object throws into a real Error keyed on area and status', () => {
    // services/api.ts itself now throws a real ApiError (#4747, see the test
    // below) — this exercises the defensive fallback for anything ELSE that
    // still throws a plain object shaped like the old ApiError interface (a
    // stubbed test double, a third-party rejection).
    const apiError = { message: 'An error occurred', statusCode: 500 };
    reportInternalError(apiError, 'device-metrics');

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, hint] = sentry.captureException.mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('device-metrics failed: 500 An error occurred');
    expect(hint).toEqual({
      tags: { area: 'device-metrics' },
      extra: { apiError },
    });
  });

  it('attaches code/statusCode as extra for a real Error that carries them (e.g. ApiError)', () => {
    // A real `ApiError` instance (#4747) is `instanceof Error`, so it takes the
    // "pass through unchanged" branch above — but Sentry does not auto-serialize
    // a thrown Error subclass's own `code`/`statusCode` properties. Without this,
    // the HTTP status/code silently stopped reaching Sentry's tags/extra the
    // moment ApiError became a real Error (it used to always take the
    // `extra: { apiError: err }` branch). Simulated here without importing the
    // real ApiError class, since this file mocks `../services/api` to keep
    // expo-secure-store out of the node test runtime.
    const err = Object.assign(new Error('Too many attempts'), {
      name: 'ApiError',
      code: 'rate_limited',
      statusCode: 429,
    });
    reportInternalError(err, 'change-password');

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, hint] = sentry.captureException.mock.calls[0];
    expect(captured).toBe(err);
    expect(hint).toEqual({
      tags: { area: 'change-password' },
      extra: { code: 'rate_limited', statusCode: 429 },
    });
  });

  it('tolerates non-object throws', () => {
    reportInternalError('boom', 'systems-data');

    const [captured] = sentry.captureException.mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('systems-data failed: ? boom');
  });

  it('skips reporting expected blocked-device responses', () => {
    reportInternalError(
      { message: 'Device blocked', code: 'device_blocked', statusCode: 403 },
      'systems-data',
    );

    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
