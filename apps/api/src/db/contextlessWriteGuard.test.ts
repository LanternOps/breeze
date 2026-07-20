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
  runOutsideDbContext,
  __resetContextlessWriteGuardForTests,
  __runInDbContextForTests as runInDbContextForTests,
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

    it('does not false-positive on write verbs in a string-literal array (catalog reads, #1828)', () => {
      // The rls-coverage contract queries are pure catalog reads that contain
      // ARRAY['SELECT','INSERT','UPDATE','DELETE']. The old greedy regex skipped
      // past the leading CTE and matched DELETE inside that literal, throwing
      // under DB_CONTEXTLESS_WRITE_STRICT. The verbs are quoted and not anchored
      // to a target, so the classifier must treat the whole thing as a read.
      expect(
        classifyContextlessExecuteVerb(sql`
          WITH t AS (
            SELECT c.relname FROM pg_class c WHERE c.relname = ANY(${'x'})
          ),
          cov AS (
            SELECT p.tablename FROM pg_policies p
            CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd
          )
          SELECT t.relname FROM t
        `),
      ).toBeNull();
    });

    it('does not false-positive on a verb appearing only inside a string literal', () => {
      expect(classifyContextlessExecuteVerb(sql`SELECT 'DELETE FROM x' AS literal`)).toBeNull();
    });

    it('classifies an aliased / ONLY update target', () => {
      expect(classifyContextlessExecuteVerb(sql`UPDATE foo AS f SET x = ${1} WHERE f.id = ${2}`)).toBe('update');
      expect(classifyContextlessExecuteVerb(sql`UPDATE ONLY foo SET x = ${1}`)).toBe('update');
    });

    it('does not false-positive on identifiers that merely contain update/set substrings', () => {
      // `updated_at` is not the UPDATE verb (no word boundary); `OFFSET`
      // contains "set" but not as a standalone token.
      expect(
        classifyContextlessExecuteVerb(sql`SELECT updated_at FROM foo ORDER BY id OFFSET ${10}`),
      ).toBeNull();
    });

    it('still classifies a data-modifying CTE statement that trails a long CTE block', () => {
      // A genuine WITH ... DELETE FROM cascade write must still be caught even
      // when the DELETE trails a sizeable CTE prefix.
      const longCte = 'a'.repeat(400);
      expect(
        classifyContextlessExecuteVerb(
          sql`WITH t AS (SELECT 1 AS x /* ${sql.raw(longCte)} */) DELETE FROM foo WHERE id IN (SELECT x FROM t)`,
        ),
      ).toBe('delete');
    });

    it('returns null defensively for non-sql shapes', () => {
      expect(classifyContextlessExecuteVerb(undefined)).toBeNull();
      expect(classifyContextlessExecuteVerb({})).toBeNull();
    });
  });

  // These exercise the REAL guard against the REAL wrapper composition — no
  // hand-mocked context helpers. Route-level suites (agentWs.test.ts) mock
  // `../db` wholesale, so they can only prove that two stubs were entered;
  // they cannot prove the guard actually goes quiet. That gap is what let an
  // inverted-nesting regression survive review, so it is pinned here instead.
  describe('wrapper composition around a device_commands-style write', () => {
    it('DOES fire when runOutsideDbContext is nested INSIDE a system context', () => {
      // The inversion. runOutsideDbContext exits BOTH ALS stores, so the
      // freshly-established system context is discarded and the write lands on
      // the bare pool contextless — exactly the #1375 bug, with an orphaned
      // open transaction pinning a pooled connection on top (#1105).
      runOutsideDbContextInsideSystemContextShape(() => {
        callBuilder(() => db.update({} as never));
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(captureMessage).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire when the write runs inside an active context', () => {
      // The correct shape: whatever exits the ambient context does so FIRST,
      // and the context the write actually runs in is still active when the
      // builder is called.
      withActiveDbContextShape(() => {
        callBuilder(() => db.update({} as never));
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(captureMessage).not.toHaveBeenCalled();
    });
  });
});

// Minimal stand-ins for the two nesting orders, driving the real
// dbContextStorage via the real exported helpers. We cannot open a real
// transaction without a database, so these assert the property the guard
// itself keys on: whether a context is active at the moment the write builder
// is called.
function runOutsideDbContextInsideSystemContextShape(fn: () => void): void {
  runInDbContextForTests(() => {
    runOutsideDbContext(fn);
  });
}

function withActiveDbContextShape(fn: () => void): void {
  runInDbContextForTests(fn);
}
