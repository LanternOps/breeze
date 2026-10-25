// Alerts page hash grammar (spec 2026-10-18 §3.2.1):
//
//   #status=active&severity=critical,high[&hideAiNoise=1]
//
// The alerts page has no tab token, so every segment is a `key=value` filter.
// Built on the shared parser/writer in lib/hashParams.ts. Writers preserve
// keys they don't own; parsers ignore unknown keys and invalid values.
import { parseHashGrammar, writeHashKeys } from '../../lib/hashParams';
import { severityOrder, type AlertSeverity, type AlertStatus } from './alertConfig';

const ALERT_STATUSES: readonly AlertStatus[] = ['active', 'acknowledged', 'resolved', 'suppressed', 'dismissed'];
const NO_TABS: readonly string[] = [];

export interface AlertsHashState {
  status: AlertStatus[];
  severity: AlertSeverity[];
  hideAiNoise: boolean;
}

export const EMPTY_ALERTS_HASH: AlertsHashState = { status: [], severity: [], hideAiNoise: false };

function pick<T extends string>(values: string[] | undefined, allowed: readonly T[]): T[] {
  return (values ?? []).filter((v): v is T => (allowed as readonly string[]).includes(v));
}

/**
 * The legacy writer emitted the bare token `#hideAiNoise`. Rewrite it to
 * `hideAiNoise=1` so the shared grammar helpers see it as a filter key.
 */
function normalizeLegacy(hash: string): string {
  const raw = hash.replace(/^#/, '');
  if (!raw) return '';
  return raw
    .split('&')
    .map((seg) => (seg === 'hideAiNoise' ? 'hideAiNoise=1' : seg))
    .join('&');
}

/** `hash` may carry the leading `#` or not (useHashState strips it). */
export function parseAlertsHash(hash: string): AlertsHashState {
  const { params } = parseHashGrammar(normalizeLegacy(hash), NO_TABS);
  return {
    status: pick(params.status, ALERT_STATUSES),
    severity: pick(params.severity, severityOrder),
    hideAiNoise: (params.hideAiNoise ?? []).includes('1'),
  };
}

/** Builds a standalone alerts hash (`#status=…&severity=…`), '' when empty. */
export function encodeAlertsHash(state: Partial<AlertsHashState>): string {
  return mergeAlertsHash('', state);
}

/**
 * Rewrite only the alerts-owned keys named in `patch` (an empty array / false
 * removes the key) and keep everything else in `currentHash` untouched.
 */
export function mergeAlertsHash(currentHash: string, patch: Partial<AlertsHashState>): string {
  const owned: Record<string, string[] | null> = {};
  if (patch.status !== undefined) owned.status = patch.status.length ? patch.status : null;
  if (patch.severity !== undefined) owned.severity = patch.severity.length ? patch.severity : null;
  if (patch.hideAiNoise !== undefined) owned.hideAiNoise = patch.hideAiNoise ? ['1'] : null;
  // Always normalise the legacy bare token so it is replaced, not duplicated.
  return writeHashKeys(normalizeLegacy(currentHash), owned, NO_TABS);
}
