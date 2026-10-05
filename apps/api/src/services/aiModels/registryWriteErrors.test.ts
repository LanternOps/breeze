import { describe, expect, it } from 'vitest';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';
import { OfferingWriteError } from './offerings';
import { ConnectionKeyError } from './connectionKeys';

/** Shape of a drizzle DrizzleQueryError wrapping a postgres.js error. */
function drizzleError(code: string, constraint: string, params: unknown[]): Error {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code, constraint_name: constraint, severity: 'ERROR', query: 'insert into …', parameters: params,
  });
  return Object.assign(new Error(`Failed query: insert into … params: ${params.join(',')}`), {
    name: 'DrizzleQueryError', query: 'insert into …', params, cause: pg,
  });
}

function capture(fn: () => never): RegistryWriteError | unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error('did not throw');
}

describe('toRegistryWriteError', () => {
  it('never lets ciphertext in params reach the message', () => {
    const err = capture(() => toRegistryWriteError(drizzleError('XX000', 'x', ['enc:v1:SECRETCIPHERTEXT']), 'Could not save.'));
    expect(err).toBeInstanceOf(RegistryWriteError);
    const e = err as RegistryWriteError;
    expect(e.status).toBe(500);
    expect(e.code).toBe('write_failed');
    expect(e.message).toBe('Could not save.');
    expect(JSON.stringify({ m: e.message, c: String((e as Error).cause), d: e.details })).not.toContain('SECRETCIPHERTEXT');
    expect(((e as Error).cause as { code?: string }).code).toBe('XX000');
  });

  it('maps a unique violation to 409 conflict with the constraint name only', () => {
    const e = capture(() => toRegistryWriteError(
      drizzleError('23505', 'partner_ai_connections_compat_uq', ['enc:v1:X']), 'Could not save.',
    )) as RegistryWriteError;
    expect(e.status).toBe(409);
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({ constraint: 'partner_ai_connections_compat_uq' });
  });

  it('maps FK and CHECK violations to 422 invalid', () => {
    for (const code of ['23503', '23514']) {
      const e = capture(() => toRegistryWriteError(drizzleError(code, 'c', ['v']), 'Could not save.')) as RegistryWriteError;
      expect(e.status).toBe(422);
      expect(e.code).toBe('invalid');
    }
  });

  it('passes typed service errors through as RegistryWriteError', () => {
    const a = capture(() => toRegistryWriteError(new OfferingWriteError('Set a price first.', 'unpriced'), 'x')) as RegistryWriteError;
    expect([a.code, a.status, a.message]).toEqual(['unpriced', 409, 'Set a price first.']);
    const b = capture(() => toRegistryWriteError(new OfferingWriteError('Offering not found.', 'not_found'), 'x')) as RegistryWriteError;
    expect([b.code, b.status]).toEqual(['not_found', 404]);
    const c = capture(() => toRegistryWriteError(new ConnectionKeyError('bad', 'key_rejected'), 'x')) as RegistryWriteError;
    expect([c.code, c.status]).toEqual(['invalid', 400]);
    const d = new RegistryWriteError('m', 'stale_write', 409);
    expect(capture(() => toRegistryWriteError(d, 'x'))).toBe(d);
  });

  it('rethrows an error with no query values untouched (bugs stay diagnosable)', () => {
    const bug = new TypeError('cannot read x of undefined');
    expect(capture(() => toRegistryWriteError(bug, 'x'))).toBe(bug);
  });
});
