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

  it('normalizes plain-object ApiError throws into a real Error keyed on area and status', () => {
    // services/api.ts throws object literals, not Error instances.
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
