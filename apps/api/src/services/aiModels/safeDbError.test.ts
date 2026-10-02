import { describe, expect, it } from 'vitest';
import { carriesQueryValues, causeChain, errorSqlstate, safeDbErrorDetail, safeErrorMessage } from './safeDbError';

class DrizzleQueryError extends Error {
  constructor(readonly query: string, readonly params: unknown[], cause?: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(',')}`);
    this.cause = cause;
  }
}
class PostgresError extends Error {
  constructor(message: string, readonly code: string, extra: Record<string, unknown> = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

const pg = (code: string, message: string, extra: Record<string, unknown> = {}) => new PostgresError(message, code, extra);
const wrapped = (cause: unknown) => new DrizzleQueryError('insert into "t" values ($1)', ['sealed-ciphertext-SECRET'], cause);

describe('safeDbError (#7600 W02: one scrubber for every registry error path)', () => {
  it('causeChain is outermost-first, bounded and cycle-safe', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });
    expect(causeChain(outer)).toEqual([outer, inner]);
    const a = new Error('a'); const b = new Error('b', { cause: a }); (a as { cause?: unknown }).cause = b;
    expect(causeChain(a)).toEqual([a, b]);
    let deep: Error = new Error('0');
    for (let i = 1; i < 20; i += 1) deep = new Error(String(i), { cause: deep });
    expect(causeChain(deep)).toHaveLength(8);
  });

  it('detects SQL/param-bearing errors anywhere in the chain', () => {
    expect(carriesQueryValues(wrapped(pg('23505', 'dup')))).toBe(true);
    expect(carriesQueryValues(new Error('outer', { cause: pg('42501', 'denied', { query: 'select', parameters: ['x'] }) }))).toBe(true);
    // Drizzle's own message format embeds the SQL and params even on a plain Error.
    expect(carriesQueryValues(new Error('Failed query: insert … params: secret'))).toBe(true);
    expect(carriesQueryValues(new TypeError('x is undefined'))).toBe(false);
    expect(carriesQueryValues('a string')).toBe(false);
  });

  it('a query error keeps class, SQLSTATE, constraint and primary message — never the SQL or params', () => {
    const error = wrapped(pg('23503', 'insert or update violates foreign key constraint "fk"', { constraint_name: 'fk' }));
    const message = safeErrorMessage(error);
    expect(message).toBe('DrizzleQueryError (SQLSTATE 23503, fk, insert or update violates foreign key constraint "fk")');
    expect(message).not.toContain('SECRET');
    expect(errorSqlstate(error)).toBe('23503');
  });

  it('SQLSTATE class 22 drops the primary message (it can quote the offending input)', () => {
    const error = wrapped(pg('22P02', 'invalid input syntax for type uuid: "sealed-ciphertext-SECRET"'));
    expect(safeErrorMessage(error)).toBe('DrizzleQueryError (SQLSTATE 22P02)');
    expect(safeDbErrorDetail(error)).toEqual({ kind: 'DrizzleQueryError', code: '22P02', constraint: undefined, primary: undefined });
  });

  it('a non-query error keeps its OWN message (a wrapper is never replaced by its cause)', () => {
    const error = new Error('legacyReconcile: offering platform:x was not upserted', { cause: new Error('inner detail') });
    expect(safeErrorMessage(error)).toBe('legacyReconcile: offering platform:x was not upserted');
    expect(safeErrorMessage('plain')).toBe('plain');
    expect(errorSqlstate(new Error('no code'))).toBeUndefined();
  });
});
