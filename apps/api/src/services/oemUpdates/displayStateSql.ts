/**
 * `deriveOemDisplayState` as a SQL expression (#11242), so the fleet view can count and
 * page in Postgres instead of classifying the caller's whole scope in the API process.
 *
 * MIRROR OF `deriveOemDisplayState` (`displayState.ts`): change both or neither. The
 * parity test (`__tests__/integration/oemDisplayStateSql.integration.test.ts`) evaluates
 * both over every input combination and fails on any difference.
 *
 * Inputs are the live status row and the device's materialised policy side
 * (`device_oem_policy_side`, kept by `policySideStore.ts`). The time-dependent parts of
 * the rule (has the last night closed, has a reboot been held long enough) are compared
 * against `now` here, so a policy-side row stays right between refreshes.
 *
 * Rules for keeping it faithful:
 *  - Branch order is exactly the TS function's.
 *  - Every threshold and outcome set is imported from the TS rule and bound as a
 *    parameter. The status, mode and state strings are bound parameters too, and must
 *    match the TS literals (the parity test fails if one drifts).
 *  - Every `IN (…)` test is wrapped in `COALESCE(…, false)`: `NULL IN (…)` is NULL, and
 *    `NOT NULL` is NULL too, which would silently skip a branch the TS takes.
 *  - A missing status row or policy side reads as all-NULL columns (a LEFT JOIN), the
 *    same as `status: null` and `linkEnabled: false` with no reboot mode or occurrence.
 *  - The reboot hold is absolute hours (`make_interval(hours => …)`), not days: day
 *    arithmetic follows the session zone's calendar and is an hour off across a DST change.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { FAILING_OUTCOMES, FINISHED_OUTCOMES, OEM_REBOOT_OVERDUE_NIGHTS, type OemDisplayState } from './displayState';
import { OEM_MAX_ATTEMPTS_PER_OCCURRENCE } from './occurrence';

type Operand = AnyColumn | SQL;

export type OemStateSqlColumns = {
  /** `device_oem_update_status` columns, NULL when the device has no status row. */
  applicability: Operand;
  rebootPendingSince: Operand;
  lastOutcome: Operand;
  occurrenceKey: Operand;
  attempts: Operand;
  lastSuccessAt: Operand;
  /** `device_oem_policy_side` columns, NULL when the side is missing or not to be trusted. */
  policy: {
    linkEnabled: Operand;
    rebootMode: Operand;
    occurrenceKey: Operand;
    lastNightStart: Operand;
    pastLastNightAt: Operand;
    managedSince: Operand;
  };
};

const state = (name: OemDisplayState): SQL => sql`${name}::text`;

function isAny(operand: Operand, values: ReadonlySet<string>): SQL {
  return sql`COALESCE(${operand} IN (${sql.join([...values].map((value) => sql`${value}`), sql`, `)}), false)`;
}

export function oemDisplayStateSql(cols: OemStateSqlColumns, now: Date): SQL<OemDisplayState> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const p = cols.policy;

  const finished = isAny(cols.lastOutcome, FINISHED_OUTCOMES);
  const failing = isAny(cols.lastOutcome, FAILING_OUTCOMES);
  // `occurrence && status?.occurrenceKey === occurrence.occurrenceKey`
  const inThisOccurrence = sql`(${p.occurrenceKey} IS NOT NULL AND ${cols.occurrenceKey} IS NOT NULL AND ${cols.occurrenceKey} = ${p.occurrenceKey})`;
  // `occurrence?.isPastLastNight`
  const pastLastNight = sql`(${p.pastLastNightAt} IS NOT NULL AND ${at} >= ${p.pastLastNightAt})`;
  // `hadAChanceAtLastNight(managedSince, occurrence)`, with the last night's window start.
  const hadAChance = sql`NOT (${p.managedSince} IS NOT NULL AND ${p.lastNightStart} IS NOT NULL AND ${p.managedSince} >= ${p.lastNightStart})`;
  const heldHours = OEM_REBOOT_OVERDUE_NIGHTS * 24;

  return sql<OemDisplayState>`(CASE
    WHEN ${cols.applicability} IS NOT DISTINCT FROM ${'not_supported'} THEN ${state('not_supported')}
    WHEN ${cols.rebootPendingSince} IS NOT NULL THEN (CASE
      WHEN ${p.rebootMode} IS NOT DISTINCT FROM ${'never'} THEN ${state('waiting_for_reboot')}
      WHEN ${cols.rebootPendingSince} <= ${at} - make_interval(hours => ${heldHours}::int) THEN ${state('reboot_overdue')}
      ELSE ${state('waiting_for_reboot')}
    END)
    WHEN NOT COALESCE(${p.linkEnabled}, false) OR ${cols.applicability} IS NOT DISTINCT FROM ${'not_applicable'} THEN ${state('not_managed')}
    WHEN ${inThisOccurrence} AND COALESCE(${cols.attempts}, 0) >= ${OEM_MAX_ATTEMPTS_PER_OCCURRENCE}::int AND NOT ${finished} THEN ${state('overdue')}
    WHEN ${failing} THEN ${state('failing')}
    WHEN ${inThisOccurrence} AND ${finished} THEN ${state('up_to_date')}
    WHEN ${pastLastNight} AND ${hadAChance} THEN ${state('overdue')}
    WHEN ${cols.lastSuccessAt} IS NOT NULL THEN ${state('up_to_date')}
    ELSE ${state('not_managed')}
  END)`;
}
