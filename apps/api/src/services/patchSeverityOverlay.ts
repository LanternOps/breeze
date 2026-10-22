/**
 * Effective per-device patch severity/category: the shared, trusted
 * classification on `patches` when known, else this device's own
 * `device_patches.reported_severity`/`.reported_category` (see
 * routes/agents/patches.ts and the doc block on the `device_patches` schema).
 *
 * `patches` is a global, un-tenanted row with no trusted classifier for
 * `microsoft`/`apple`/`linux`/`custom` sources — those stay `'unknown'`/NULL
 * forever there. The per-device columns give each tenant its own agent's
 * report back WITHOUT ever letting one device's report move the shared
 * classification (and therefore every other tenant's auto-approval rules).
 *
 * Every consumer here MUST select/filter against a query that already joins
 * `device_patches` scoped to the caller's own device_id/org_id — these
 * fragments read `devicePatches.reportedSeverity`/`.reportedCategory` off
 * whatever row is in scope, so the tenant boundary is entirely the caller's
 * join/where, exactly like every other per-device column on that table.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { devicePatches, devices, patches } from '../db/schema';

/** SQL fragment: effective severity for the device_patches row in scope. */
export const EFFECTIVE_PATCH_SEVERITY_SQL: SQL<string | null> = sql<string | null>`
  COALESCE(NULLIF(${patches.severity}::text, 'unknown'), ${devicePatches.reportedSeverity}::text, 'unknown')::patch_severity
`;

/** SQL fragment: effective category for the device_patches row in scope. */
export const EFFECTIVE_PATCH_CATEGORY_SQL: SQL<string | null> = sql<string | null>`
  COALESCE(${patches.category}, ${devicePatches.reportedCategory})
`;

/**
 * Same effective-severity rule applied in application code, for callers that
 * already hold both values (e.g. a row already selected with the raw
 * columns) rather than building a new SQL projection.
 */
export function effectivePatchSeverity(
  sharedSeverity: string | null | undefined,
  reportedSeverity: string | null | undefined
): string | null {
  if (sharedSeverity && sharedSeverity !== 'unknown') return sharedSeverity;
  return reportedSeverity ?? sharedSeverity ?? null;
}

export function effectivePatchCategory(
  sharedCategory: string | null | undefined,
  reportedCategory: string | null | undefined
): string | null {
  return sharedCategory ?? reportedCategory ?? null;
}

/**
 * Aggregate form of `EFFECTIVE_PATCH_SEVERITY_SQL`, for a query that
 * collapses several `device_patches` rows into one row per patch (e.g. a
 * distinct/grouped catalog listing scoped to one org or one update ring's
 * device set) and therefore cannot show a single row's value directly.
 *
 * Picks the most severe effective value seen across the grouped rows (worst
 * case wins) so the listing never under-reports risk. Must be used inside a
 * query whose GROUP BY / device scope is already pinned to one org (or one
 * ring's resolved device set within one partner) — this fragment has no
 * scoping of its own, same rule as the per-row fragments above.
 */
export const AGGREGATED_EFFECTIVE_PATCH_SEVERITY_SQL: SQL<string> = sql<string>`
  (CASE MIN(
    CASE ${EFFECTIVE_PATCH_SEVERITY_SQL}
      WHEN 'critical' THEN 0
      WHEN 'important' THEN 1
      WHEN 'moderate' THEN 2
      WHEN 'low' THEN 3
      ELSE 4
    END
  )
    WHEN 0 THEN 'critical'
    WHEN 1 THEN 'important'
    WHEN 2 THEN 'moderate'
    WHEN 3 THEN 'low'
    ELSE 'unknown'
  END)::patch_severity
`;

/**
 * Catalog-row form, for a query that lists `patches` rows directly (one row
 * per catalog entry, no `device_patches` join in scope) — GET /patches
 * (#9387). The trusted shared classification when known, otherwise the most
 * severe value reported by any device that `deviceScope` admits, otherwise
 * `'unknown'`.
 *
 * Unlike the fragments above, this one carries its own scoping: the fallback
 * is a correlated subquery over `device_patches` joined to `devices`, pinned
 * to `deviceScope` — the caller's device-row predicates (in practice
 * `resolveOutstandingDeviceScope`, i.e. `auth.orgCondition(devices.orgId)`
 * plus `?orgId=` and site narrowing). `patches` is global, so without that
 * predicate the fallback would fold every tenant's device reports into the
 * value one tenant sees. `null` scope (the caller can see no devices) means
 * no device report is admitted and only the trusted value is shown.
 *
 * Reuses `AGGREGATED_EFFECTIVE_PATCH_SEVERITY_SQL` for the worst-case pick so
 * there is one severity rank, not two; inside the subquery `patches.severity`
 * resolves to the outer catalog row.
 */
export function catalogEffectivePatchSeveritySql(deviceScope: SQL[] | null): SQL<string> {
  if (!deviceScope) {
    return sql<string>`COALESCE(${patches.severity}, 'unknown')::patch_severity`;
  }
  const resolved = sql<string>`COALESCE(NULLIF(${patches.severity}::text, 'unknown'), (
    SELECT ${AGGREGATED_EFFECTIVE_PATCH_SEVERITY_SQL}::text
    FROM ${devicePatches}
    INNER JOIN ${devices} ON ${devices.id} = ${devicePatches.deviceId}
    WHERE ${and(
      eq(devicePatches.patchId, patches.id),
      sql`${devicePatches.reportedSeverity} IS NOT NULL`,
      ...deviceScope,
    )}
  ), 'unknown')::patch_severity`;
  // Nest once more on purpose. In a single-table select (`db.select().from(patches)`)
  // Drizzle's buildSelection strips the table qualifier from the columns that
  // sit directly in a selected SQL fragment's top-level chunks, which would
  // render `"id" = "device_id"` inside the subquery and fail as ambiguous
  // (device_patches and devices both have `id`). Columns in nested fragments
  // keep their `"table"."column"` form.
  return sql<string>`${resolved}`;
}

/** Aggregate form of `EFFECTIVE_PATCH_CATEGORY_SQL` — see the severity variant above. */
export const AGGREGATED_EFFECTIVE_PATCH_CATEGORY_SQL: SQL<string | null> = sql<string | null>`
  MAX(${EFFECTIVE_PATCH_CATEGORY_SQL})
`;
