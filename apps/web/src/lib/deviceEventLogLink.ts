/**
 * The device Event-log-tab link shape
 * (`/devices/:id#eventlog[/<source>]&from=<iso>&to=<iso>`), spec
 * 2026-10-18 §3.2.1 / §3.7. One chokepoint for the encoder and the parser so
 * the percent-encoding cannot drift between the Reliability panel (writer) and
 * the Event log tab (reader). Mirrors `deviceScriptsLink.ts`.
 *
 * `source` is a single exact event-log source (the API filters with `eq`);
 * `from`/`to` are ISO-8601 UTC instants naming the scoring window.
 */
import { parseHashGrammar, writeHashKeys } from './hashParams';

export interface EventLogFilter {
  source?: string;
  from: string;
  to: string;
}

const EVENTLOG_TAB = 'eventlog';

/** The bare tab fragment (no filter) — what clearing a linked filter writes. */
export const EVENTLOG_TAB_HASH = EVENTLOG_TAB;
const KNOWN_TABS = [EVENTLOG_TAB] as const;

/** Just the `eventlog[/<source>]&from=&to=` fragment (no leading `#`). */
export function deviceEventLogHash(filter: EventLogFilter): string {
  const head = filter.source
    ? `${EVENTLOG_TAB}/${encodeURIComponent(filter.source)}`
    : EVENTLOG_TAB;
  const hash = writeHashKeys(head, { from: [filter.from], to: [filter.to] }, KNOWN_TABS);
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

/** Full href to a device's Event log tab carrying the filter. */
export function deviceEventLogHref(deviceId: string, filter: EventLogFilter): string {
  return `/devices/${encodeURIComponent(deviceId)}#${deviceEventLogHash(filter)}`;
}

function validInstant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Parses the filter out of a hash (leading `#` optional). Returns undefined
 * for the bare tab, another tab, a missing/unparseable window or `from > to`
 * — the caller then shows the plain tab. Never throws.
 */
export function eventLogFilterFromHash(hash: string): EventLogFilter | undefined {
  const { tab, selection, params } = parseHashGrammar(hash, KNOWN_TABS);
  if (tab !== EVENTLOG_TAB) return undefined;
  const from = params.from?.[0];
  const to = params.to?.[0];
  const fromMs = validInstant(from);
  const toMs = validInstant(to);
  if (from === undefined || to === undefined || fromMs === undefined || toMs === undefined) {
    return undefined;
  }
  if (fromMs > toMs) return undefined;
  // `selection` is already percent-decoded exactly once by parseHashGrammar.
  return selection ? { source: selection, from, to } : { from, to };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The fault factors are scored over a 30-day bucket window ending at `computedAt`. */
const SCORING_WINDOW_DAYS = 30;

/**
 * The reliability scoring window, derived from fields the reliability payload
 * already carries (no API change): `to` = `computedAt` (the scorer's
 * windowEnd); `from` = the start of the UTC day 30 days earlier (the scorer
 * counts an inclusive span of UTC day buckets), clamped to the later of the
 * baseline marker and enrolment (the scorer's `windowFloor`). Returns null
 * when the window cannot be vouched for (unparseable `computedAt`, or an
 * empty/inverted window) so the caller renders text instead of a link.
 */
export function reliabilityScoringWindow(input: {
  computedAt: string;
  enrolledAt?: string | null;
  baselineAt?: string | null;
}): { from: string; to: string } | null {
  const end = Date.parse(input.computedAt);
  if (Number.isNaN(end)) return null;
  const startOfDay = Math.floor((end - SCORING_WINDOW_DAYS * DAY_MS) / DAY_MS) * DAY_MS;
  let start = startOfDay;
  for (const floor of [input.baselineAt, input.enrolledAt]) {
    const ms = floor ? Date.parse(floor) : Number.NaN;
    if (!Number.isNaN(ms) && ms > start) start = ms;
  }
  if (start > end) return null;
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}
