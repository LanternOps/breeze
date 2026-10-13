/**
 * Application-log providers whose Warning and Information events the Windows
 * agent collects (#8174). Every other Application provider is collected at
 * Error/Critical only, because shipping all Information events is too much
 * volume.
 *
 * Mirror of `applicationInfoProviderAllowlist` in
 * agent/internal/collectors/eventlogs_windows_application.go: the agent decides
 * what is collected, and this copy only drives the save-time warning. Keep the
 * two in sync (apps/api/src/services/eventLogProviderAllowlistParity.test.ts).
 */
export const APPLICATION_INFO_EVENT_PROVIDERS = ['MsiInstaller'] as const;

/** Levels below error: collected for Application only from the allowlist above. */
const ALLOWLIST_ONLY_LEVELS = new Set(['info', 'warning']);

type EventLogConditionLike = {
  category?: unknown;
  level?: unknown;
  sourcePattern?: unknown;
};

/**
 * Why an event_log condition can never (or only partly) match: an info/warning
 * Application rule whose source is not an allowlisted provider (the agent does
 * not collect those events), or one that names no source at all (it only ever
 * sees allowlisted providers' events at that level).
 *
 * "Matches a provider" mirrors the evaluator (alertConditions/handlers/
 * eventLog.ts), which filters source with ILIKE %pattern%: the pattern must be
 * a case-insensitive substring of an allowlisted provider name.
 *
 * Structured so the web editor can render a localized message; the API uses
 * `eventLogCollectionWarning` for English text. Advisory only: the rule is
 * saved the same way either way.
 */
export type EventLogCollectionGap =
  | { reason: 'no_source' }
  | { reason: 'source_not_collected'; source: string };

export function eventLogCollectionGap(
  condition: EventLogConditionLike | null | undefined,
): EventLogCollectionGap | null {
  if (!condition || typeof condition !== 'object') return null;
  if (condition.category !== 'application') return null;
  if (typeof condition.level !== 'string' || !ALLOWLIST_ONLY_LEVELS.has(condition.level)) return null;

  const pattern = typeof condition.sourcePattern === 'string' ? condition.sourcePattern.trim() : '';
  if (!pattern) return { reason: 'no_source' };

  const needle = pattern.toLowerCase();
  if (APPLICATION_INFO_EVENT_PROVIDERS.some((p) => p.toLowerCase().includes(needle))) return null;
  return { reason: 'source_not_collected', source: pattern };
}

/** English save-time warning for `eventLogCollectionGap`, or null when none applies. */
export function eventLogCollectionWarning(condition: EventLogConditionLike | null | undefined): string | null {
  const gap = eventLogCollectionGap(condition);
  if (!gap) return null;
  const providers = APPLICATION_INFO_EVENT_PROVIDERS.join(', ');
  if (gap.reason === 'no_source') {
    return (
      `Information and Warning Application events are collected only from these providers: ${providers}. ` +
      'Events from other sources match this rule only at Error or Critical level.'
    );
  }
  return (
    `The agent does not collect Information or Warning Application events from "${gap.source}", ` +
    'so this rule will only match its Error or Critical events. ' +
    `Information and Warning events are collected only from: ${providers}.`
  );
}

/**
 * Save-time warnings for a monitor definition: the event_log condition itself,
 * or each event_log child of a composite. Malformed input yields no warnings
 * (schema validation reports those).
 */
export function monitorEventLogCollectionWarnings(kind: unknown, condition: unknown): string[] {
  if (kind === 'event_log') {
    const w = eventLogCollectionWarning(condition as EventLogConditionLike | null);
    return w ? [w] : [];
  }
  if (kind !== 'composite' || !condition || typeof condition !== 'object') return [];
  const children = (condition as { children?: unknown }).children;
  if (!Array.isArray(children)) return [];
  const warnings: string[] = [];
  for (const child of children) {
    const c = child as { kind?: unknown; condition?: unknown } | null;
    if (c?.kind !== 'event_log') continue;
    const w = eventLogCollectionWarning(c.condition as EventLogConditionLike | null);
    if (w) warnings.push(w);
  }
  return warnings;
}
