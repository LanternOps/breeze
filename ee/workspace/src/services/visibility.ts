// The single definition of source visibility, shared by every read path that
// resolves which workspace_sources a caller may see: fileQueryService (query
// builder), contentSearchService (all hybrid arms AND the passages path),
// activityService, and filingService (list, classify, and the participant
// fallback). There is exactly ONE rule here — change it here and every surface
// changes together.
//
// The rule: a source is visible iff it is active AND either it is ungrouped
// (visibility_group_ids = '[]') OR its group list overlaps the caller's claim
// set (jsonb `?|` array-overlap). Empty claims (`groupIds: []`) reduce to
// today's fail-closed behavior — only ungrouped sources are visible — because
// `?|` against an empty array is always false. Helper auth carries no Entra
// group claims yet, so the routes pass `[]` and grouped sources stay hidden
// until claims exist.
import { and, eq, or, sql as drizzleSql, type SQL } from 'drizzle-orm';
import { workspaceSources } from '../schema/workspace';

type SqlTag = typeof drizzleSql;

/**
 * Postgres text[] literal for a string[] bound value. jsonb `?|` needs a
 * text[] on its right-hand side; drizzle's sql tag has no array helper, so the
 * claim set travels as an escaped '{"a","b"}' literal cast to ::text[] (the
 * same idiom the content services use for their id arrays). Empty → '{}'.
 */
function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

/**
 * The source-visibility rule as a raw-SQL predicate fragment, for the services
 * whose queries are raw execute() SQL (content search incl. the passages path,
 * activity, filing). `alias` qualifies the workspace_sources columns — every
 * raw call site joins the table as `s`, which is the default.
 */
export function visibleSourcePredicateSql(sql: SqlTag, groupIds: string[], alias = 's'): SQL {
  const status = sql.raw(`${alias}.status`);
  const groups = sql.raw(`${alias}.visibility_group_ids`);
  return sql`${status} = 'active' AND (${groups} = '[]'::jsonb
    OR ${groups} ?| ${pgTextArray(groupIds)}::text[])`;
}

/**
 * The drizzle-conditions twin of visibleSourcePredicateSql, for
 * fileQueryService's query-builder reads. Same rule expressed over the
 * workspace_sources columns (drizzle qualifies them for us). Returns a single
 * AND-combined condition to drop into an existing `and(...)`.
 */
export function visibleSourceConditions(groupIds: string[]): SQL {
  return and(
    eq(workspaceSources.status, 'active'),
    or(
      drizzleSql`${workspaceSources.visibilityGroupIds} = '[]'::jsonb`,
      drizzleSql`${workspaceSources.visibilityGroupIds} ?| ${pgTextArray(groupIds)}::text[]`,
    ),
  )!;
}
