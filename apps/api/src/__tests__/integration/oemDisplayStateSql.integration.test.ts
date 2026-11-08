/**
 * The vendor update display state in SQL against the TS rule it mirrors (#11242).
 *
 * `oemDisplayStateSql` is a hand-kept copy of `deriveOemDisplayState`, so the fleet view
 * can count and page in Postgres. This evaluates both over every input combination that
 * matters and requires the same answer for each: NULL for every nullable input (SQL's
 * three-valued logic is the usual way such a copy drifts), each outcome, the attempt cap
 * on both sides, the last night's edge, and a 72 h reboot hold straddling the US DST end
 * of 2026-11-01 under a session zone that observes it (calendar interval arithmetic would
 * be an hour off there).
 *
 * No table is read: the rows go in as one jsonb parameter.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { OEM_OUTCOMES, type OemOutcome } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import type { OemApplicabilityState } from '../../db/schema';
import { deriveOemDisplayState, type OemDisplayState } from '../../services/oemUpdates/displayState';
import { oemDisplayStateSql } from '../../services/oemUpdates/displayStateSql';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Just after the US DST end (2026-11-01T06:00Z), so every reboot hold below straddles it.
const NOW = new Date('2026-11-02T12:00:00.000Z');
const KEY = '2026-10';
const LAST_NIGHT_START = new Date(NOW.getTime() - 2 * DAY);

type Row = {
  idx: number;
  // Status row (all null when the device has none).
  applicability: OemApplicabilityState | null;
  reboot_pending_since: string | null;
  last_outcome: OemOutcome | null;
  status_occurrence_key: string | null;
  attempts: number | null;
  last_success_at: string | null;
  // Policy side (all null when there is no row).
  link_enabled: boolean | null;
  reboot_mode: 'overnight' | 'never' | null;
  occurrence_key: string | null;
  last_night_start: string | null;
  past_last_night_at: string | null;
  managed_since: string | null;
};

const iso = (at: Date | null): string | null => (at ? at.toISOString() : null);
const at = (value: string | null): Date | null => (value ? new Date(value) : null);

/** What the TS rule says for one row, built the way `classifyOemDevice` builds its input. */
function expected(row: Row): OemDisplayState {
  const pastAt = at(row.past_last_night_at);
  return deriveOemDisplayState({
    status: row.applicability === null
      ? null
      : {
          applicability: row.applicability,
          lastOutcome: row.last_outcome,
          occurrenceKey: row.status_occurrence_key,
          lastSuccessAt: at(row.last_success_at),
          rebootPendingSince: at(row.reboot_pending_since),
          attempts: row.attempts ?? 0,
        },
    linkEnabled: row.link_enabled ?? false,
    rebootMode: row.reboot_mode ?? undefined,
    occurrence: row.occurrence_key === null
      ? null
      : {
          occurrenceKey: row.occurrence_key,
          isPastLastNight: pastAt !== null && NOW.getTime() >= pastAt.getTime(),
          windowStart: at(row.last_night_start) ?? undefined,
        },
    managedSince: at(row.managed_since),
    now: NOW,
  });
}

type Status = Pick<Row, 'applicability' | 'reboot_pending_since' | 'last_outcome' | 'status_occurrence_key' | 'attempts' | 'last_success_at'>;
type Policy = Pick<Row, 'link_enabled' | 'reboot_mode' | 'occurrence_key' | 'last_night_start' | 'past_last_night_at' | 'managed_since'>;

const NO_STATUS: Status = {
  applicability: null,
  reboot_pending_since: null,
  last_outcome: null,
  status_occurrence_key: null,
  attempts: null,
  last_success_at: null,
};
const NO_POLICY: Policy = {
  link_enabled: null,
  reboot_mode: null,
  occurrence_key: null,
  last_night_start: null,
  past_last_night_at: null,
  managed_since: null,
};

const REBOOT_HELD = [
  null,
  iso(new Date(NOW.getTime() - (72 * HOUR - 60_000))), // 71 h 59 m
  iso(new Date(NOW.getTime() - (72 * HOUR - 1))), // a millisecond short
  iso(new Date(NOW.getTime() - 72 * HOUR)), // exactly 72 h, across the DST end
  iso(new Date(NOW.getTime() - 5 * DAY)),
];
const REBOOT_MODES = [null, 'overnight', 'never'] as const;
const OUTCOMES: Array<OemOutcome | null> = [null, ...OEM_OUTCOMES];
const ATTEMPTS = [null, 0, 2, 3, 4];
/** The occurrence's last night closes before, at, or after `NOW`; or there is no occurrence. */
const PAST_AT = [
  null,
  iso(new Date(NOW.getTime() - HOUR)),
  iso(NOW),
  iso(new Date(NOW.getTime() + HOUR)),
];
const MANAGED_SINCE = [
  null,
  iso(new Date(LAST_NIGHT_START.getTime() - DAY)),
  iso(LAST_NIGHT_START),
  iso(new Date(LAST_NIGHT_START.getTime() + HOUR)),
];

function policy(linkEnabled: boolean | null, pastAt: string | null, managedSince: string | null, rebootMode: Policy['reboot_mode'] = 'overnight'): Policy {
  if (linkEnabled === null) return NO_POLICY;
  return {
    link_enabled: linkEnabled,
    reboot_mode: rebootMode,
    occurrence_key: pastAt === null ? null : KEY,
    last_night_start: pastAt === null ? null : iso(LAST_NIGHT_START),
    past_last_night_at: pastAt,
    managed_since: managedSince,
  };
}

function buildMatrix(): Row[] {
  const rows: Row[] = [];
  const push = (status: Status, side: Policy) => rows.push({ idx: rows.length, ...status, ...side });

  // Reboot block: every applicability (and none) against every hold, mode and link state.
  for (const applicability of [null, 'applicable', 'not_applicable', 'not_supported'] as const) {
    for (const held of REBOOT_HELD) {
      for (const mode of REBOOT_MODES) {
        for (const linkEnabled of [null, false, true]) {
          const status: Status = applicability === null
            ? NO_STATUS
            : { ...NO_STATUS, applicability, reboot_pending_since: held, last_outcome: 'success_reboot_required', status_occurrence_key: KEY, attempts: 1 };
          push(status, linkEnabled === null ? NO_POLICY : { ...policy(linkEnabled, PAST_AT[1]!, MANAGED_SINCE[1]!), reboot_mode: mode });
        }
      }
    }
  }

  // Main block: no reboot owed, so every later branch of the rule is reachable.
  for (const applicability of ['applicable', 'not_applicable'] as const) {
    for (const outcome of OUTCOMES) {
      for (const statusKey of [null, KEY, '2026-09']) {
        for (const attempts of ATTEMPTS) {
          for (const lastSuccess of [null, iso(new Date(NOW.getTime() - 40 * DAY))]) {
            for (const linkEnabled of [null, false, true]) {
              for (const pastAt of PAST_AT) {
                for (const managedSince of MANAGED_SINCE) {
                  // A link that is off never carries an occurrence; one variant of it is enough.
                  if (linkEnabled !== true && (pastAt !== null || managedSince !== null)) continue;
                  push(
                    { applicability, reboot_pending_since: null, last_outcome: outcome, status_occurrence_key: statusKey, attempts, last_success_at: lastSuccess },
                    policy(linkEnabled, pastAt, managedSince),
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  // No status row: only the policy side can say anything.
  for (const linkEnabled of [null, false, true]) {
    for (const pastAt of PAST_AT) {
      for (const managedSince of MANAGED_SINCE) {
        push(NO_STATUS, policy(linkEnabled, pastAt, managedSince));
      }
    }
  }
  return rows;
}

async function sqlStates(rows: Row[], now: Date, timeZone: string): Promise<Map<number, string>> {
  const col = (name: string) => sql.raw(`r.${name}`);
  const state = oemDisplayStateSql({
    applicability: col('applicability'),
    rebootPendingSince: col('reboot_pending_since'),
    lastOutcome: col('last_outcome'),
    occurrenceKey: col('status_occurrence_key'),
    attempts: col('attempts'),
    lastSuccessAt: col('last_success_at'),
    policy: {
      linkEnabled: col('link_enabled'),
      rebootMode: col('reboot_mode'),
      occurrenceKey: col('occurrence_key'),
      lastNightStart: col('last_night_start'),
      pastLastNightAt: col('past_last_night_at'),
      managedSince: col('managed_since'),
    },
  }, now);
  const result = await withSystemDbAccessContext(async () => {
    // The caller's session zone. Under America/New_York the window under test crosses
    // a DST change, so calendar interval arithmetic would be an hour off the 72 h rule.
    await db.execute(sql`SELECT set_config('TimeZone', ${timeZone}, true)`);
    return db.execute(sql`
      SELECT r.idx, ${state} AS state
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
        idx int,
        applicability varchar(16),
        reboot_pending_since timestamptz,
        last_outcome varchar(32),
        status_occurrence_key varchar(64),
        attempts integer,
        last_success_at timestamptz,
        link_enabled boolean,
        reboot_mode varchar(16),
        occurrence_key varchar(64),
        last_night_start timestamptz,
        past_last_night_at timestamptz,
        managed_since timestamptz
      )
    `);
  }) as unknown as Array<{ idx: number; state: string }>;
  return new Map(result.map((row) => [Number(row.idx), row.state]));
}

describe('#11242 oemDisplayStateSql', () => {
  runDb('the SQL state equals deriveOemDisplayState for every input combination', async () => {
    const rows = buildMatrix();
    expect(rows.length).toBeGreaterThan(5_000);
    expect(rows.length).toBeLessThan(20_000);

    const actual = await sqlStates(rows, NOW, 'America/New_York');
    expect(actual.size).toBe(rows.length);

    const mismatches = rows
      .map((row) => ({ row, want: expected(row), got: actual.get(row.idx) }))
      .filter(({ want, got }) => want !== got);
    expect(mismatches.slice(0, 20), JSON.stringify(mismatches.slice(0, 20), null, 1)).toEqual([]);

    // The matrix reaches every state, so a branch the SQL lost cannot hide behind it.
    expect(new Set(rows.map(expected))).toEqual(new Set([
      'up_to_date', 'overdue', 'failing', 'not_supported', 'not_managed', 'waiting_for_reboot', 'reboot_overdue',
    ]));
  });

  runDb('a 72 h hold reads reboot overdue exactly at 72 h, whatever the session zone', async () => {
    const held = { ...NO_STATUS, applicability: 'applicable' as const, reboot_pending_since: iso(new Date(NOW.getTime() - 72 * HOUR)) };
    const rows: Row[] = [{ idx: 0, ...held, ...policy(true, PAST_AT[3]!, null) }];
    for (const zone of ['UTC', 'America/New_York', 'Australia/Lord_Howe']) {
      expect((await sqlStates(rows, NOW, zone)).get(0)).toBe('reboot_overdue');
    }
  });

  runDb('a policy row whose refresh_after has passed still yields a state', async () => {
    // The occurrence below has rolled over: its values are an earlier month's, and
    // the rule still classifies them rather than failing on them.
    const stale: Row = {
      idx: 0,
      ...NO_STATUS,
      applicability: 'applicable',
      last_outcome: 'success',
      status_occurrence_key: '2026-09',
      attempts: 1,
      last_success_at: iso(new Date(NOW.getTime() - 40 * DAY)),
      link_enabled: true,
      reboot_mode: 'overnight',
      occurrence_key: '2026-09',
      last_night_start: iso(new Date(NOW.getTime() - 40 * DAY)),
      past_last_night_at: iso(new Date(NOW.getTime() - 39 * DAY)),
      managed_since: iso(new Date(NOW.getTime() - 400 * DAY)),
    };
    const state = (await sqlStates([stale], NOW, 'UTC')).get(0);
    expect(state).toBe(expected(stale));
    expect(state).toBe('up_to_date');
  });
});
