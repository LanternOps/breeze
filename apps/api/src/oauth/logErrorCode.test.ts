import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrantErrorLogger } from './grantErrorLog';
import { ERROR_IDS, logOauthError, logOauthWarn } from './log';

// Exercises the REAL log functions (no mock of ./log): the grant error code in
// context.error must survive when no `err` is passed.
describe('oauth log lines keep context.error', () => {
  afterEach(() => vi.restoreAllMocks());

  it('grantErrorLog path: warn line keeps error=invalid_grant', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createGrantErrorLogger()(
      { oidc: { client: { clientId: 'c1' }, params: { grant_type: 'refresh_token', refresh_token: 'x' } } },
      { error: 'invalid_grant', error_detail: 'grant request is invalid' },
    );
    const payload = warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.error).toBe('invalid_grant');
    expect(payload.client_id).toBe('c1');
    expect(payload.client_resolved).toBe(true);
  });

  it('marks client_resolved=false when client_id only came from the request body', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createGrantErrorLogger()(
      { oidc: { params: { grant_type: 'refresh_token', client_id: 'spoofed' } } },
      { error: 'invalid_grant' },
    );
    const payload = warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.client_id).toBe('spoofed');
    expect(payload.client_resolved).toBe(false);
  });

  it('error level keeps context.error when err is undefined', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logOauthError({ errorId: ERROR_IDS.OAUTH_PROVIDER_GRANT_ERROR, message: 'm', context: { error: 'invalid_grant' } });
    expect((spy.mock.calls[0]![1] as Record<string, unknown>).error).toBe('invalid_grant');
  });

  it('serializes an Error when err is passed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('boom');
    logOauthWarn({ errorId: ERROR_IDS.OAUTH_PROVIDER_GRANT_ERROR, message: 'm', err, context: { error: 'invalid_grant' } });
    expect((warn.mock.calls[0]![1] as { error: unknown }).error).toMatchObject({ name: 'Error', message: 'boom', stack: err.stack });
  });
});
