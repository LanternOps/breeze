import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import { captureException, isSentryEnabled } from '../services/sentry';
import { ERROR_IDS, logOauthWarn } from './log';

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  isSentryEnabled: vi.fn(() => true),
}));

vi.mock('@sentry/node', () => ({
  withScope: vi.fn(),
}));

describe('logOauthWarn', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(isSentryEnabled).mockReturnValue(true);
  });

  it('keeps the stack on the stderr record so the failure is still debuggable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('stamp failed');

    logOauthWarn({
      errorId: ERROR_IDS.OAUTH_CLIENT_LAST_USED_STAMP_FAILED,
      message: 'advisory write failed',
      err,
      context: { clientId: 'client_abc' },
    });

    const [line, payload] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(line).toContain('OAUTH_CLIENT_LAST_USED_STAMP_FAILED');
    expect(payload).toMatchObject({ clientId: 'client_abc' });
    expect((payload.error as { stack?: string }).stack).toBe(err.stack);
  });

  // A one-off advisory failure is noise, but a sustained one silently
  // reintroduces the bug #5610 fixes (clients look stale and get GC'd), so it
  // has to reach Sentry — at `warning` level, not `error`.
  it('captures to Sentry at warning level, tagged by errorId', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setLevel = vi.fn();
    const setTag = vi.fn();
    const setContext = vi.fn();
    vi.mocked(Sentry.withScope).mockImplementation(((fn: (s: unknown) => void) => {
      fn({ setLevel, setTag, setContext });
    }) as unknown as typeof Sentry.withScope);
    const err = new Error('stamp failed');

    logOauthWarn({
      errorId: ERROR_IDS.OAUTH_CLIENT_LAST_USED_STAMP_FAILED,
      message: 'advisory write failed',
      err,
    });

    expect(setLevel).toHaveBeenCalledWith('warning');
    expect(setTag).toHaveBeenCalledWith('errorId', ERROR_IDS.OAUTH_CLIENT_LAST_USED_STAMP_FAILED);
    expect(captureException).toHaveBeenCalledWith(err);
  });

  it('does not reach Sentry when Sentry is disabled', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(isSentryEnabled).mockReturnValue(false);

    logOauthWarn({
      errorId: ERROR_IDS.OAUTH_CLIENT_LAST_USED_STAMP_FAILED,
      message: 'advisory write failed',
      err: new Error('nope'),
    });

    expect(captureException).not.toHaveBeenCalled();
  });
});
