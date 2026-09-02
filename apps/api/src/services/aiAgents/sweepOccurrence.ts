/**
 * Occurrence math for the fixed-tick sweeper (Phase 2 wave P2-2, task 9).
 *
 * Pure: no DB, no ambient clock, no imports beyond `isCronDue`
 * (`services/cronDue.ts`) and `wallClockIn` (`@breeze/shared`).
 *
 * ## Why a "latest occurrence" instead of "is it due right now?"
 *
 * The sweeper runs on a FIXED 5-minute tick, not on a per-schedule BullMQ
 * repeatable. A tick that asked `isCronDue(cron, tz, now)` would fire a
 * `0 6 * * *` schedule only if a tick happened to land on the exact minute
 * 06:00 — a missed, delayed or drifted tick would silently drop the whole
 * day's sweep, and nothing anywhere would record that it had. So the tick
 * asks the opposite question: "what is the most recent minute this cron was
 * due at, at or before now?" and then dedupes on the ANSWER
 * (`ai_agent_schedules.last_occurrence_key`) rather than on the tick's own
 * timing. Any tick inside the lookback window recovers the occurrence; a
 * second tick inside the same window recomputes the same key and skips.
 *
 * The trade is deliberate and bounded: the sweeper is LATEST-ONLY. If a
 * process is down across two occurrences of an hourly schedule, the older one
 * is never run — a hygiene sweep is a snapshot of current fleet state, so
 * replaying a stale occurrence would produce findings about a fleet that no
 * longer exists. `SWEEP_OCCURRENCE_LOOKBACK_MINUTES` (24 h) is how far back a
 * recovery may reach.
 *
 * ## The key is WALL CLOCK, and that is the whole DST story
 *
 * `occurrenceKey` is `YYYY-MM-DDTHH:mm@<tz>` read off the LOCAL clock, not a
 * UTC instant. Two consequences, both intended:
 *
 *  - **Fall back (clocks repeat an hour).** Europe/Berlin, 2026-10-25: local
 *    02:30 happens TWICE — at 00:30Z (CEST) and again at 01:30Z (CET). Both
 *    instants produce the key `2026-10-25T02:30@Europe/Berlin`, so the first
 *    tick to see either one enqueues, and every later tick in that repeated
 *    hour computes the same key and skips. A UTC-instant key would have run
 *    the org's nightly sweep twice — double findings, double LLM spend,
 *    double intents.
 *
 *  - **Spring forward (clocks skip an hour).** Europe/Berlin, 2026-03-29:
 *    local 02:00 becomes 03:00, so local 02:30 NEVER OCCURS. A `30 2 * * *`
 *    schedule therefore has no occurrence that day, `latestCronOccurrence`
 *    walks the whole lookback without a match, and returns `null` — the sweep
 *    is SKIPPED for that day, not silently re-pointed at some nearby minute.
 *    That is the conservative choice: the alternative (snap to the next
 *    existing local minute) would fire an occurrence whose key does not
 *    correspond to any minute the operator configured, and would fire it at a
 *    time nobody scheduled. With the default 24 h lookback the previous day's
 *    02:30 (2026-03-28T01:30Z) sits 30.5 h behind a 2026-03-29T08:00Z tick and
 *    is likewise out of reach, so the day is simply missed — once a year, for
 *    schedules whose local time falls inside the skipped hour. Documented,
 *    tested (`sweepOccurrence.test.ts`), and cheap: the next day's occurrence
 *    runs normally.
 *
 * `isCronDue` is itself zone-aware (it decomposes the instant with
 * `Intl.DateTimeFormat` in the target zone), so a non-existent local minute is
 * never produced by the walk in the first place — the walk simply never sees a
 * matching minute. Nothing here has to detect a DST transition explicitly.
 */
import { wallClockIn } from '@breeze/shared';

import { isCronDue } from '../cronDue';

const MINUTE_MS = 60_000;

/**
 * How far back a tick may reach for an occurrence it has not yet run. 24 h
 * covers a long outage for a daily schedule without ever replaying yesterday's
 * fleet state as if it were today's.
 */
export const SWEEP_OCCURRENCE_LOOKBACK_MINUTES = 24 * 60;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/**
 * The sweeper's idempotency key for one cron firing: the LOCAL wall clock in
 * the schedule's own zone, plus the zone itself.
 *
 * The zone is part of the key on purpose — two schedules that happen to fire
 * at the same local time in different zones are different occurrences, and a
 * partner that RE-ZONES a schedule must get a fresh occurrence rather than
 * matching a key produced under the old zone.
 */
export function occurrenceKey(at: Date, timeZone: string): string {
  const wall = wallClockIn(at, timeZone);
  return `${wall.y}-${pad(wall.m, 2)}-${pad(wall.d, 2)}T${pad(wall.hh, 2)}:${pad(wall.mm, 2)}@${timeZone}`;
}

/**
 * The most recent minute at or before `now` at which `cron` was due in
 * `timeZone`, or `null` when there is none inside `lookbackMinutes`.
 *
 * Walks back one minute at a time from `floor(now)`. Minute granularity is
 * exactly `isCronDue`'s own resolution (it has no seconds field — a 6-field
 * pattern is rejected there and therefore never matches here either), so the
 * walk cannot step over a due minute. Worst case is `lookbackMinutes`
 * evaluations for a schedule that has no occurrence in the window; a schedule
 * that fires daily or more often matches within its own period, which for
 * every supported cadence is far inside the window.
 */
export function latestCronOccurrence(
  cron: string,
  timeZone: string,
  now: Date,
  lookbackMinutes: number = SWEEP_OCCURRENCE_LOOKBACK_MINUTES,
): { at: Date; key: string } | null {
  const flooredMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  // `<=` so the current minute itself is a candidate: a tick landing exactly
  // on the occurrence must not have to wait for the next one.
  for (let back = 0; back <= lookbackMinutes; back++) {
    const at = new Date(flooredMs - back * MINUTE_MS);
    if (isCronDue(cron, timeZone, at)) {
      return { at, key: occurrenceKey(at, timeZone) };
    }
  }
  return null;
}
