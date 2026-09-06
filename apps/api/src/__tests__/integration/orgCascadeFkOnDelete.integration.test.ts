import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { getOrgCascadeDeleteOrder, __testOnly } from '../../services/tenantCascade';
import {
  ORG_CASCADE_FK_UNSAFE,
  ORG_CASCADE_FK_PRE_CLEARED,
  type OrgCascadeFkReason,
  type OrgCascadeFkRef,
} from './orgCascadeFkOnDeleteAllowlist';

/**
 * Contract test: no foreign key silently blocks GDPR org erasure (#4519).
 *
 * WHAT BREAKS WITHOUT THIS
 *
 * `cascadeDeleteOrg()` erases a tenant with a sequence of ordinary DELETE
 * statements, each in its own system context -- it is NOT one big deferred
 * transaction, so Postgres checks every referencing FK as each statement runs:
 *
 *   step 1b  each `ASSOCIATED_SYSTEM_SCOPED_TABLES` entry, in array order,
 *            with its own hand-written WHERE join;
 *   step 2   every table in `getOrgCascadeDeleteOrder()`, ordered
 *            children-before-parents by `topologicalCascadeOrder()`'s live
 *            `pg_constraint` read, as `DELETE ... WHERE org_id = $1`
 *            (`organizations` itself is keyed on `id`).
 *
 * A foreign key pointing at any table those statements touch is a latent
 * erasure failure unless something clears the referencing rows first. Erasure
 * then works right up until a customer creates the first row in the
 * referencing table, and after that aborts mid-way and leaves the tenant
 * half-deleted. That is exactly how #4100 shipped
 * (`webhook_deliveries.webhook_id -> webhooks.id`, fixed in #4412), and the
 * sweep on that PR found ~73 more edges with the same shape. Nothing guarded
 * it: `tenantCascade.integration.test.ts` checks list membership and
 * topological ordering *within* the cascade set, but never looks at inbound
 * edges from outside it or at `confdeltype` at all; neither does the RLS
 * coverage contract or the export-policy roundtrip.
 *
 * THE SAFETY MODEL
 *
 * `protectedTables` is every table erasure deletes rows from: the cascade set,
 * the step-1b pre-clear targets, and -- transitively -- everything reachable
 * from those by an `ON DELETE CASCADE` edge, since a cascading delete makes
 * that table's own inbound FKs get checked too.
 *
 * For an edge `child -> parent` with `parent` in that set, `classifyEdge()`
 * calls it safe when:
 *
 *   a) the action is `CASCADE` -- Postgres removes the child rows, and the
 *      child is itself in `protectedTables` by the closure above, so its own
 *      inbound edges are audited on their own;
 *   b) the action is `SET NULL` AND every column Postgres would actually null
 *      (`confdelsetcols`, else the whole `conkey`) is nullable. A `SET NULL`
 *      onto a NOT NULL column is accepted at DDL time and fails at delete time
 *      with 23502 -- `action_intents -> tickets` does exactly this today;
 *   c) the child is a step-1b pre-clear target and that pre-clear runs before
 *      the parent's DELETE -- always true when the parent is only in the
 *      cascade set, and otherwise decided by array order;
 *   d) both ends are in the cascade set, so `topologicalCascadeOrder()` puts
 *      the child first;
 *   e) the edge is self-referential AND the table's `org_id` is NOT NULL.
 *
 * (e) is the subtle one. A self-reference is normally safe because one
 * statement removes the org's whole row set and NO ACTION is checked at
 * end-of-statement -- and, verified empirically against Postgres 16, RESTRICT
 * behaves the same way here: it is an AFTER-ROW trigger, not a per-row
 * immediate check, so it too tolerates a row set closed under the FK. What
 * actually matters is that closure. A nullable `org_id` breaks it: under the
 * partner-wide config shape (epic #2135) `WHERE org_id = $1` leaves the
 * partner-owned rows behind, and a surviving row pointing at a deleted one
 * raises 23503 regardless of the action. `script_categories` is in exactly
 * that state today.
 *
 * WHAT THIS DOES NOT PROVE
 *
 * It is a catalog contract, not a data one:
 *
 *   - a CROSS-TENANT row (org B's child pointing at org A's parent) still
 *     breaks erasure under (c) and (d), because those DELETEs only remove org
 *     A's rows. Detecting it needs data; RLS is what is supposed to make it
 *     impossible. Two pre-clear entries carry notes where the pre-clear's join
 *     column differs from the FK's, which is where that assumption is loadest;
 *   - under (c) it cannot read the hand-written `clearSql` to confirm the join
 *     reaches the rows a given FK pins. Pinning per FK rather than per table is
 *     what forces a human to go look when a new FK lands on such a table.
 *
 * WHY IT LIVES HERE
 *
 * Under `src/__tests__/integration/`, so the shared glob in
 * `vitest.integration.config.ts` carries it into the blocking Integration
 * Tests shard with no CI wiring of its own to fall out of date. That does mean
 * it inherits setup.ts's per-test TRUNCATE CASCADE, which a read-only catalog
 * read has no use for; the alternative (the dedicated-runner pattern
 * `rls-coverage.integration.test.ts` uses, which needs its own config plus a
 * hand-maintained CI step) was weighed and rejected -- measured overhead here
 * is well under a second per test against a 25-minute shard budget.
 *
 * Scope is the ORG cascade. The device cascade
 * (`CORE_DEVICE_CASCADE_DELETE_TABLES`) and the partner purge are separate
 * contracts. The seeded ledger lives in `orgCascadeFkOnDeleteAllowlist.ts`;
 * read its header before adding a line.
 */

/** `pg_constraint.confdeltype` codes. */
const DELETE_ACTION_LABELS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

interface FkRow {
  // postgres-js does not camel-case aliases.
  constraint_name: string;
  child_table: string;
  parent_table: string;
  delete_action: string;
  child_columns: string[];
  /** Every referencing column is nullable, so a plain SET NULL would be legal. */
  all_columns_nullable: boolean;
  /** Every column SET NULL would actually null (confdelsetcols, else conkey) is nullable. */
  nulled_columns_nullable: boolean;
}

/**
 * Every foreign key in `public`, with both ends normalised to their partition
 * ROOT.
 *
 * `conparentid = 0` drops the per-partition constraint copies Postgres clones
 * onto each partition; without it `metric_rollups` -- which is in the cascade
 * list and gains a partition every month -- would need a fresh ledger line
 * monthly and would spontaneously redden CI when one appeared. The
 * `pg_partition_root` folding covers the remaining case of a constraint
 * declared directly ON a partition, which a separate test asserts does not
 * exist (see that test for why folding alone would not be enough).
 *
 * Namespaces are checked on both the physical relations and their roots, so a
 * partition rooted outside `public` can neither slip in nor be attributed to a
 * `public` table by name.
 */
async function readForeignKeys(): Promise<FkRow[]> {
  return (await db.execute(sql`
    SELECT
      c.conname           AS constraint_name,
      child_root.relname  AS child_table,
      parent_root.relname AS parent_table,
      c.confdeltype       AS delete_action,
      (SELECT array_agg(a.attname ORDER BY k.ord)
         FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                          AS child_columns,
      (SELECT bool_and(NOT a.attnotnull)
         FROM unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                          AS all_columns_nullable,
      (SELECT bool_and(NOT a.attnotnull)
         FROM unnest(COALESCE(c.confdelsetcols, c.conkey)) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                          AS nulled_columns_nullable
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_class child_root
      ON child_root.oid = COALESCE(pg_partition_root(c.conrelid), c.conrelid)
    JOIN pg_class parent_root
      ON parent_root.oid = COALESCE(pg_partition_root(c.confrelid), c.confrelid)
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN pg_namespace child_root_ns ON child_root_ns.oid = child_root.relnamespace
    JOIN pg_namespace parent_root_ns ON parent_root_ns.oid = parent_root.relnamespace
    WHERE c.contype = 'f'
      AND c.conparentid = 0
      AND child_ns.nspname = 'public'
      AND parent_ns.nspname = 'public'
      AND child_root_ns.nspname = 'public'
      AND parent_root_ns.nspname = 'public'
  `)) as unknown as FkRow[];
}

/** Public tables that have an `org_id` column, and whether it is NOT NULL. */
async function readOrgIdNotNull(): Promise<Map<string, boolean>> {
  const rows = (await db.execute(sql`
    SELECT t.relname AS table_name, a.attnotnull AS not_null
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'org_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p') AND NOT a.attisdropped
  `)) as unknown as Array<{ table_name: string; not_null: boolean }>;
  return new Map(rows.map((row) => [row.table_name, row.not_null]));
}

const cascadeTables = new Set(getOrgCascadeDeleteOrder());
/** Pre-clear table -> its index in ASSOCIATED_SYSTEM_SCOPED_TABLES (the run order). */
const preClearOrder = new Map(
  __testOnly.ASSOCIATED_SYSTEM_SCOPED_TABLES.map((entry, index) => [entry.table, index]),
);

/**
 * Every table erasure removes rows from, including everything an
 * `ON DELETE CASCADE` reaches transitively. A cascading delete triggers the
 * FK checks on the table it reaches, so those tables need auditing as parents
 * too -- otherwise an un-cleared grandchild aborts the original DELETE.
 */
function protectedTables(rows: FkRow[]): Set<string> {
  const reached = new Set<string>([...cascadeTables, ...preClearOrder.keys()]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (row.delete_action === 'c' && reached.has(row.parent_table) && !reached.has(row.child_table)) {
        reached.add(row.child_table);
        changed = true;
      }
    }
  }
  return reached;
}

/**
 * `null` when erasure handles the edge; otherwise the reason it must be
 * pinned. See the header for the argument behind each branch.
 */
function classifyEdge(
  row: FkRow,
  reached: Set<string>,
  orgIdNotNull: Map<string, boolean>,
): OrgCascadeFkReason | null {
  if (!reached.has(row.parent_table)) return null;

  if (row.child_table === row.parent_table) {
    if (row.delete_action === 'c' || row.delete_action === 'n') return null;
    return orgIdNotNull.get(row.child_table) === true ? null : 'self-ref-open-row-set';
  }
  if (row.delete_action === 'n') {
    return row.nulled_columns_nullable ? null : 'set-null-onto-not-null';
  }
  if (row.delete_action === 'c') return null;
  if (row.delete_action === 'd') return 'set-default';

  // NO ACTION / RESTRICT: someone else has to empty the child first.
  const childStep = preClearOrder.get(row.child_table);
  const parentStep = preClearOrder.get(row.parent_table);
  if (childStep !== undefined) {
    // Every pre-clear runs ahead of the whole cascade walk, so a parent that is
    // only in the cascade set is always later than this child.
    if (parentStep === undefined || childStep < parentStep) return 'pre-cleared';
    return 'child-deleted-after-parent';
  }
  if (cascadeTables.has(row.child_table)) {
    // Both in the cascade set -> topologicalCascadeOrder puts the child first.
    // Otherwise the parent is emptied outside the walk (a pre-clear, or as the
    // far end of an ON DELETE CASCADE) while the child waits for it.
    return cascadeTables.has(row.parent_table) ? null : 'child-deleted-after-parent';
  }
  return 'child-not-deleted';
}

const refKey = (ref: Pick<OrgCascadeFkRef, 'childTable' | 'constraint'>) =>
  `${ref.childTable}.${ref.constraint}`;
const rowKey = (row: FkRow) => `${row.child_table}.${row.constraint_name}`;

const describeRow = (row: FkRow, reason: OrgCascadeFkReason) =>
  `${row.child_table}(${row.child_columns.join(', ')}) -> ${row.parent_table} `
  + `[${row.constraint_name}, ON DELETE ${DELETE_ACTION_LABELS[row.delete_action] ?? row.delete_action}`
  + `, ${reason}]`;

const compareRefs = (a: string[], b: string[]) =>
  a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!) || a[2]!.localeCompare(b[2]!);

/** Every edge erasure does NOT handle, keyed for lookup. */
async function classifyAll(): Promise<Map<string, { row: FkRow; reason: OrgCascadeFkReason }>> {
  const [rows, orgIdNotNull] = await Promise.all([readForeignKeys(), readOrgIdNotNull()]);
  const reached = protectedTables(rows);
  const out = new Map<string, { row: FkRow; reason: OrgCascadeFkReason }>();
  for (const row of rows) {
    const reason = classifyEdge(row, reached, orgIdNotNull);
    if (reason !== null) out.set(rowKey(row), { row, reason });
  }
  return out;
}

describe('org-erasure FK ON DELETE contract', () => {
  it('reads a live FK graph in which every classifier branch is exercised', async () => {
    const [rows, orgIdNotNull] = await Promise.all([readForeignKeys(), readOrgIdNotNull()]);
    const reached = protectedTables(rows);

    // A catalog query that quietly returned nothing, or a cascade list that
    // failed to load, would make every other assertion in this file pass while
    // proving nothing at all.
    expect(rows.length).toBeGreaterThan(500);
    expect(cascadeTables.size).toBeGreaterThan(100);
    expect(preClearOrder.size).toBeGreaterThan(0);
    expect(orgIdNotNull.size).toBeGreaterThan(100);
    expect(reached.size).toBeGreaterThan(cascadeTables.size);

    // Each input the classifier discriminates on must actually occur, or a
    // branch could be broken (or dead) and still read green.
    const inbound = rows.filter((row) => reached.has(row.parent_table));
    for (const [label, present] of [
      ['inbound edges', inbound.length > 100],
      ['ON DELETE CASCADE', inbound.some((row) => row.delete_action === 'c')],
      ['ON DELETE SET NULL', inbound.some((row) => row.delete_action === 'n')],
      ['ON DELETE NO ACTION', inbound.some((row) => row.delete_action === 'a')],
      ['ON DELETE RESTRICT', inbound.some((row) => row.delete_action === 'r')],
      ['self-referential', inbound.some((row) => row.child_table === row.parent_table)],
      ['child inside the cascade set', inbound.some((row) => cascadeTables.has(row.child_table))],
      ['child with a pre-clear', inbound.some((row) => preClearOrder.has(row.child_table))],
      ['composite (multi-column)', inbound.some((row) => row.child_columns.length > 1)],
    ] as const) {
      expect(present, `no inbound FK of kind "${label}" in the catalog`).toBe(true);
    }

    // The ledger keys on (table, constraint name); prove that shape resolves.
    expect(new Set(rows.map(rowKey)).has('sessions.sessions_user_id_users_id_fk')).toBe(true);
  });

  it('has no FK constraint declared directly on a partition', async () => {
    // Such a constraint would survive the `conparentid = 0` filter and then be
    // folded onto its root's name, where it could both collide with the root's
    // own constraint name (making the ledger key ambiguous) and disagree with
    // production: `topologicalCascadeOrder()` reads raw `relname`s, so it would
    // never see the edge at all. There are none today; assert it stays that way
    // rather than modelling a case that does not exist.
    const rows = (await db.execute(sql`
      SELECT c.conname, t.relname AS partition_name
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f' AND c.conparentid = 0
        AND t.relispartition AND n.nspname = 'public'
    `)) as unknown as Array<{ conname: string; partition_name: string }>;

    expect(
      rows.map((row) => `${row.partition_name}.${row.conname}`).sort(),
      'Declare the FK on the partitioned PARENT so every partition inherits it, otherwise this '
      + "contract's partition-root folding and topologicalCascadeOrder() disagree about the edge.",
    ).toEqual([]);
  });

  it('every FK erasure does not handle is pinned in the ledger', async () => {
    const unhandled = await classifyAll();
    const pinned = new Set([
      ...ORG_CASCADE_FK_UNSAFE.map(refKey),
      ...ORG_CASCADE_FK_PRE_CLEARED.map(refKey),
    ]);

    const unaccounted = [...unhandled.values()].filter(({ row }) => !pinned.has(rowKey(row)));

    expect(
      unaccounted.map(({ row, reason }) => describeRow(row, reason)).sort(),
      'Foreign key(s) reference a table that GDPR org erasure deletes rows from, and nothing in '
      + 'the erasure path clears the referencing rows first. Each one aborts erasure part-way '
      + 'through as soon as a customer creates a row (that is #4100).\n'
      + 'Fix forward, in order of preference: (1) give the FK ON DELETE CASCADE / SET NULL in a '
      + 'NEW idempotent migration; (2) register the child table in CORE_ORG_CASCADE_DELETE_ORDER '
      + 'plus every other list CLAUDE.md requires; (3) add an ASSOCIATED_SYSTEM_SCOPED_TABLES '
      + 'pre-clear and pin the FK in ORG_CASCADE_FK_PRE_CLEARED. Only if none of those fit, add '
      + 'it to ORG_CASCADE_FK_UNSAFE. See orgCascadeFkOnDeleteAllowlist.ts.',
    ).toEqual([]);
  });

  it('every ledger entry still names a live, still-unhandled FK (burn-down)', async () => {
    const unhandled = await classifyAll();

    const stale = [...ORG_CASCADE_FK_UNSAFE, ...ORG_CASCADE_FK_PRE_CLEARED].filter(
      (ref) => !unhandled.has(refKey(ref)),
    );

    expect(
      stale.map((ref) => `${ref.childTable}.${ref.constraint} -> ${ref.parentTable}`).sort(),
      'These ledger entries no longer describe a real problem -- the FK was dropped, renamed, '
      + 'given an ON DELETE action, or its child table joined the cascade set. Delete the line(s) '
      + 'from orgCascadeFkOnDeleteAllowlist.ts in the same PR as the migration that fixed them. A '
      + 'ledger that overstates the debt is how an allowlist turns into permanent scar tissue.',
    ).toEqual([]);
  });

  it('every ledger entry agrees with the catalog on parent, reason and nullability', async () => {
    const unhandled = await classifyAll();

    const drifted: string[] = [];
    for (const ref of [...ORG_CASCADE_FK_UNSAFE, ...ORG_CASCADE_FK_PRE_CLEARED]) {
      const hit = unhandled.get(refKey(ref));
      if (!hit) continue; // the burn-down test above owns the missing case
      if (hit.row.parent_table !== ref.parentTable) {
        drifted.push(
          `${refKey(ref)}: ledger says parentTable '${ref.parentTable}', `
          + `catalog says '${hit.row.parent_table}'`,
        );
      }
      if (hit.reason !== ref.reason) {
        drifted.push(
          `${refKey(ref)}: ledger says reason '${ref.reason}', catalog says '${hit.reason}'`,
        );
      }
      if (hit.row.all_columns_nullable !== ref.allColumnsNullable) {
        drifted.push(
          `${refKey(ref)}: ledger says allColumnsNullable ${ref.allColumnsNullable}, `
          + `catalog says ${hit.row.all_columns_nullable}`,
        );
      }
    }

    expect(
      drifted.sort(),
      'A ledger entry drifted from the catalog. `reason` and `allColumnsNullable` are recomputed '
      + 'rather than trusted, because they are what a burn-down reads to decide the fix: the '
      + 'reason says which failure this is, and allColumnsNullable says whether plain '
      + 'ON DELETE SET NULL is even legal. Update the entry, and re-read whether the edge is now '
      + 'cheaply fixable.',
    ).toEqual([]);
  });

  it('the two ledger lists agree with the erasure path on which is which', () => {
    // Both directions, so the lists stay mutually exclusive and each keeps
    // meaning what its name says. Without the second half, an FK whose table
    // later gained a pre-clear would sit in the DEBT list forever.
    const notActuallyPreCleared = ORG_CASCADE_FK_PRE_CLEARED.filter(
      (ref) => ref.reason !== 'pre-cleared',
    );
    expect(
      notActuallyPreCleared.map(refKey).sort(),
      'ORG_CASCADE_FK_PRE_CLEARED may only hold entries whose reason is `pre-cleared`. Anything '
      + 'else is unhandled and belongs in ORG_CASCADE_FK_UNSAFE.',
    ).toEqual([]);

    const preClearedFiledAsDebt = ORG_CASCADE_FK_UNSAFE.filter(
      (ref) => ref.reason === 'pre-cleared',
    );
    expect(
      preClearedFiledAsDebt.map(refKey).sort(),
      'These FKs are logged as debt in ORG_CASCADE_FK_UNSAFE, but a step-1b pre-clear now empties '
      + "their table ahead of the parent's DELETE. Check that the pre-clear's clearSql actually "
      + 'reaches these rows, then move the entries to ORG_CASCADE_FK_PRE_CLEARED.',
    ).toEqual([]);
  });

  it('the ledger is duplicate-free, sorted, and explains its unusual entries', () => {
    for (const [name, list] of [
      ['ORG_CASCADE_FK_UNSAFE', ORG_CASCADE_FK_UNSAFE],
      ['ORG_CASCADE_FK_PRE_CLEARED', ORG_CASCADE_FK_PRE_CLEARED],
    ] as const) {
      const keys = list.map(refKey);
      expect(new Set(keys).size, `${name} has duplicate entries`).toBe(keys.length);

      // Field-wise, not a concatenated string: collation of the separator
      // against '_' would otherwise make "sorted" mean something subtly
      // different from how a human orders the columns.
      const sortKeys = list.map((ref) => [ref.parentTable, ref.childTable, ref.constraint]);
      expect(
        sortKeys,
        `${name} must stay sorted by (parentTable, childTable, constraint) so that adding or `
        + 'burning down an entry produces a one-line diff.',
      ).toEqual([...sortKeys].sort(compareRefs));
    }

    // `child-not-deleted` and `pre-cleared` are self-explanatory shapes and
    // make up the bulk of the seeded ledger. Every other reason is unusual
    // enough that a future reader needs to be told what is going on -- and it
    // is exactly those that turn out to be live failures rather than latent
    // ones, so they must not be filed silently.
    const unexplained = [...ORG_CASCADE_FK_UNSAFE, ...ORG_CASCADE_FK_PRE_CLEARED].filter(
      (ref) =>
        ref.reason !== 'child-not-deleted'
        && ref.reason !== 'pre-cleared'
        && (ref.note ?? '').trim().length < 40,
    );
    expect(
      unexplained.map((ref) => `${refKey(ref)} (${ref.reason})`).sort(),
      'A ledger entry whose reason is not the ordinary `child-not-deleted` shape must carry a '
      + '`note` saying what actually goes wrong and how to fix it.',
    ).toEqual([]);

    // An empty-ish note anywhere reads as "reviewed" without saying anything.
    for (const ref of [...ORG_CASCADE_FK_UNSAFE, ...ORG_CASCADE_FK_PRE_CLEARED]) {
      if (ref.note !== undefined) {
        expect(ref.note.trim().length, `${refKey(ref)} has a near-empty note`).toBeGreaterThan(40);
      }
    }
  });
});
