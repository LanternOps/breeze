import { z } from 'zod';

// ASCII-only and alphanumeric first: .NET Runtime is deliberately unsupported.
export const APPLICATION_EVENT_PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._$()-]*$/;
export const APPLICATION_EVENT_PROVIDER_NAME_PATTERN_SOURCE = APPLICATION_EVENT_PROVIDER_NAME_PATTERN.source;
export const MAX_POLICY_APPLICATION_PROVIDERS = 20;
export const MAX_APPLICATION_PROVIDER_NAME_LENGTH = 256;

export const applicationProvidersSchema = z.array(
  z.string().trim().min(1).max(MAX_APPLICATION_PROVIDER_NAME_LENGTH).regex(
    APPLICATION_EVENT_PROVIDER_NAME_PATTERN,
    'Start with a letter or digit; use only letters, digits, spaces, periods, underscores, dollar signs, parentheses, and hyphens.',
  ),
).transform((names) => {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}).refine((names) => names.length <= MAX_POLICY_APPLICATION_PROVIDERS, {
  message: `At most ${MAX_POLICY_APPLICATION_PROVIDERS} distinct Application providers are allowed.`,
}).default([]);

/**
 * Application-log providers whose Warning and Information events the Windows
 * agent collects by default (#8174). Policies can add providers. Others use
 * Error/Critical only, because shipping all Information events is too much
 * volume.
 *
 * Mirror of `applicationInfoProviderAllowlist` in
 * agent/internal/collectors/eventlogs_windows_application.go: the agent decides
 * what is collected, and this copy only drives the save-time warning. Keep the
 * two in sync (apps/api/src/services/eventLogProviderAllowlistParity.test.ts).
 */
export const APPLICATION_INFO_EVENT_PROVIDERS = ['MsiInstaller', 'APCPBEAgent'] as const;

/** Levels below error: collected only from built-in and policy-listed Application providers. */
const ALLOWLIST_ONLY_LEVELS = new Set(['info', 'warning']);

type EventLogConditionLike = {
  category?: unknown;
  level?: unknown;
  sourcePattern?: unknown;
};

/**
 * Why an event_log condition can never (or only partly) match: an info/warning
 * Application rule whose source is not a built-in or policy-listed provider (the agent does
 * not collect those events), or one that names no source at all (it only ever
 * sees listed providers' events at that level).
 *
 * "Matches a provider" mirrors the evaluator (alertConditions/handlers/
 * eventLog.ts), which filters source with ILIKE %pattern%: the pattern must be
 * a case-insensitive substring of a built-in or policy-listed provider name.
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
  policyProviders: readonly string[] = [],
): EventLogCollectionGap | null {
  if (!condition || typeof condition !== 'object') return null;
  if (condition.category !== 'application') return null;
  if (typeof condition.level !== 'string' || !ALLOWLIST_ONLY_LEVELS.has(condition.level)) return null;

  const pattern = typeof condition.sourcePattern === 'string' ? condition.sourcePattern.trim() : '';
  if (!pattern) return { reason: 'no_source' };

  const needle = pattern.toLowerCase();
  if ([...APPLICATION_INFO_EVENT_PROVIDERS, ...policyProviders].some((p) => p.toLowerCase().includes(needle))) return null;
  return { reason: 'source_not_collected', source: pattern };
}

/** English save-time warning for `eventLogCollectionGap`, or null when none applies. */
export function eventLogCollectionWarning(condition: EventLogConditionLike | null | undefined, policyProviders: readonly string[] = []): string | null {
  const gap = eventLogCollectionGap(condition, policyProviders);
  if (!gap) return null;
  const providers = APPLICATION_INFO_EVENT_PROVIDERS.join(', ') +
    (policyProviders.length ? `, plus providers listed in Event Logs configuration policies: ${policyProviders.join(', ')}` : '');
  const guidance = ' Add a provider under Configuration policy → Event Logs → Application providers.';
  if (gap.reason === 'no_source') {
    return (
      `Information and Warning Application events are collected only from these providers: ${providers}. ` +
      'Events from other sources match this rule only at Error or Critical level.' + guidance
    );
  }
  return (
    `The agent does not collect Information or Warning Application events from "${gap.source}", ` +
    'so this rule will only match its Error or Critical events. ' +
    `Information and Warning events are collected only from: ${providers}.` + guidance
  );
}

/**
 * Save-time warnings for a monitor definition: the event_log condition itself,
 * or each event_log child of a composite. Malformed input yields no warnings
 * (schema validation reports those).
 */
export function monitorEventLogCollectionWarnings(kind: unknown, condition: unknown, policyProviders: readonly string[] = []): string[] {
  if (kind === 'event_log') {
    const w = eventLogCollectionWarning(condition as EventLogConditionLike | null, policyProviders);
    return w ? [w] : [];
  }
  if (kind !== 'composite' || !condition || typeof condition !== 'object') return [];
  const children = (condition as { children?: unknown }).children;
  if (!Array.isArray(children)) return [];
  const warnings: string[] = [];
  for (const child of children) {
    const c = child as { kind?: unknown; condition?: unknown } | null;
    if (c?.kind !== 'event_log') continue;
    const w = eventLogCollectionWarning(c.condition as EventLogConditionLike | null, policyProviders);
    if (w) warnings.push(w);
  }
  return warnings;
}
