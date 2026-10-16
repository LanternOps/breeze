import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./log')>();
  return {
    ...actual,
    logOauthError: vi.fn(),
    logOauthWarn: vi.fn(),
    logOauthDebug: vi.fn(),
  };
});

import { ERROR_IDS, logOauthDebug, logOauthError, logOauthWarn } from './log';
import { createGrantErrorLogger, grantErrorContext } from './grantErrorLog';

const warnMock = vi.mocked(logOauthWarn);
const errorMock = vi.mocked(logOauthError);
const debugMock = vi.mocked(logOauthDebug);

const RAW_RT = 'raw-refresh-token-value-never-logged';

function invalidGrant(detail = 'refresh token not found') {
  return Object.assign(new Error('invalid_grant'), {
    name: 'InvalidGrant',
    error: 'invalid_grant',
    error_detail: detail,
    statusCode: 400,
  });
}

function refreshCtx(clientId: string | undefined, opts: { paramsClientId?: string; userAgent?: string } = {}) {
  return {
    oidc: {
      client: clientId ? { clientId } : undefined,
      params: {
        grant_type: 'refresh_token',
        refresh_token: RAW_RT,
        client_id: opts.paramsClientId ?? clientId,
      },
    },
    get: (name: string) => (name.toLowerCase() === 'user-agent' ? opts.userAgent ?? 'Hermes-Agent/0.21.7' : ''),
  };
}

describe('grant.error logger', () => {
  let now = 1_000_000;
  beforeEach(() => {
    vi.clearAllMocks();
    now = 1_000_000;
  });

  it('attributes the failure to a client, grant type, token hash and user agent', () => {
    const log = createGrantErrorLogger({ now: () => now });
    log(refreshCtx('client-a'), invalidGrant());

    expect(warnMock).toHaveBeenCalledTimes(1);
    const args = warnMock.mock.calls[0]![0];
    expect(args.errorId).toBe(ERROR_IDS.OAUTH_PROVIDER_GRANT_ERROR);
    expect(args.context).toMatchObject({
      error: 'invalid_grant',
      detail: 'refresh token not found',
      grant_type: 'refresh_token',
      client_id: 'client-a',
      token_hash: createHash('sha256').update(RAW_RT).digest('hex').slice(0, 16),
      user_agent: 'Hermes-Agent/0.21.7',
      suppressed: 0,
    });
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('never logs the raw refresh token or a stack for client errors', () => {
    const log = createGrantErrorLogger({ now: () => now });
    log(refreshCtx('client-a'), invalidGrant());

    const serialized = JSON.stringify(warnMock.mock.calls[0]![0]);
    expect(serialized).not.toContain(RAW_RT);
    expect(serialized).not.toContain('stack');
    expect(warnMock.mock.calls[0]![0].err).toBeUndefined();
  });

  it('falls back to the client_id request param when client authentication did not resolve a client', () => {
    const log = createGrantErrorLogger({ now: () => now });
    log(refreshCtx(undefined, { paramsClientId: 'from-params' }), invalidGrant());

    expect(warnMock.mock.calls[0]![0].context).toMatchObject({ client_id: 'from-params' });
  });

  it('emits one line per client per window and reports how many repeats it suppressed', () => {
    const log = createGrantErrorLogger({ now: () => now, windowMs: 60_000 });
    log(refreshCtx('client-a'), invalidGrant());
    now += 1_000;
    log(refreshCtx('client-a'), invalidGrant());
    now += 1_000;
    log(refreshCtx('client-a'), invalidGrant());

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(debugMock).toHaveBeenCalledTimes(2);

    now += 60_000;
    log(refreshCtx('client-a'), invalidGrant());
    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(warnMock.mock.calls[1]![0].context).toMatchObject({ client_id: 'client-a', suppressed: 2 });
  });

  it('does not let one looping client hide failures from another client', () => {
    const log = createGrantErrorLogger({ now: () => now });
    log(refreshCtx('client-a'), invalidGrant());
    log(refreshCtx('client-a'), invalidGrant());
    log(refreshCtx('client-b'), invalidGrant());

    expect(warnMock).toHaveBeenCalledTimes(2);
    expect(warnMock.mock.calls.map((c) => c[0].context?.client_id)).toEqual(['client-a', 'client-b']);
  });

  it('keeps distinct error details for the same client on separate budgets', () => {
    const log = createGrantErrorLogger({ now: () => now });
    log(refreshCtx('client-a'), invalidGrant('refresh token not found'));
    log(refreshCtx('client-a'), invalidGrant('grant request is invalid'));

    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it.each(['client mismatch', 'failed jkt verification', 'failed x5t#S256 verification'])(
    'logs the token-theft signal %s at error level every time, unthrottled',
    (detail) => {
      const log = createGrantErrorLogger({ now: () => now });
      log(refreshCtx('client-a'), invalidGrant(detail));
      log(refreshCtx('client-a'), invalidGrant(detail));

      expect(errorMock).toHaveBeenCalledTimes(2);
      expect(errorMock.mock.calls[0]![0].context).toMatchObject({ client_id: 'client-a', detail });
      expect(JSON.stringify(errorMock.mock.calls[0]![0].context)).not.toContain(RAW_RT);
      expect(warnMock).not.toHaveBeenCalled();
    },
  );

  it('caps attacker-controlled strings so a huge client_id cannot bloat log lines or throttle state', () => {
    const log = createGrantErrorLogger({ now: () => now });
    const huge = 'x'.repeat(64 * 1024);
    log({ oidc: { params: { grant_type: huge, client_id: huge } } }, invalidGrant('client not found'));

    const context = warnMock.mock.calls[0]![0].context!;
    expect(String(context.client_id).length).toBeLessThanOrEqual(128);
    expect(String(context.grant_type).length).toBeLessThanOrEqual(128);
  });

  it('hashes the authorization code, not a refresh token, for authorization_code grants', () => {
    const log = createGrantErrorLogger({ now: () => now });
    log(
      { oidc: { client: { clientId: 'client-a' }, params: { grant_type: 'authorization_code', code: 'raw-code', refresh_token: RAW_RT } } },
      invalidGrant('authorization code not found'),
    );

    expect(warnMock.mock.calls[0]![0].context).toMatchObject({
      token_hash: createHash('sha256').update('raw-code').digest('hex').slice(0, 16),
    });
  });

  it('never throws from a hostile context', () => {
    const hostile = { get oidc() { throw new Error('not initialised'); } };
    expect(grantErrorContext(hostile)).toEqual({ grant_type: null, client_id: null, client_resolved: false, token_hash: null, user_agent: null });
    const log = createGrantErrorLogger({ now: () => now });
    expect(() => log(hostile, invalidGrant())).not.toThrow();
  });

  it('exposes the same attribution for the server_error listener', () => {
    expect(grantErrorContext(refreshCtx('client-a'))).toMatchObject({
      client_id: 'client-a',
      grant_type: 'refresh_token',
      user_agent: 'Hermes-Agent/0.21.7',
    });
  });

  it('bounds its throttle state so a flood of distinct client ids cannot grow memory without limit', () => {
    const log = createGrantErrorLogger({ now: () => now, maxKeys: 3 });
    for (let i = 0; i < 10; i += 1) log(refreshCtx(`client-${i}`), invalidGrant());
    // Every distinct client still gets its first line.
    expect(warnMock).toHaveBeenCalledTimes(10);
    // After eviction, an evicted client logs again instead of being silently suppressed.
    log(refreshCtx('client-0'), invalidGrant());
    expect(warnMock).toHaveBeenCalledTimes(11);
  });

  it('tolerates a context without oidc params', () => {
    const log = createGrantErrorLogger({ now: () => now });
    expect(() => log({}, invalidGrant())).not.toThrow();
    expect(warnMock.mock.calls[0]![0].context).toMatchObject({ client_id: null, token_hash: null });
  });
});
