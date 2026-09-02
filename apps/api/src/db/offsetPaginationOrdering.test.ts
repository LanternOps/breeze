import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/db -> apps/api/src is 1 level up.
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Why this test exists
 * --------------------
 * `LIMIT/OFFSET` over an `ORDER BY` whose sort key is not unique is
 * non-deterministic. PostgreSQL guarantees nothing about the relative order of
 * rows with equal sort keys, and it makes that guarantee *per query* — two
 * requests for consecutive pages are two independent queries and can even pick
 * different plans. So a client walking pages over a tied sort key silently
 * receives some rows twice and never sees others.
 *
 * This is not theoretical here. `created_at`/`updated_at` default to `now()`,
 * which is the **transaction** timestamp, so every row written in one
 * transaction — a seed, a bulk import, a patch-scan ingest, a provider sync —
 * shares a byte-identical value. `main` ships several page-walking clients
 * (`apps/web/src/lib/fetchAllOrganizations.ts`, `scriptsFetch.ts`,
 * `devicesFetch.ts`) whose whole contract is "accumulate every accessible row",
 * so the corruption lands in a list the user believes is complete.
 *
 * History: #3157 (patch catalog), then #3462 (repo-wide sweep). The fix is
 * always one line — append the base table's primary key to the `ORDER BY`,
 * matching the direction of the leading column — which is exactly why it keeps
 * getting forgotten on the next endpoint. This guard lives in the required
 * `test-api` job so the next offset-paginated query cannot ship without one.
 *
 * The guard is deliberately strict: it wants to see a literal `.id` inside the
 * `orderBy(...)` of any statement that also calls `.offset(...)`. Anything else
 * — a composite key, an aliased subquery column, an ordering built by a shared
 * helper — must be justified by name in ALLOWED_WITHOUT_LITERAL_ID below.
 *
 * What it does NOT catch (know this before trusting a green run): the check is
 * textual, so it cannot tell the BASE table's `id` from some JOINED table's
 * `id`. `.from(alerts).innerJoin(devices, …).orderBy(devices.hostname,
 * devices.id)` satisfies the regex while still being non-deterministic, because
 * many alerts share one device. Proving otherwise needs the join cardinality,
 * which is in the schema, not in the call site. So: when you review a new
 * offset-paginated query, confirm by eye that the tiebreaker is the `.from()`
 * table's own key. The guard catches the common case — no tiebreaker at all —
 * not every possible wrong one.
 */

/** Files whose `.offset()` statements order deterministically without a literal
 *  `.id` token. Each entry needs a reason; do not add one to silence a failure
 *  you have not actually reasoned about. */
const ALLOWED_WITHOUT_LITERAL_ID: ReadonlyArray<{
  /** Path relative to apps/api/src. */
  file: string;
  /** Substring that must appear in the offending `orderBy(...)` arguments —
   *  scoped so the exemption cannot silently cover a second query in the
   *  same file. */
  orderByContains: string;
  reason: string;
}> = [
  {
    file: 'routes/patches/list.ts',
    orderByContains: 'orderByClause',
    reason: 'orderByClause always ends in asc/desc(patches.id) — see the #3157 comment there',
  },
  {
    file: 'routes/devices/core.ts',
    orderByContains: '...orderBy',
    reason:
      'orderBy comes from buildOrderBy() (routes/devices/cursor.ts), which appends devices.id in the matching direction on every branch — it backs the keyset cursor too',
  },
  {
    file: 'routes/tickets/tickets.ts',
    orderByContains: '...orderBy',
    reason: 'every branch of the sort switch already ends in asc/desc(tickets.id)',
  },
  {
    file: 'routes/orgs.listQuery.ts',
    orderByContains: '...organizationOrderBy',
    reason:
      'organizationOrderBy() (same file) ends BOTH of its branches in organizations.createdAt, organizations.id — the empty/junk-order early return IS that pair, and the array_position branch appends it after the preferred-order term (#4004). Unlike the other helper entries here, that is not just prose: routes/orgs.listQuery.test.ts asserts it on the COMPILED SQL for both branches (the tiebreaker follows array_position, and the no-order case emits exactly `order by "organizations"."created_at", "organizations"."id"`), so a regression that dropped the id fails there rather than silently riding this exemption.',
  },
  {
    file: 'services/logSearch.ts',
    orderByContains: 'rowsQuery.offset',
    reason:
      'the offset is applied in a separate statement (`cursorMode ? rowsQuery : rowsQuery.offset(offset)`); the ordering is resolveSearchOrder(), which ends every branch in asc/desc(deviceEventLogs.id)',
  },
  {
    file: 'services/reliabilityScoring.ts',
    orderByContains: 'deviceReliability.deviceId',
    reason: 'device_reliability has no id column; device_id is its primary key',
  },
  {
    file: 'services/fleetFindings/dispatch.ts',
    orderByContains: 'targetDeviceUuid',
    reason:
      'fleet_remediation_run_targets has no id column; PK is (run_id, target_device_uuid) and runId is pinned in the WHERE, so targetDeviceUuid is unique within the paged set',
  },
  {
    file: 'routes/incidents.helpers.ts',
    orderByContains: 'sub.sourceId',
    reason:
      'UNION ALL over three sources, so no single base-table PK; source is constant per leg and sourceId unique within it, so (source, sourceId) is a complete key',
  },
  {
    file: 'routes/cisHardening.ts',
    orderByContains: 'rankedResults.resultId',
    reason: 'cis_baseline_results.id, aliased to resultId inside the window-function subquery',
  },
];

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, acc);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
    acc.push(full);
  }
  return acc;
}

/** Return the argument text of the `orderBy(` starting at `open` (the index of
 *  its `(`), via paren matching. */
function argsOf(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

describe('offset pagination ordering (#3462)', () => {
  const files = collectTsFiles(SRC_ROOT);

  it('finds source files to scan', () => {
    // Guards against the scan silently becoming vacuous (a moved directory, a
    // renamed extension) and reporting zero violations because it read nothing.
    expect(files.length).toBeGreaterThan(200);
  });

  it('every .offset() query orders by a unique key', () => {
    const violations: string[] = [];
    let checked = 0;

    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file);
      const source = readFileSync(file, 'utf8');
      if (!source.includes('.offset(')) continue;

      // Drizzle query chains are single statements, so splitting on `;` keeps
      // each `.orderBy(...)` with the `.offset(...)` it belongs to.
      for (const statement of source.split(';')) {
        if (!statement.includes('.offset(')) continue;
        checked++;

        const exempt = (haystack: string) =>
          ALLOWED_WITHOUT_LITERAL_ID.some(
            (entry) => entry.file === rel && haystack.includes(entry.orderByContains)
          );

        // Pair the `.offset(` with the TEXTUALLY NEAREST `.orderBy(`, not the
        // first one in the chunk. A chunk can hold a subquery's `.orderBy()`
        // ahead of the outer paginated one, and taking the first would check
        // the wrong clause — possibly masking a real violation by finding an
        // unrelated `.id`. Nearest rather than nearest-preceding because both
        // chain orders occur in this codebase (`routes/orgs.ts` writes
        // `.limit().offset().orderBy()`).
        const offsetAt = statement.indexOf('.offset(');
        let orderByAt = -1;
        for (let at = statement.indexOf('.orderBy('); at !== -1; at = statement.indexOf('.orderBy(', at + 1)) {
          if (orderByAt === -1 || Math.abs(at - offsetAt) < Math.abs(orderByAt - offsetAt)) {
            orderByAt = at;
          }
        }
        if (orderByAt === -1) {
          // Either genuinely unordered, or the `.offset()` was chained in a
          // later statement than the `.orderBy()` (allowlisted by name).
          if (!exempt(statement)) {
            violations.push(`${rel}: an .offset() query has no .orderBy() at all`);
          }
          continue;
        }
        const orderArgs = argsOf(statement, orderByAt + '.orderBy'.length);
        if (/\.id\b/.test(orderArgs)) continue;
        if (exempt(orderArgs)) continue;

        violations.push(
          `${rel}: .offset() query orders by \`${orderArgs.replace(/\s+/g, ' ').trim().slice(0, 120)}\`` +
            ' — no unique tiebreaker. Append the base table\'s `.id` in the same' +
            ' direction as the leading column, or justify an exception in' +
            ' ALLOWED_WITHOUT_LITERAL_ID.'
        );
      }
    }

    expect(checked).toBeGreaterThan(50);
    expect(violations).toEqual([]);
  });

  it('has no stale entries in ALLOWED_WITHOUT_LITERAL_ID', () => {
    // An allowlist entry for a file that no longer paginates by offset is dead
    // weight that hides the next real violation in that file.
    const stale = ALLOWED_WITHOUT_LITERAL_ID.filter((entry) => {
      const full = path.join(SRC_ROOT, entry.file);
      try {
        const source = readFileSync(full, 'utf8');
        return !source.includes('.offset(') || !source.includes(entry.orderByContains);
      } catch {
        return true;
      }
    }).map((entry) => `${entry.file} (${entry.orderByContains})`);
    expect(stale).toEqual([]);
  });
});
