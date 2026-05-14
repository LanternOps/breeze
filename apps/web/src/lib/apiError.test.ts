import { describe, it, expect } from 'vitest';
import { extractApiError } from './apiError';

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
});
