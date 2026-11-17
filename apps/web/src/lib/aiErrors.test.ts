import { describe, expect, it } from 'vitest';
import { activeRetryTarget, classifyHttpFailure, isRetryableAiError, retryModeFor } from './aiErrors';

describe('isRetryableAiError (#9428)', () => {
  it.each([
    ['timeout', true],
    ['disconnect', true],
    ['http_5xx', true],
    ['provider_error', true],
    ['stream_error', true],
    ['rate_limited', false],
    ['rejected', false],
    ['provider_auth', false],
    ['provider_quota', false],
    ['context_window_exceeded', false],
    ['budget_exceeded', false],
    ['turn_limit_reached', false],
    ['config_changed', false],
    ['session_expired', false],
    ['session_evicted', false],
    ['topology_limit', false],
    ['topology_failed', false],
    // Refusal codes a send can carry: never a retry.
    ['topology_ai_disabled', false],
    ['session_closed', false],
    ['something_new', false],
    ['', false],
    [null, false],
    [undefined, false],
  ] as const)('%s → %s', (code, retryable) => {
    expect(isRetryableAiError(code)).toBe(retryable);
  });
});

describe('activeRetryTarget (#9428)', () => {
  const target = { sessionId: 's', content: 'c', code: 'timeout', detail: null, mode: 'retry', error: 'timed out' } as const;
  it('returns the target while the banner still shows its error', () => {
    expect(activeRetryTarget({ error: 'timed out', retryTarget: target })).toBe(target);
  });
  it('a different (later) error or no error retires it', () => {
    expect(activeRetryTarget({ error: 'Failed to approve', retryTarget: target })).toBeNull();
    expect(activeRetryTarget({ error: null, retryTarget: target })).toBeNull();
    expect(activeRetryTarget({ error: 'timed out', retryTarget: null })).toBeNull();
  });
});

describe('retryModeFor (#9428)', () => {
  it.each([
    ['timeout', 'retry'], ['provider_error', 'retry'],
    ['disconnect', 'reload_first'], ['stream_error', 'reload_first'],
    ['http_5xx', 'resend'],
  ] as const)('%s → %s', (code, mode) => {
    expect(retryModeFor(code)).toBe(mode);
  });
});

describe('classifyHttpFailure (#9428)', () => {
  it.each([
    [500, 'http_5xx'],
    [502, 'http_5xx'],
    [503, 'http_5xx'],
    [429, 'rate_limited'],
    [403, 'rejected'],
    [400, 'rejected'],
    [404, 'rejected'],
  ] as const)('%s → %s', (status, code) => {
    expect(classifyHttpFailure(status)).toBe(code);
  });
});
