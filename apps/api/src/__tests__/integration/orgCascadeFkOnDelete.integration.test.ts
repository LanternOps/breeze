import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { getOrgCascadeDeleteOrder, __testOnly } from '../../services/tenantCascade';
import {
  ORG_CASCADE_FK_KNOWN_UNSAFE,
  ORG_CASCADE_FK_PRE_CLEARED,
  type OrgCascadeFkRef,
} from './orgCascadeFkOnDeleteAllowlist';

/**
 * Contract test: no foreign key silently blocks GDPR org erasure (#4519).
 *
 * WHAT BREAKS WITHOUT THIS
 *
 * `cascadeDeleteOrg()` erases a tenant by running a plain
 * `DELETE FROM <t> WHERE org_id = $1` over every table in
 * `getOrgCascadeDeleteOrder()`, ordered children-before-parents by
 * `topologicalCascadeOrder()`'s live `pg_constraint` read. Each table's DELETE
 * is its own statement in its own system context -- the cascade is NOT one big
 * deferred transaction -- so Postgres checks every referencing FK as that
 * statement runs.
 *
 * A foreign key POINTING AT a cascade table is therefore only safe if one of
 * these holds:
 *
 *   a) it declares `ON DELETE CASCADE` or `ON DELETE SET NULL`, so Postgres
 *      clears the child itself;
 *   b) the referencing table is ALSO in `getOrgCascadeDeleteOrder()`, so the
 *      topological walk empties it first;
 *   c) the referencing table is emptied by an
 *      `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear (step 1b of
 *      `cascadeDeleteOrg`), which runs ahead of the whole walk;
 *   d) it is self-referential -- one statement removes the org's whole row set
 *      and NO ACTION is checked at end-of-statement. (RESTRICT is checked per
 *      row and would NOT be safe here; the test rejects it.)
 *
 * Anything else is a latent `23503 foreign_key_violation`: erasure works right
 * up until a customer creates the first row in the child table, then aborts
 * mid-way and leaves the tenant half-deleted. That is exactly how #4100
 * shipped (`webhook_deliveries.webhook_id -> webhooks.id`, fixed in #4412) --
 * and the sweep on that PR found ~73 more edges with the same shape. Nothing
 * in `tenantCascade.integration.test.ts` (which only checks LIST membership),
 * the RLS coverage contract, or the export-policy roundtrip looks at
 * `confdeltype` at all.
 *
 * WHAT THIS TEST DOES NOT PROVE
 *
 * It is a catalog contract, not a data one. Two gaps, deliberately:
 *
 *   - A CROSS-TENANT row (org B's child row pointing at org A's parent row)
 *     still breaks erasure even under (b), because `DELETE ... WHERE org_id =
 *     $1` only removes org A's children. Detecting that needs data; RLS is
 *     what is supposed to make it impossible.
 *   - Under (c) it checks that the pre-clear table is registered and that the
 *     specific FK is pinned in `ORG_CASCADE_FK_PRE_CLEARED` -- it cannot read
 *     the hand-written `clearSql` and confirm the join actually reaches those
 *     rows. Pinning per FK (rather than per table) is what forces a human to
 *     go look when a new FK lands on one of those tables.
 *
 * Scope is the ORG cascade. The device cascade
 * (`CORE_DEVICE_CASCADE_DELETE_TABLES`) and the partner purge are separate
 * contracts.
 *
 * The seeded debt lives in `orgCascadeFkOnDeleteAllowlist.ts`; read its header
 * before adding a line to it.
 */

/** `pg_constraint.confdeltype` codes. */
const DELETE_ACTION_LABELS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/**
 * Actions under which Postgres clears the reference for us.
 *
 * SET DEFAULT ('d') is NOT here on purpose: it is only safe when the column
 * default is NULL, which would take another catalog read to know, and no FK in
 * this schema uses it. If one ever appears it should land in the ledger with a
 * note rather than be waved through.
 */
const SELF_CLEARING_DELETE_ACTIONS = new Set(['c', 'n']);

interface FkRow {
  // postgres-js does not camel-case aliases.
  constraint_name: string;
  child_table: string;
  parent_table: string;
  delete_action: string;
  child_columns: string[];
  any_not_null: boolean;
}

/**
 * Every foreign key in `public`, with both ends normalised to their partition
 * ROOT.
 *
 * `conparentid = 0` drops the per-partition copies Postgres clones onto each
 * partition, and `pg_partition_root` folds a constraint declared directly on a
 * partition back onto the root name. Both matter for `metric_rollups`, which
 * is in the cascade list and gains a fresh monthly partition: without this the
 * ledger would need a new line every month and would spontaneously redden CI
 * when one appeared.
 */
async function readForeignKeys(): Promise<FkRow[]> {
  return (await db.execute(sql`
    SELECT
      c.conname          AS constraint_name,
      child_root.relname AS child_table,
      parent_root.relname AS parent_table,
      c.confdeltype      AS delete_action,
      (SELECT array_agg(a.attname ORDER BY k.ord)
         FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                         AS child_columns,
      (SELECT bool_or(a.attnotnull)
         FROM unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
                         AS any_not_null
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_class child_root
      ON child_root.oid = COALESCE(pg_partition_root(c.conrelid), c.conrelid)
    JOIN pg_class parent_root
      ON parent_root.oid = COALESCE(pg_partition_root(c.confrelid), c.confrelid)
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE c.contype = 'f'
      AND child_ns.nspname = 'public'
      AND parent_ns.nspname = 'public'
      AND c.conparentid = 0
  `)) as unknown as FkRow[];
}

const cascadeTables = new Set(getOrgCascadeDeleteOrder());
const preClearedTables = new Set(
  __testOnly.ASSOCIATED_SYSTEM_SCOPED_TABLES.map((entry) => entry.table),
);

const refKey = (ref: Pick<OrgCascadeFkRef, 'childTable' | 'constraint'>) =>
  `${ref.childTable}.${ref.constraint}`;
const rowKey = (row: FkRow) => `${row.child_table}.${row.constraint_name}`;

const describeRow = (row: FkRow) =>
  `${row.child_table}(${row.child_columns.join(', ')}) -> ${row.parent_table} `
  + `[${row.constraint_name}, ON DELETE ${DELETE_ACTION_LABELS[row.delete_action] ?? row.delete_action}`
  + `${row.any_not_null ? ', NOT NULL' : ''}]`;

/**
 * Edges that need an explicit answer: they point INTO the cascade set, are not
 * self-referential, Postgres will not clear them, and the referencing table is
 * not emptied by the cascade walk itself.
 */
function unresolvedEdges(rows: FkRow[]): FkRow[] {
  return rows.filter(
    (row) =>
      cascadeTables.has(row.parent_table)
      && row.child_table !== row.parent_table
      && !SELF_CLEARING_DELETE_ACTIONS.has(row.delete_action)
      && !cascadeTables.has(row.child_table),
  );
}

describe('org-erasure FK ON DELETE contract', () => {
  it('reads a live, non-trivial FK graph (guards against a vacuously green run)', async () => {
    const rows = await readForeignKeys();

    // A catalog query that quietly returns nothing would make every other
    // assertion in this file pass while proving nothing at all.
    expect(rows.length).toBeGreaterThan(500);
    expect(cascadeTables.size).toBeGreaterThan(100);
    expect(preClearedTables.size).toBeGreaterThan(0);

    const intoCascade = rows.filter((row) => cascadeTables.has(row.parent_table));
    expect(intoCascade.length).toBeGreaterThan(100);
    // Every branch the classifier discriminates on must actually be present,
    // or a broken classifier would still read green.
    expect(intoCascade.some((row) => row.delete_action === 'c')).toBe(true);
    expect(intoCascade.some((row) => row.delete_action === 'n')).toBe(true);
    expect(intoCascade.some((row) => row.delete_action === 'a')).toBe(true);

    // The ledger is keyed on (table, constraint name) pairs, so prove that
    // shape resolves against the real catalog for at least one known FK.
    expect(new Set(rows.map(rowKey)).has('sessions.sessions_user_id_users_id_fk')).toBe(true);
  });

  it('every FK into an org-cascade table is FK-safe, pre-cleared, or in the ledger', async () => {
    const rows = await readForeignKeys();
    const pinned = new Set([
      ...ORG_CASCADE_FK_KNOWN_UNSAFE.map(refKey),
      ...ORG_CASCADE_FK_PRE_CLEARED.map(refKey),
    ]);

    const unaccounted = unresolvedEdges(rows).filter((row) => !pinned.has(rowKey(row)));

    expect(
      unaccounted.map(describeRow).sort(),
      'Foreign key(s) reference a table in the org-erasure cascade without an ON DELETE '
      + 'action, and nothing empties the referencing table first. Each one aborts GDPR org '
      + 'erasure with 23503 as soon as a customer creates a row in it (that is #4100).\n'
      + 'Fix forward, in order of preference: (1) give the FK ON DELETE CASCADE / SET NULL in '
      + 'a NEW idempotent migration; (2) register the child table in '
      + 'CORE_ORG_CASCADE_DELETE_ORDER plus every other list CLAUDE.md requires; (3) add an '
      + 'ASSOCIATED_SYSTEM_SCOPED_TABLES pre-clear and pin the FK in '
      + 'ORG_CASCADE_FK_PRE_CLEARED. Only if none of those fit, add it to '
      + 'ORG_CASCADE_FK_KNOWN_UNSAFE with a note saying why. See '
      + 'orgCascadeFkOnDeleteAllowlist.ts.',
    ).toEqual([]);
  });

  it('no self-referential FK on a cascade table uses RESTRICT or SET DEFAULT', async () => {
    const rows = await readForeignKeys();

    // This closes the one hole exemption (d) opens. A self-referential edge is
    // waved through on the argument that `DELETE ... WHERE org_id = $1` removes
    // the org's whole row set in ONE statement, and NO ACTION is checked at
    // end-of-statement -- by which point both ends are gone.
    //
    // That argument is specific to NO ACTION. RESTRICT is checked immediately,
    // per row, and no amount of deferral rescues it: a parent row referenced by
    // a sibling row in the same org aborts the DELETE even though the sibling
    // is going away in that very statement. SET DEFAULT is only safe when the
    // column default is NULL, which this catalog read does not establish.
    //
    // Non-self-referential RESTRICT is NOT flagged here: it is either handled
    // by unresolvedEdges() above (child outside the cascade set) or genuinely
    // safe (child inside it, emptied first by its own earlier statement) --
    // ten such edges exist today, all in the ai_agents / contracts stacks.
    const offenders = rows.filter(
      (row) =>
        cascadeTables.has(row.parent_table)
        && row.child_table === row.parent_table
        && (row.delete_action === 'r' || row.delete_action === 'd'),
    );

    expect(
      offenders.map(describeRow).sort(),
      'A self-referential ON DELETE RESTRICT / SET DEFAULT on an org-cascade table aborts '
      + 'erasure the moment two rows in the same org reference each other. Use CASCADE, '
      + 'SET NULL, or plain NO ACTION.',
    ).toEqual([]);
  });

  it('every ledger entry still names a live, still-unsafe FK (burn-down)', async () => {
    const rows = await readForeignKeys();
    const stillUnresolved = new Set(unresolvedEdges(rows).map(rowKey));

    const stale = [...ORG_CASCADE_FK_KNOWN_UNSAFE, ...ORG_CASCADE_FK_PRE_CLEARED].filter(
      (ref) => !stillUnresolved.has(refKey(ref)),
    );

    expect(
      stale.map((ref) => `${ref.childTable}.${ref.constraint} -> ${ref.parentTable}`).sort(),
      'These ledger entries no longer describe a real problem -- the FK was dropped, renamed, '
      + 'given an ON DELETE action, or its child table joined the cascade set. Delete the '
      + 'line(s) from orgCascadeFkOnDeleteAllowlist.ts in the same PR as the migration that '
      + 'fixed them. A ledger that overstates the debt is how an allowlist turns into '
      + 'permanent scar tissue.',
    ).toEqual([]);
  });

  it('ledger entries agree with the catalog on parent table and NOT NULL', async () => {
    const rows = await readForeignKeys();
    const byKey = new Map(rows.map((row) => [rowKey(row), row]));

    const drifted: string[] = [];
    for (const ref of [...ORG_CASCADE_FK_KNOWN_UNSAFE, ...ORG_CASCADE_FK_PRE_CLEARED]) {
      const row = byKey.get(refKey(ref));
      if (!row) continue; // the burn-down test above owns the missing case
      if (row.parent_table !== ref.parentTable) {
        drifted.push(
          `${refKey(ref)}: ledger says parentTable '${ref.parentTable}', `
          + `catalog says '${row.parent_table}'`,
        );
      }
      if (row.any_not_null !== ref.notNull) {
        drifted.push(
          `${refKey(ref)}: ledger says notNull ${ref.notNull}, catalog says ${row.any_not_null}`,
        );
      }
    }

    expect(
      drifted.sort(),
      'A ledger entry drifted from the catalog. `notNull` is the triage signal that decides '
      + 'whether ON DELETE SET NULL is even available, so it is verified rather than trusted: '
      + 'update the entry, and re-read whether the edge is now cheaply fixable.',
    ).toEqual([]);
  });

  it('every pre-cleared entry names a table with an ASSOCIATED_SYSTEM_SCOPED_TABLES pre-clear', () => {
    const misfiled = ORG_CASCADE_FK_PRE_CLEARED.filter(
      (ref) => !preClearedTables.has(ref.childTable),
    );

    expect(
      misfiled.map(refKey).sort(),
      'ORG_CASCADE_FK_PRE_CLEARED claims these FKs are handled by a step-1b pre-clear, but '
      + 'their table is not in ASSOCIATED_SYSTEM_SCOPED_TABLES (services/tenantCascade.ts). '
      + 'Either add the pre-clear, or move the entry to ORG_CASCADE_FK_KNOWN_UNSAFE.',
    ).toEqual([]);
  });

  it('the ledger has no duplicates and stays sorted for reviewable diffs', () => {
    for (const [name, list] of [
      ['ORG_CASCADE_FK_KNOWN_UNSAFE', ORG_CASCADE_FK_KNOWN_UNSAFE],
      ['ORG_CASCADE_FK_PRE_CLEARED', ORG_CASCADE_FK_PRE_CLEARED],
    ] as const) {
      const keys = list.map(refKey);
      expect(new Set(keys).size, `${name} has duplicate entries`).toBe(keys.length);

      // Field-wise, not a concatenated string: collation of the separator
      // against '_' would otherwise make "sorted" mean something subtly
      // different from how a human orders the columns.
      const sortKeys: Array<[string, string, string]> = list.map(
        (ref) => [ref.parentTable, ref.childTable, ref.constraint],
      );
      const sorted = [...sortKeys].sort(
        (a, b) =>
          a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]),
      );
      expect(
        sortKeys,
        `${name} must stay sorted by (parentTable, childTable, constraint) so that adding or `
        + 'burning down an entry produces a one-line diff.',
      ).toEqual(sorted);
    }

    // A note is optional (entries seeded from the #4519 sweep are plain debt),
    // but an empty one is worse than none: it reads as "reviewed" without
    // saying anything.
    for (const ref of [...ORG_CASCADE_FK_KNOWN_UNSAFE, ...ORG_CASCADE_FK_PRE_CLEARED]) {
      if (ref.note !== undefined) {
        expect(ref.note.trim().length, `${refKey(ref)} has an empty note`).toBeGreaterThan(20);
      }
    }
  });
});
