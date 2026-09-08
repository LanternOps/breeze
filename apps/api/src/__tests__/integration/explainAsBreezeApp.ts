/**
 * EXPLAIN-as-`breeze_app` contract harness (2026-09-03 US incident precedent:
 * `deviceEventsFeedIndexes.integration.test.ts`).
 *
 * Extracted for reuse in AI Operator P3-0/P3-1 (#5205, W02 #5207 and W03), and
 * by any future query that ships a new partial index and needs to prove the
 * index is what the planner actually picks — not merely that one exists.
 *
 * Confirmed reusable: `deviceEventsFeedIndexes.integration.test.ts` refactored
 * onto this helper with zero assertion or skew change (same 5 tests, same
 * seeded row counts) and stayed green. See §"what W02 inherits" in
 * docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-p3-0-baseline-contracts.md.
 *
 * Three facts this harness exists to enforce — get any one wrong and the test
 * passes for the wrong reason:
 *
 * 1. **A plan captured as `doadmin` (or any BYPASSRLS/superuser role) proves
 *    nothing.** `breeze_test`/`doadmin` bypass RLS outright, so a query that
 *    "uses the index" under that role may be doing so with the RLS policy's
 *    own predicate never in the plan at all — the planner had a completely
 *    different, unguarded WHERE clause to work with. Only `breeze_app`
 *    (unprivileged, `FORCE ROW LEVEL SECURITY` applies to it) exercises the
 *    real production plan. Spec citation: docs/superpowers/specs/ai-mcp/
 *    2026-09-07-ai-operator-completion-design.md §11.1, "A plan captured as
 *    `doadmin` proves nothing." Same blind spot documented for migration
 *    detection queries and SECURITY DEFINER function ownership elsewhere in
 *    this test directory (`customFieldShadowing.integration.test.ts`,
 *    `migrationRlsScope.test.ts`) — it is a recurring class of bug, not a
 *    one-off.
 *
 * 2. **The leakproof-operator rule.** Under forced RLS, Postgres will only
 *    fold a WHERE clause into an index condition (rather than a post-filter
 *    applied after the RLS policy already walked the index/table) when the
 *    operator is leakproof: `uuid_eq`, `texteq`, timestamp comparisons,
 *    `IS NULL`. jsonb `->>`, `LIKE`/`ILIKE`, and enum equality are NOT
 *    leakproof — see `tdSynnexSftpRls.integration.test.ts`'s
 *    `breeze_search_td_synnex_pa` comment: "Postgres refuses to use an index
 *    for a non-leakproof qual (ILIKE) beneath an RLS security qual." One
 *    leaky arm inside an `OR` demotes the WHOLE disjunction to a Filter, so a
 *    single ILIKE/jsonb clause silently reverts an entire multi-arm query to
 *    a sequential scan of the org's whole table — exactly the 2026-09-03
 *    incident this harness guards against (2.4M rows, 13-minute queries).
 *    Consequence for schema design: state/phase/kind columns read under RLS
 *    should be `text` with a CHECK constraint, not `pgEnum` — enum equality
 *    is not leakproof either.
 *
 * 3. **Predicates must be literal, never bound.** A partial index's predicate
 *    proof is STATIC — Postgres compares the index definition's predicate
 *    expression to the query's WHERE clause at plan time, and that
 *    comparison only succeeds against a literal constant, never a bound
 *    parameter. Write literals with `sql` template interpolation of a plain
 *    JS value only when the value is inlined as a constant (Drizzle inlines a
 *    literal written directly in a `sql` template); an `eq(column, value)` or
 *    a `${value}` used as a query PARAMETER binds it instead, and the
 *    predicate proof can't see through a bind — the index silently stops
 *    being promotable even though the row-level values are identical. Spec
 *    citation: same §11.1 passage, "partial-index predicate proof is static
 *    ... a literal written into a Drizzle `sql` template is inlined; an
 *    interpolated `${value}` or `eq()` binds a parameter the predicate proof
 *    cannot see." This is why `deviceEventsFeedIndexes.integration.test.ts`
 *    imports `NON_AGENT_ACTOR`/`DETAILS_HAS_DEVICE_ID` as pre-built SQL
 *    fragments from the route file rather than reconstructing them with
 *    `eq()` in the test — the fragment under test must be byte-for-byte the
 *    one the route ships, literal predicate included.
 *
 * `enable_seqscan = off` is set for every EXPLAIN this harness runs: with it
 * off, ANY usable index beats a sequential scan by roughly 1e10 estimated
 * cost, so a `Seq Scan` appearing in the plan anyway means the clause was NOT
 * promotable under RLS at all — the regression signal, not a tuning knob.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { db, withDbAccessContext, type DbAccessContext, type DbAccessScope } from '../../db';
import { getTestDb } from './setup';

export interface ExplainAsBreezeAppOptions {
  /** The org the simulated caller is scoped to. */
  orgId: string;
  /** Defaults to `[orgId]` — the common single-org case. */
  accessibleOrgIds?: string[];
  /** Defaults to `[]` — most EXPLAIN contracts don't need partner-wide access. */
  accessiblePartnerIds?: string[];
  /** Defaults to `'organization'`. */
  scope?: DbAccessScope;
  /** Forwarded to the access context untouched when provided. */
  currentPartnerId?: string | null;
  userId?: string | null;
  /**
   * The query to EXPLAIN, as a Drizzle query builder (anything with
   * `.getSQL()`, e.g. `db.select()....where(...).orderBy(...).limit(...)`)
   * or a raw `SQL` fragment (e.g. `sql\`SELECT ...\``). Passed through to
   * `EXPLAIN <query>` verbatim — build the WHERE/ORDER BY/LIMIT the same way
   * the production route does, predicates included, so this proves the real
   * plan and not a hand-simplified stand-in.
   */
  sql: { getSQL(): SQL } | SQL;
}

export interface ExplainAsBreezeAppResult {
  /** The full EXPLAIN output, one plan line per array entry, newline-joined. */
  plan: string;
  /**
   * `true` when `plan` contains `name` (string: substring match; RegExp:
   * `.test()`). Use the exact index name from the migration, e.g.
   * `usesIndex('audit_logs_device_feed_resource_idx')`.
   */
  usesIndex(name: string | RegExp): boolean;
  /** `true` when the plan contains a `Seq Scan` node anywhere. */
  hasSeqScan: boolean;
}

/**
 * Run `EXPLAIN <query>` as the unprivileged `breeze_app` role, inside an
 * org-scoped `DbAccessContext`, with `enable_seqscan = off`. See the module
 * header for why each of those three pieces is load-bearing.
 */
export async function explainAsBreezeApp(
  opts: ExplainAsBreezeAppOptions,
): Promise<ExplainAsBreezeAppResult> {
  const ctx: DbAccessContext = {
    scope: opts.scope ?? 'organization',
    orgId: opts.orgId,
    accessibleOrgIds: opts.accessibleOrgIds ?? [opts.orgId],
    accessiblePartnerIds: opts.accessiblePartnerIds ?? [],
    userId: opts.userId ?? null,
    ...(opts.currentPartnerId !== undefined ? { currentPartnerId: opts.currentPartnerId } : {}),
  };

  return withDbAccessContext(ctx, async () => {
    await db.execute(sql`SET LOCAL enable_seqscan = off`);
    const inner = 'getSQL' in opts.sql ? opts.sql.getSQL() : opts.sql;
    const rows = await db.execute(sql`EXPLAIN ${inner}`);
    const plan = Array.from(rows as Iterable<unknown>)
      .map((r) => Object.values(r as Record<string, unknown>).join(' '))
      .join('\n');
    return {
      plan,
      usesIndex: (name: string | RegExp) =>
        typeof name === 'string' ? plan.includes(name) : name.test(plan),
      hasSeqScan: plan.includes('Seq Scan'),
    };
  });
}

/**
 * Bulk-insert rows for a skewed-data EXPLAIN fixture, via the admin
 * connection (bypasses RLS on insert — the point is to seed cheaply, not to
 * exercise write-side RLS). Skew (which rows are common vs. rare) is the
 * caller's design: this just inserts whatever row shape you hand it, in one
 * batch, against `table`.
 *
 * Precedent: `deviceEventsFeedIndexes.integration.test.ts`'s `beforeEach`
 * seeds ~3,800 org-noise rows and a handful of specific rows so the planner's
 * index choice isn't a coin toss on a tiny table — production skew is far
 * more extreme still. Follow that shape: seed enough "everything else" rows
 * that an unindexed plan would visibly cost more, plus the few rows each
 * assertion actually checks.
 */
export async function seedSkewedRows<TTable extends PgTable>(
  table: TTable,
  rows: (TTable extends { $inferInsert: infer TInsert } ? TInsert : never)[],
): Promise<void> {
  if (rows.length === 0) return;
  await getTestDb().insert(table).values(rows as never[]);
}

/**
 * `ANALYZE <table>` so the planner's row-count/selectivity estimates reflect
 * the just-seeded skew — without this, a freshly-seeded table can still carry
 * stale (often "table is empty") statistics and the EXPLAIN can pick a
 * different plan than production ever would.
 */
export async function analyzeTable(table: PgTable): Promise<void> {
  const { name } = getTableConfig(table);
  await getTestDb().execute(sql`ANALYZE ${sql.identifier(name)}`);
}
