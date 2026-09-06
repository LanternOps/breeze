/**
 * #3205 W04 decision 14: generateDueInvoice does multi-statement all-or-nothing
 * writes and does NOT open its own transaction. Without an ambient context every
 * write lands on the bare pool with no RLS GUC, where forced RLS on breeze_app
 * silently matches 0 rows (#1375) — a half-written invoice with no error. This
 * guard turns that into a loud throw. No database is needed: the predicate is
 * AsyncLocalStorage-only.
 */
import { describe, expect, it } from 'vitest';
import {
  assertInTransaction,
  hasDbAccessContext,
  __runInDbContextForTests as runInDbContextForTests,
} from './index';

describe('assertInTransaction (#3205 W04)', () => {
  it('precondition: a bare test has no DB access context', () => {
    expect(hasDbAccessContext()).toBe(false);
  });

  it('throws outside a context, naming the caller and the failure mode', () => {
    expect(() => assertInTransaction('generateDueInvoice')).toThrowError(
      /^generateDueInvoice must run inside withDbAccessContext \/ withSystemDbAccessContext/,
    );
    expect(() => assertInTransaction('generateDueInvoice')).toThrowError(/silently affects 0 rows/);
  });

  it('passes inside a context', () => {
    runInDbContextForTests(() => {
      expect(() => assertInTransaction('generateDueInvoice')).not.toThrow();
    });
  });
});
