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

  it('recovers issues from the zod v4 serialized ZodError (issues non-enumerable, buried in error.message)', () => {
    // Mirrors a real @hono/zod-validator 400 body under zod 4: JSON.stringify
    // drops the non-enumerable `issues`, leaving them as a JSON string in message.
    const v4Body = {
      success: false,
      error: {
        name: 'ZodError',
        message: JSON.stringify([
          { code: 'custom', message: 'ttlMinutes and expiresAt cannot both be set', path: ['ttlMinutes'] },
          { code: 'invalid_type', message: 'name is required', path: ['name'] },
        ]),
      },
    };
    expect(extractApiError(v4Body, FALLBACK)).toBe('ttlMinutes and expiresAt cannot both be set; name is required');
  });

  it('falls back when a v4 ZodError message is not a JSON issues array', () => {
    expect(extractApiError({ error: { name: 'ZodError', message: 'not-json' } }, FALLBACK)).toBe(FALLBACK);
  });

  it('renders the shared zValidator wrapper 400 body once, deduping error against details (#2201)', () => {
    // Contract test: exact body emitted by apps/api/src/lib/validation.ts. The
    // `error` string uses the same join rules as joinZodFlatten so the details
    // rendering is identical and must dedupe to a single toast line.
    const body = {
      error: 'Unrecognized key: "maxUses"; contacts.0.email: Invalid email',
      details: {
        formErrors: ['Unrecognized key: "maxUses"'],
        fieldErrors: { 'contacts.0.email': ['Invalid email'] },
      },
    };
    expect(extractApiError(body, FALLBACK)).toBe(
      'Unrecognized key: "maxUses"; contacts.0.email: Invalid email'
    );
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

describe('extractApiError — zod flatten() details shapes', () => {
  it('renders fieldErrors from a flatten() details payload', () => {
    const body = {
      error: 'Invalid patch settings',
      details: {
        formErrors: [],
        fieldErrors: { apps: ['Duplicate application rule (source + packageId must be unique)'] },
      },
    };
    expect(extractApiError(body, 'fb')).toBe(
      'Invalid patch settings: apps: Duplicate application rule (source + packageId must be unique)'
    );
  });

  it('renders formErrors from a flatten() details payload', () => {
    const body = { details: { formErrors: ['Too many application rules (max 200)'], fieldErrors: {} } };
    expect(extractApiError(body, 'fb')).toBe('Too many application rules (max 200)');
  });

  it('combines formErrors and multiple fieldErrors', () => {
    const body = {
      details: {
        formErrors: ['top-level problem'],
        fieldErrors: { apps: ['bad rule'], autoApproveSeverities: ['pick one', 'invalid value'] },
      },
    };
    expect(extractApiError(body, 'fb')).toBe(
      'top-level problem; apps: bad rule; autoApproveSeverities: pick one; invalid value'
    );
  });

  it('falls back when the flatten() payload carries no messages', () => {
    expect(extractApiError({ details: { formErrors: [], fieldErrors: {} } }, 'fb')).toBe('fb');
  });

  it('prefers issues-style details over flatten when details is an issues array (regression)', () => {
    const body = { error: 'Validation failed', details: [{ message: 'name is required' }] };
    expect(extractApiError(body, 'fb')).toBe('Validation failed: name is required');
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

  // #3989 — hand-rolled route validators return `details` as a plain array of
  // strings, not a zod payload. `joinZodIssues` wants objects carrying
  // `.message` and returns null for strings, so this was dropped entirely and
  // the user saw only the generic top-level `error`: the same sentence whether
  // the scheme was wrong, the hostname was missing, or SSRF protection rejected
  // the target.
  it('renders a plain string[] details alongside the top-level error', () => {
    expect(
      extractApiError(
        {
          error: 'Invalid webhook channel configuration',
          details: ['Webhook URL must use HTTPS', 'Webhook URL hostname is required'],
        },
        'FALLBACK'
      )
    ).toBe(
      'Invalid webhook channel configuration: Webhook URL must use HTTPS; Webhook URL hostname is required'
    );
  });

  it('ignores non-string entries rather than printing [object Object]', () => {
    // EXACT, not toContain: `toContain('real message')` also passes when the
    // output additionally contains "[object Object]" or "null", which is the
    // precise thing this test exists to rule out.
    expect(
      extractApiError({ error: 'Nope', details: [{ a: 1 }, 'real message', null] }, 'FALLBACK')
    ).toBe('Nope: real message');
  });

  // The ordering bug: with a zod-issues branch tried BEFORE a string branch,
  // this returned 'Bad request: name is required' and silently dropped the
  // plain string. Both representations can appear in one array and both are
  // reasons the user needs.
  it('keeps BOTH object .message and plain-string entries in a mixed array', () => {
    expect(
      extractApiError(
        {
          error: 'Bad request',
          details: [{ message: 'name is required' }, 'Webhook URL must use HTTPS']
        },
        'FALLBACK'
      )
    ).toBe('Bad request: name is required; Webhook URL must use HTTPS');
  });

  // A pure zod issues array must render EXACTLY as it did before the array
  // branches were merged. `toBe`, not `toContain`: toContain would also pass
  // on duplicated text, a changed prefix, or extra trailing garbage, which is
  // precisely what a bad merge would produce.
  it('renders a pure zod issues array identically after the branch merge', () => {
    expect(
      extractApiError({ error: 'Bad', details: [{ message: 'name is required' }] }, 'FALLBACK')
    ).toBe('Bad: name is required');
  });

  // The aggregate shape: the top-level error is the SAME text as the details,
  // just joined. No individual message equals it, so a per-message rule alone
  // prints the whole thing twice.
  it('suppresses details that are only the top-level error split into parts', () => {
    expect(
      extractApiError(
        {
          error: 'name is required; email is invalid',
          details: [{ message: 'name is required' }, { message: 'email is invalid' }]
        },
        'FALLBACK'
      )
    ).toBe('name is required; email is invalid');
  });

  // The per-message dedup: comparing the top-level error against the WHOLE
  // joined details string only dedupes when every detail repeats it, so this
  // input printed 'name is required' twice.
  it('drops only the detail that repeats the top-level error, keeping the rest', () => {
    expect(
      extractApiError(
        {
          error: 'name is required',
          details: [{ message: 'name is required' }, 'Webhook URL must use HTTPS']
        },
        'FALLBACK'
      )
    ).toBe('name is required: Webhook URL must use HTTPS');
  });
});
