import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractRowCount } from './rowCount';

// apps/api/src/db -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * A faithful stand-in for the postgres-js `Result` that `db.execute()` actually
 * resolves to. Verified against `postgres@3.4.9`:
 *
 *   - `src/result.js`     — `class Result extends Array`, whose `count` is
 *                           installed with `Object.defineProperties` (writable,
 *                           NON-enumerable) and starts as `null`.
 *   - `src/connection.js` — `CommandComplete` parses the affected-row count off
 *                           the command tag into `result.count`.
 *   - `drizzle-orm/postgres-js` `session.cjs` — a `db.execute(sql\`...\`)` with
 *                           no field mapper returns `client.unsafe(...)`
 *                           verbatim, so the raw `Result` reaches the caller.
 *                           There is no `.rowCount` anywhere on it.
 *
 * Building the fixture this way rather than as a plain `{ count: n }` object is
 * the entire point of this suite. A plain object is not an array, so it can
 * never reach the `Array.isArray(...) ? .length` branch — an object mock cannot
 * tell a correct reader apart from one that checks `.length` first, and it
 * would pass against every broken variant this helper exists to prevent. The
 * REAL result of a `DELETE` without `RETURNING` puts the two in direct
 * conflict: `length === 0` while `count === n`. Getting that conflict wrong is
 * what this helper exists to prevent: #3760 introduced it for a
 * `SELECT ... FOR UPDATE` lock check where reading the node-postgres field off
 * a postgres-js result yields 0 on every call, which would fire a
 * "lock not held" warning on every SUCCESSFUL delete — the exact opposite of
 * the truth (see `services/deviceDeletion.ts`).
 */
class PostgresJsResult<T> extends Array<T> {
  static get [Symbol.species]() {
    return Array;
  }
}

/** Builds the `Result` postgres-js would hand back for `command`. */
function pgResult<T>(rows: T[], count: number | null, command = 'DELETE'): PostgresJsResult<T> {
  const result = new PostgresJsResult<T>();
  for (const row of rows) result.push(row);
  Object.defineProperties(result, {
    count: { value: count, writable: true },
    command: { value: command, writable: true },
    state: { value: null, writable: true },
  });
  return result;
}

/** The node-postgres shape, for the adapters that produce it. */
const nodePostgresResult = (rowCount: number, rows: unknown[] = []) => ({ rowCount, rows });

describe('extractRowCount — real driver shapes', () => {
  it('reads .count off a postgres-js DELETE result whose .length is 0', () => {
    // The shape that shipped the #3760 bug. Assert the conflict is genuinely
    // present, so this stays a discriminating fixture if it is ever edited.
    const result = pgResult([], 4213);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);

    expect(extractRowCount(result)).toBe(4213);
  });

  it('reads .count even though it is non-enumerable (a spread/JSON copy loses it)', () => {
    const result = pgResult([], 12);

    // Documents how the copies kept diverging: any mock built by spreading or
    // round-tripping a real result silently drops the only field that carries
    // the answer, and then a `.length`-first reader looks correct.
    expect(Object.keys(result)).not.toContain('count');
    expect(JSON.parse(JSON.stringify(result))).toEqual([]);
    expect({ ...result }).not.toHaveProperty('count');

    expect(extractRowCount(result)).toBe(12);
  });

  it('reads a postgres-js SELECT result that carries both rows and a count', () => {
    const result = pgResult([{ id: 'a' }, { id: 'b' }], 2, 'SELECT');
    expect(extractRowCount(result)).toBe(2);
  });

  it('falls through to array length when postgres-js leaves count at its null default', () => {
    // `Result.count` initialises to `null`, and `typeof null === 'object'` — it
    // must not be mistaken for a number and must not short-circuit to 0.
    const result = pgResult([{ id: 'a' }, { id: 'b' }, { id: 'c' }], null, 'SELECT');
    expect(extractRowCount(result)).toBe(3);
  });

  it('reads .rowCount off a node-postgres result', () => {
    expect(extractRowCount(nodePostgresResult(9))).toBe(9);
  });

  it('prefers .rowCount over .count when a shape carries both', () => {
    expect(extractRowCount({ rowCount: 7, count: 3 })).toBe(7);
  });

  it('falls back to length for a plain array of mapped rows', () => {
    expect(extractRowCount([{}, {}, {}])).toBe(3);
  });

  it('returns 0 for an unrecognised object shape', () => {
    expect(extractRowCount({})).toBe(0);
  });
});

describe('extractRowCount — the batched-delete loop contract', () => {
  // Every consumer in `jobs/` and `services/` drives `while (n === BATCH_SIZE)`.
  // Under-reporting ends the loop early and silently strands rows; that is why
  // the helper never coerces an unknown shape into a plausible-looking number.
  it.each([1, 5000, 10000])('reports a full batch of %i as itself so the loop continues', (batch) => {
    expect(extractRowCount(pgResult([], batch))).toBe(batch);
  });

  it('reports an empty postgres-js DELETE as 0 so the loop terminates', () => {
    expect(extractRowCount(pgResult([], 0))).toBe(0);
  });
});

describe('extractRowCount — deliberately NOT null-safe', () => {
  // postgres-js never resolves a successful statement to null/undefined, so a
  // nullish result means a broken driver, adapter or mock. Mapping it to 0
  // would conflate that with "no rows" — and 0 is load-bearing: it terminates
  // the retention loops, and in `tenantCascade` it is the per-table figure
  // written into the GDPR erasure audit. Two of the private copies this suite
  // replaced had drifted to `raw?.rowCount`, which swallowed exactly that.
  it.each([null, undefined])('throws rather than reporting 0 for %s', (bad) => {
    expect(() => extractRowCount(bad)).toThrow(TypeError);
  });
});

describe('extractRowCount is the only row-count reader in apps/api', () => {
  /**
   * Why this guard exists
   * ---------------------
   * This check was hand-rolled privately FIFTEEN times across `jobs/` and
   * `services/` before #3894 consolidated them, and every copy was one edit
   * away from the 0-on-every-call failure the canonical helper documents.
   *
   * A comment is not the control: `db/rowCount.ts` already carried a note
   * asking for consolidation, and three further copies were added after it.
   *
   * The primary pattern matches the DISCRIMINATING TEST (`typeof x.rowCount ===
   * 'number'`), not the cast that happens to precede it. An earlier draft of
   * this guard keyed on the inline `as { rowCount?: number }` cast and PR review
   * caught two copies it missed — `agentLogRetention` and `changeLogRetention`
   * cast to `Record<string, unknown>` instead and slipped straight through. Any
   * hand-rolled three-shape reader must perform the typeof test whatever it
   * casts to, so that is what we key on.
   *
   * Anything that needs a row count imports `extractRowCount` from
   * `db/rowCount`; nothing re-implements the shape check.
   */
  /** Files matching `pattern` under `apps/api/src`, excluding test files. */
  const filesMatching = (pattern: string): string[] => {
    let stdout: string;
    try {
      stdout = execFileSync(
        'git',
        ['grep', '--files-with-matches', '-E', pattern, '--', 'apps/api/src'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      // `git grep` exits 1 with empty output when nothing matches, and >1 on a
      // real failure. Only the former is "clean".
      const { status, stderr } = err as { status?: number; stderr?: string };
      if (status === 1) return [];
      throw new Error(`git grep failed (status ${status}): ${stderr ?? String(err)}`);
    }
    return stdout.split('\n').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  };

  // The discriminating test every hand-rolled reader must perform, whatever it
  // casts `result` to first. Cast-style agnostic on purpose (see above).
  const SHAPE_TEST_PATTERN = "typeof [A-Za-z_$][A-Za-z0-9_$]*\\??\\.rowCount === 'number'";
  // `ipHistoryRetention` used `(result as unknown as { count: number }).count ??
  // result.length ?? 0` — it never tested `.rowCount`, so it would slip past the
  // pattern above. Keyed on its cast instead.
  const COUNT_CAST_PATTERN = 'as unknown as \\{ count: number \\}';

  let shapeTestMatches: string[];
  let countCastMatches: string[];

  // One `git grep` per pattern, shared by the assertions below. Generous
  // timeout because this shells out: on a loaded machine the subprocess can
  // take tens of seconds of wall time on ~1s of CPU, and a flaky structural
  // guard gets deleted rather than fixed.
  beforeAll(() => {
    shapeTestMatches = filesMatching(SHAPE_TEST_PATTERN);
    countCastMatches = filesMatching(COUNT_CAST_PATTERN);
  }, 120_000);

  it('has a working grep — the canonical helper is found by its own pattern', () => {
    // Positive control. Without it, a typo'd regex or a broken `git grep`
    // invocation would make both guards below pass vacuously forever — which is
    // the failure mode that let fifteen copies accumulate in the first place.
    expect(shapeTestMatches).toContain('apps/api/src/db/rowCount.ts');
  });

  it('finds no re-hand-rolled driver row-count reader', () => {
    expect(shapeTestMatches.filter((f) => f !== 'apps/api/src/db/rowCount.ts')).toEqual([]);
  });

  it('finds no inline postgres-js `.count` cast', () => {
    expect(countCastMatches).toEqual([]);
  });
});
