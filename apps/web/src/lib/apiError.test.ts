import { describe, it, expect } from 'vitest';
import { extractApiError, isApiFailure } from './apiError';

describe('extractApiError', () => {
  const FALLBACK = 'Operation failed';

  it('returns fallback for null/undefined', () => {
    expect(extractApiError(null, FALLBACK)).toBe(FALLBACK);
    expect(extractApiError(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it('returns fallback for non-object primitives', () => {
    expect(extractApiError('plain string', FALLBACK)).toBe(FALLBACK);
    expect(extractApiError(42, FALLBACK)).toBe(FALLBACK);
    expect(extractApiError(true, FALLBACK)).toBe(FALLBACK);
  });

  it('returns body.error when it is a non-empty string', () => {
    expect(extractApiError({ error: 'Channel not found' }, FALLBACK)).toBe('Channel not found');
  });

  it('falls back when body.error is an empty string', () => {
    expect(extractApiError({ error: '' }, FALLBACK)).toBe(FALLBACK);
  });

  it('concatenates zod issues from body.error.issues', () => {
    const zodBody = {
      error: {
        issues: [
          { message: 'name is required', path: ['name'] },
          { message: 'type must be one of email, slack', path: ['type'] }
        ]
      }
    };
    expect(extractApiError(zodBody, FALLBACK)).toBe('name is required; type must be one of email, slack');
  });

  it('handles zod issues array with missing/empty messages', () => {
    const body = {
      error: {
        issues: [{ message: 'valid' }, { message: '' }, { path: ['x'] }, null]
      }
    };
    expect(extractApiError(body, FALLBACK)).toBe('valid');
  });

  it('falls back when zod issues array is empty', () => {
    expect(extractApiError({ error: { issues: [] } }, FALLBACK)).toBe(FALLBACK);
  });

  it('returns body.details when only details is set', () => {
    expect(extractApiError({ details: 'phone numbers required' }, FALLBACK)).toBe('phone numbers required');
  });

  it('concatenates error + details when both are strings', () => {
    const body = { error: 'Validation failed', details: 'name must be at least 1 character' };
    expect(extractApiError(body, FALLBACK)).toBe('Validation failed: name must be at least 1 character');
  });

  it('concatenates error string + zod issues in details array', () => {
    const body = {
      error: 'Validation failed',
      details: [{ message: 'name is required' }, { message: 'config invalid' }]
    };
    expect(extractApiError(body, FALLBACK)).toBe('Validation failed: name is required; config invalid');
  });

  it('does not duplicate when error and details produce the same string', () => {
    const body = { error: 'oops', details: 'oops' };
    expect(extractApiError(body, FALLBACK)).toBe('oops');
  });

  it('falls back to body.message (Hono default error shape)', () => {
    expect(extractApiError({ message: 'Internal Server Error' }, FALLBACK)).toBe('Internal Server Error');
  });

  it('prefers error over message when both exist', () => {
    expect(extractApiError({ error: 'specific', message: 'generic' }, FALLBACK)).toBe('specific');
  });

  it('handles top-level issues array (raw zValidator result)', () => {
    const body = { issues: [{ message: 'top-level issue' }] };
    expect(extractApiError(body, FALLBACK)).toBe('top-level issue');
  });

  it('returns fallback for object with no recognized fields', () => {
    expect(extractApiError({ foo: 'bar', baz: 42 }, FALLBACK)).toBe(FALLBACK);
  });

  it('handles legacy errorMessage field (remote/proxy tunnel endpoints)', () => {
    expect(extractApiError({ errorMessage: 'Tunnel timed out' }, FALLBACK)).toBe('Tunnel timed out');
  });

  it('prefers error over errorMessage when both exist', () => {
    expect(extractApiError({ error: 'real', errorMessage: 'legacy' }, FALLBACK)).toBe('real');
  });
});

describe('isApiFailure', () => {
  it('true when http status >= 400', () => {
    expect(isApiFailure({}, 400)).toBe(true);
    expect(isApiFailure({}, 500)).toBe(true);
  });
  it('true when body.success === false even on 200', () => {
    expect(isApiFailure({ success: false, message: 'nope' }, 200)).toBe(true);
  });
  it('true when testResult.success === false on 200', () => {
    expect(isApiFailure({ testResult: { success: false, message: 'bad token' } }, 200)).toBe(true);
  });
  it('false for a normal 200 success body', () => {
    expect(isApiFailure({ data: [1, 2] }, 200)).toBe(false);
    expect(isApiFailure({ success: true }, 200)).toBe(false);
    expect(isApiFailure(null, 200)).toBe(false);
  });

  // CONTRACT: isApiFailure is deliberately a SHALLOW, top-level-only check.
  // It must NOT recurse into nested/batch bodies — a partial-success aggregate
  // (top-level success:true with per-item success:false entries) is NOT a
  // request failure. If a future change makes this recurse ("catch nested
  // failures"), every partial-success/batch endpoint routed through runAction
  // would start throwing false errors. These assertions pin that contract so
  // such a regression fails loudly here.
  it('does NOT recurse: nested/batch success:false under a 200 success body is not a failure', () => {
    expect(isApiFailure({ success: true, results: [{ success: false }, { success: true }] }, 200)).toBe(false);
    expect(isApiFailure({ data: { success: false } }, 200)).toBe(false);
    expect(isApiFailure({ items: [{ ok: false }], success: true }, 200)).toBe(false);
    // testResult is only inspected at the top level, not nested under data.
    expect(isApiFailure({ data: { testResult: { success: false } } }, 200)).toBe(false);
  });

  it('still flags genuine top-level failure shapes (the only ones it should)', () => {
    expect(isApiFailure({ success: false }, 200)).toBe(true);
    expect(isApiFailure({ testResult: { success: false } }, 200)).toBe(true);
  });
});

describe('extractApiError — new shapes', () => {
  it('reads {success:false, message}', () => {
    expect(extractApiError({ success: false, message: 'Invalid token' }, 'fb')).toBe('Invalid token');
  });
  it('reads {testResult:{success:false, message}}', () => {
    expect(extractApiError({ testResult: { success: false, message: 'application token is invalid' } }, 'fb'))
      .toBe('application token is invalid');
  });
  it('still honors existing {error} shape (regression)', () => {
    expect(extractApiError({ error: 'boom' }, 'fb')).toBe('boom');
  });
  it('falls back when nothing parses', () => {
    expect(extractApiError({ weird: 1 }, 'fallback msg')).toBe('fallback msg');
  });
});
