/**
 * The device Event-log-tab link shape, spec 2026-10-18 §3.2.1 / §3.7:
 *
 *   /devices/:id#eventlog[/<source>]&from=<iso>&to=<iso>          one source
 *   /devices/:id#eventlog&source=<a>,<b>…&from=<iso>&to=<iso>     several (#10053)
 *
 * One chokepoint for the encoder and the parser so the percent-encoding cannot
 * drift between the Reliability panel (writer) and the Event log tab (reader).
 * Mirrors `deviceScriptsLink.ts`.
 *
 * `sources` are exact event-log sources (the API matches any of them);
 * `from`/`to` are ISO-8601 UTC instants naming the scoring window. The window
 * itself comes from the reliability API (per factor), not from this module.
 */
import { parseHashGrammar, writeHashKeys } from './hashParams';

export interface EventLogFilter {
  /** Absent for a window-only link; never empty when present. */
  sources?: string[];
  from: string;
  to: string;
}

const EVENTLOG_TAB = 'eventlog';

/** The API's cap on repeated `source` values (routes/devices/eventlogs.ts). */
export const MAX_EVENT_LOG_LINK_SOURCES = 25;

/** The bare tab fragment (no filter) — what clearing a linked filter writes. */
export const EVENTLOG_TAB_HASH = EVENTLOG_TAB;
const KNOWN_TABS = [EVENTLOG_TAB] as const;

/** Just the `eventlog…&from=&to=` fragment (no leading `#`). */
export function deviceEventLogHash(filter: EventLogFilter): string {
  const sources = [...new Set(filter.sources ?? [])];
  // One source keeps the original `eventlog/<source>` shape, so links written
  // before multi-source support still parse to the same filter.
  const head = sources.length === 1
    ? `${EVENTLOG_TAB}/${encodeURIComponent(sources[0]!)}`
    : EVENTLOG_TAB;
  const hash = writeHashKeys(
    head,
    { source: sources.length > 1 ? sources : null, from: [filter.from], to: [filter.to] },
    KNOWN_TABS,
  );
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
  // `selection` and each `source` value are already percent-decoded exactly
  // once by parseHashGrammar.
  const sources = [...new Set([...(selection ? [selection] : []), ...(params.source ?? [])])];
  // More sources than the API filter accepts can only come from a hand-edited
  // link; treat it like any other invalid link (plain tab) rather than send a
  // request that is refused.
  if (sources.length > MAX_EVENT_LOG_LINK_SOURCES) return undefined;
  return sources.length > 0 ? { sources, from, to } : { from, to };
}
