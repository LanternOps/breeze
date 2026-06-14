import { describe, it, expect, vi, beforeEach } from 'vitest';

const captureException = vi.fn();
vi.mock('@sentry/astro', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));

import { captureRenderError } from './captureRenderError';

describe('captureRenderError', () => {
  beforeEach(() => {
    captureException.mockReset();
  });

  it('returns null and does not call Sentry when there is no error', () => {
    expect(captureRenderError(undefined)).toBeNull();
    expect(captureRenderError(null)).toBeNull();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('captures the error and returns the Sentry event id', () => {
    captureException.mockReturnValue('evt_123');
    const err = new Error('boom');
    expect(captureRenderError(err)).toBe('evt_123');
    expect(captureException).toHaveBeenCalledWith(err);
  });

  it('returns null when Sentry returns no event id', () => {
    captureException.mockReturnValue(undefined);
    expect(captureRenderError(new Error('boom'))).toBeNull();
  });

  it('returns null when Sentry itself throws (error page must never break)', () => {
    captureException.mockImplementation(() => {
      throw new Error('sentry down');
    });
    expect(captureRenderError(new Error('boom'))).toBeNull();
  });
});
