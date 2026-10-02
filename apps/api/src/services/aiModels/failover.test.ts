import { describe, expect, it } from 'vitest';
import {
  classifyProviderError,
  classifyProviderStatus,
  classifySdkAssistantError,
  hopIdempotencyKey,
  shouldFailOverNow,
  TRANSIENT_FAILOVER_CAUSES,
} from './failover';

/** The shape @anthropic-ai/sdk's APIError carries: status + parsed body. */
function apiError(status: number, type: string | null, message = 'x') {
  return Object.assign(new Error(message), {
    status,
    error: type ? { type: 'error', error: { type, message } } : undefined,
  });
}

describe('classifyProviderStatus (D8)', () => {
  it.each([
    [529, null, null, 'overloaded'],
    [429, null, null, 'rate_limited'],
    [402, null, null, 'quota_exhausted'],
    [401, null, null, 'auth_failed'],
    [403, null, null, 'auth_failed'],
    [500, null, null, 'server_error'],
    [503, null, null, 'server_error'],
    [400, 'invalid_request_error', 'Your credit balance is too low to access the API', 'quota_exhausted'],
    [400, 'invalid_request_error', 'messages: field required', null],
    [404, 'not_found_error', 'model: x', null],
    [413, null, null, null],
    [null, null, null, null],
  ] as const)('%s %s → %s', (status, type, msg, expected) => {
    expect(classifyProviderStatus(status, type, msg)).toBe(expected);
  });

  it('the error type wins over the status', () => {
    expect(classifyProviderStatus(500, 'overloaded_error')).toBe('overloaded');
  });
});

describe('classifyProviderError (Messages API)', () => {
  it('reads an APIError directly', () => {
    expect(classifyProviderError(apiError(529, 'overloaded_error'))).toBe('overloaded');
  });

  it('unwraps a surface error that carries the APIError as its cause (Office draft)', () => {
    const wrapped = new Error('Failed to draft', { cause: apiError(429, 'rate_limit_error') });
    expect(classifyProviderError(wrapped)).toBe('rate_limited');
  });

  it('a timeout (no status) is never failover-eligible: the outcome is unknown', () => {
    const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    expect(classifyProviderError(timeout)).toBeNull();
    expect(classifyProviderError(new DOMException('aborted', 'TimeoutError'))).toBeNull();
  });

  it('gives up after five cause levels', () => {
    let e: Error = apiError(529, 'overloaded_error');
    for (let i = 0; i < 6; i++) e = new Error(`wrap ${i}`, { cause: e });
    expect(classifyProviderError(e)).toBeNull();
  });
});

describe('classifySdkAssistantError (Agent SDK)', () => {
  it.each([
    ['rate_limit', null, 'rate_limited'],
    ['overloaded', 529, 'overloaded'],
    ['server_error', 500, 'server_error'],
    ['authentication_failed', 401, 'auth_failed'],
    ['billing_error', 400, 'quota_exhausted'],
    ['invalid_request', 400, null],
    ['model_not_found', 404, null],
    ['max_output_tokens', null, null],
    ['unknown', 503, 'server_error'],
    [null, 529, 'overloaded'],
  ] as const)('%s / %s → %s', (err, status, expected) => {
    expect(classifySdkAssistantError(err, status)).toBe(expected);
  });
});

describe('hopIdempotencyKey', () => {
  it('hop 0 keeps the base key; later hops are deterministic', () => {
    expect(hopIdempotencyKey('ai-agent-run:r1', 0)).toBe('ai-agent-run:r1');
    expect(hopIdempotencyKey('ai-agent-run:r1', 2)).toBe('ai-agent-run:r1:hop:2');
  });
  it('rejects a hop outside 0..6', () => {
    expect(() => hopIdempotencyKey('k', 7)).toThrow(/hop/);
    expect(() => hopIdempotencyKey('k', -1)).toThrow(/hop/);
  });
});

describe('TRANSIENT_FAILOVER_CAUSES (D6)', () => {
  it('contains every cause except ineligible', () => {
    expect(TRANSIENT_FAILOVER_CAUSES.has('ineligible')).toBe(false);
    for (const c of ['cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted'] as const) {
      expect(TRANSIENT_FAILOVER_CAUSES.has(c)).toBe(true);
    }
  });
});

describe('shouldFailOverNow (agent runs)', () => {
  const pf = (cause: string, retries: number) => ({ cause, status: null, retries }) as never;
  it.each([
    ['no failure', null, false, ['k'], null],
    ['output already produced', pf('overloaded', 5), true, ['k'], null],
    ['nothing configured', pf('overloaded', 5), false, [], null],
    ['a transient failure the CLI is still retrying', pf('overloaded', 1), false, ['k'], null],
    ['a transient failure after the retry budget', pf('overloaded', 2), false, ['k'], 'overloaded'],
    ['a bad key fails over at once', pf('auth_failed', 0), false, ['k'], 'auth_failed'],
    ['out of quota fails over at once', pf('quota_exhausted', 0), false, ['k'], 'quota_exhausted'],
  ] as const)('%s', (_l, providerFailure, sawOutput, remaining, expected) => {
    expect(shouldFailOverNow({ providerFailure, sawOutput }, remaining)).toBe(expected);
  });
});
