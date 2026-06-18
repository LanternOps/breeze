import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// Mock the sentry service so the proxy guard's captureMessage call is
// observable and never touches a real (uninitialized) SDK.
vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
}));

import { captureMessage } from '../services/sentry';
import {
  db,
  hasDbAccessContext,
  classifyContextlessExecuteVerb,
  __resetContextlessWriteGuardForTests,
} from './index';

// The builder guard fires at CALL time (not on getter access). Query builders
// are lazy — calling db.update(...) returns a builder synchronously without
// opening a DB connection — so these assertions need no live database.
function callBuilder(fn: () => unknown): void {
  try {
    fn();
  } catch {
    // A bogus table arg may throw downstream; the guard already ran.
  }
}

describe('contextless-write guard on proxiedDb (#1375/#1379)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetContextlessWriteGuardForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('precondition: no active DB access context in a bare test', () => {
    expect(hasDbAccessContext()).toBe(false);
  });

  it('does NOT warn on mere getter access (only on call)', () => {
    void db.update;
    void db.insert;
    void db.delete;

    expect(warnSpy).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('warns + reports when calling .update outside a context', () => {
    callBuilder(() => db.update({} as never));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(1);

    const firstCall = (captureMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const [message, level, extra] = firstCall;
    expect(message).toContain('.update()');
    expect(message).toContain('#1375');
    expect(level).toBe('warning');
    expect(extra).toHaveProperty('stack');
  });

  it('warns + reports for .insert and .delete too', () => {
    callBuilder(() => db.insert({} as never));
    callBuilder(() => db.delete({} as never));

    expect(captureMessage).toHaveBeenCalledTimes(2);
    const calls = (captureMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toContain('.insert()');
    expect(calls[1]![0]).toContain('.delete()');
  });

  it('dedups the Sentry capture for repeated contextless writes from the same site', () => {
    for (let i = 0; i < 5; i++) {
      callBuilder(() => db.insert({} as never));
    }
    // console.warn fires every time; Sentry is throttled to one per call site.
    expect(warnSpy).toHaveBeenCalledTimes(5);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  // Raw SQL classification (the .execute() coverage) tested directly so no DB
  // connection is opened — db.execute() runs the query eagerly.
  describe('classifyContextlessExecuteVerb', () => {
    it('classifies write statements by their leading verb', () => {
      expect(classifyContextlessExecuteVerb(sql`DELETE FROM foo WHERE id = ${1}`)).toBe('delete');
      expect(classifyContextlessExecuteVerb(sql`UPDATE foo SET x = ${1}`)).toBe('update');
      expect(classifyContextlessExecuteVerb(sql`INSERT INTO foo (x) VALUES (${1})`)).toBe('insert');
    });

    it('classifies a leading lowercase/whitespace write', () => {
      expect(classifyContextlessExecuteVerb(sql`  delete from foo`)).toBe('delete');
    });

    it('sees through a leading CTE to the write', () => {
      expect(
        classifyContextlessExecuteVerb(sql`WITH t AS (SELECT 1) DELETE FROM foo WHERE id IN (SELECT 1 FROM t)`),
      ).toBe('delete');
    });

    it('returns null for reads (SELECT / catalog lookups)', () => {
      expect(classifyContextlessExecuteVerb(sql`SELECT 1`)).toBeNull();
      expect(
        classifyContextlessExecuteVerb(
          sql`SELECT table_name FROM information_schema.columns WHERE column_name = ${'partner_id'}`,
        ),
      ).toBeNull();
    });

    it('does not false-positive on a write keyword inside a SELECT', () => {
      expect(classifyContextlessExecuteVerb(sql`SELECT ${'delete'} AS action`)).toBeNull();
    });

    it('returns null defensively for non-sql shapes', () => {
      expect(classifyContextlessExecuteVerb(undefined)).toBeNull();
      expect(classifyContextlessExecuteVerb({})).toBeNull();
    });
  });
});
