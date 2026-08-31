/**
 * Org-merge policy executors as SQL builders (org-lifecycle Wave 2, Task 2).
 *
 * These build the `drizzle` `SQL` statements the merge engine (Task 3) runs,
 * one policy kind at a time, against `orgMergeRegistry.ts`'s classifications.
 * Builders return `SQL`/`SQL[]` rather than executing anything themselves —
 * the engine is the one that runs them, in order, inside its own transaction.
 *
 * Key/keyWhere literal substitution: the registry's `key` and `keyWhere`
 * strings use `{col}` placeholders for column references inside expressions
 * (`lower({name})`, `{source_ref} IS NOT NULL`,
 * `COALESCE({site_id}, '00000000-0000-0000-0000-000000000000'::uuid)`) so the
 * same literal can be aliased to either side (`s.` for the survivor-side
 * subquery, `t.` for the outer loser-side row) of the dedupe comparison. A
 * bare string with no braces (the common case — a plain column name) is
 * aliased directly.
 */
import { sql, SQL } from 'drizzle-orm';

export interface MergeStatements {
  statements: SQL[];
}

const uuid = (v: string) => sql`${v}::uuid`;

/**
 * Substitutes `{col}` placeholders with `alias.col`, or aliases a bare column
 * name directly.
 *
 * Exported so `orgMergeCustomExecutors.ts`'s re-home-then-delete helper builds
 * its collision predicate through the SAME substitution these generic builders
 * use. A second copy of this three-line regex is exactly the kind of duplicate
 * that drifts silently: the custom executors resolve the same unique keys, and
 * a divergence would show up as a merge that deletes the wrong rows, not as a
 * compile error.
 */
export const keyExpr = (raw: string, alias: string): SQL =>
  sql.raw(raw.includes('{') ? raw.replace(/\{(\w+)\}/g, `${alias}.$1`) : `${alias}.${raw}`);

export function buildRepoint(table: string, loser: string, survivor: string): SQL {
  return sql`UPDATE ${sql.identifier(table)} SET org_id = ${uuid(survivor)} WHERE org_id = ${uuid(loser)}`;
}

export function buildKeepSurvivor(table: string, loser: string, survivor: string): SQL[] {
  return [
    sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loser)} AND EXISTS (SELECT 1 FROM ${sql.identifier(table)} s WHERE s.org_id = ${uuid(survivor)})`,
    buildRepoint(table, loser, survivor),
  ];
}

export function buildRepointDedupe(
  table: string,
  key: readonly string[],
  keyWhere: string | undefined,
  loser: string,
  survivor: string,
): SQL[] {
  const t = sql.identifier(table);
  const matches = key.map((k) => sql`${keyExpr(k, 's')} IS NOT DISTINCT FROM ${keyExpr(k, 't')}`);
  const matchAll = sql.join(matches, sql` AND `);
  const wherePart = (alias: string) =>
    keyWhere ? sql` AND (${sql.raw(keyWhere.replace(/\{(\w+)\}/g, `${alias}.$1`))})` : sql``;
  return [
    sql`DELETE FROM ${t} t WHERE t.org_id = ${uuid(loser)}${wherePart('t')} AND EXISTS (SELECT 1 FROM ${t} s WHERE s.org_id = ${uuid(survivor)}${wherePart('s')} AND ${matchAll})`,
    buildRepoint(table, loser, survivor),
  ];
}

/*
 * Read-only `SELECT count(*)` mirrors of the two DELETEs above, for
 * `previewOrgMerge`'s would-drop column (Task 3). They live HERE, adjacent to
 * the statements they mirror and sharing the same `keyExpr`/`wherePart`
 * substitution, precisely so the preview cannot silently drift from what the
 * merge actually deletes. Any edit to a DELETE predicate above must be
 * mirrored in its twin below; `orgMergeExecutors.test.ts` pins both compiled
 * strings so a one-sided edit fails.
 */

export function buildKeepSurvivorDropCount(table: string, loser: string, survivor: string): SQL {
  const t = sql.identifier(table);
  return sql`SELECT count(*)::int AS n FROM ${t} WHERE org_id = ${uuid(loser)} AND EXISTS (SELECT 1 FROM ${t} s WHERE s.org_id = ${uuid(survivor)})`;
}

export function buildRepointDedupeDropCount(
  table: string,
  key: readonly string[],
  keyWhere: string | undefined,
  loser: string,
  survivor: string,
): SQL {
  const t = sql.identifier(table);
  const matches = key.map((k) => sql`${keyExpr(k, 's')} IS NOT DISTINCT FROM ${keyExpr(k, 't')}`);
  const matchAll = sql.join(matches, sql` AND `);
  const wherePart = (alias: string) =>
    keyWhere ? sql` AND (${sql.raw(keyWhere.replace(/\{(\w+)\}/g, `${alias}.$1`))})` : sql``;
  return sql`SELECT count(*)::int AS n FROM ${t} t WHERE t.org_id = ${uuid(loser)}${wherePart('t')} AND EXISTS (SELECT 1 FROM ${t} s WHERE s.org_id = ${uuid(survivor)}${wherePart('s')} AND ${matchAll})`;
}
