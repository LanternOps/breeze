/**
 * Client-language wording for the Threat Detection Review (#12046), shared by
 * the PDF renderer and the web preview so the two cannot word the same
 * snapshot differently.
 *
 * The reader is the customer's office manager. Nothing here may pass a raw
 * integration token through ("sent", "in_progress", a vendor's
 * "LOW - Incident on HOST (Org)" subject line), and nothing here may turn an
 * unmeasured count into a zero — see threatDetection.ts for that rule.
 */
import type { ThreatDetectionSummary, ThreatSourceStatus } from '../types/threatDetectionReport';

const UNKNOWN = 'Unknown';

/**
 * Stored incident status → the word printed for the client. Huntress sends
 * `sent` for an incident report it has delivered and nobody has closed; the
 * client normalizer keeps unrecognised values verbatim, so `sent` reaches the
 * snapshot as-is. It means "open".
 */
const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  new: 'Open',
  sent: 'Open',
  in_progress: 'Being investigated',
  investigating: 'Being investigated',
  auto_remediating: 'Being remediated',
  remediating: 'Being remediated',
  resolved: 'Resolved',
  closed: 'Resolved',
  dismissed: 'Dismissed',
  unknown: UNKNOWN,
};

function humanize(token: string): string {
  const words = token.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : UNKNOWN;
}

export function threatStatusLabel(status: string | null | undefined): string {
  const key = (status ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!key) return UNKNOWN;
  return STATUS_LABELS[key] ?? humanize(key);
}

export function threatSeverityLabel(severity: string | null | undefined): string {
  const value = (severity ?? '').trim();
  return value ? humanize(value) : UNKNOWN;
}

/**
 * `CRITICAL - `, `LOW: ` and the like, which repeat the Severity column. A
 * dash or bar must have whitespace BEFORE it, so a title that merely starts
 * with a hyphenated word ("High-risk sign-in", "Info-stealer") is untouched.
 */
const SEVERITY_PREFIX = /^\s*(?:critical|high|medium|low|info(?:rmational)?)(?:\s+[-–—|]|\s*:)(?:\s+|$)/i;
/** Deliberately loose: any address-shaped token is replaced, not validated. */
const EMAIL = /[^\s()<>@,;:"[\]]+@[^\s()<>@,;:"[\]]+\.[a-z]{2,}/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Length caps applied BEFORE the address scrub. The address pattern retries
 * from every start position, so its cost grows with the square of a long
 * unbroken token: an uncapped 200 000-character title took over 20 seconds.
 * Both caps sit well above what a table cell shows.
 */
const MAX_TITLE_CHARS = 300;
const MAX_ADVICE_CHARS = 1000;
const ELLIPSIS = '...';

/**
 * Cuts `text` to at most `max` characters, plus an ellipsis. When the cut
 * falls inside a word, that whole word is dropped as well: a cut through an
 * address would leave "jane.doe@exam", which the scrub no longer recognises
 * as an address, and it would be printed. When nothing survives (the first
 * `max` characters are one word) the result is empty, not a bare ellipsis, so
 * the caller's own fallback applies.
 */
function capLength(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  if (!/\s/.test(text.charAt(max))) {
    while (end > 0 && !/\s/.test(text.charAt(end - 1))) end -= 1;
  }
  const kept = text.slice(0, end).trimEnd();
  return kept ? `${kept}${ELLIPSIS}` : '';
}

/** Every address-shaped token becomes "a user account". */
function scrubEmails(text: string): string {
  return text.replace(EMAIL, 'a user account');
}

/**
 * A vendor detection subject rewritten for the client: the leading severity
 * (already its own column) and a trailing `(Org name)` (the whole report is
 * about that org) are dropped, and an email address — identity incidents carry
 * the user's sign-in name — becomes "a user account". A very long subject is
 * cut (MAX_TITLE_CHARS) after the org suffix is dropped and before the scrub.
 * Whitespace is collapsed first, which keeps the suffix pattern linear.
 */
export function clientDetectionTitle(title: string | null | undefined, orgName?: string | null): string {
  let text = (title ?? '').replace(/\s+/g, ' ').trim();
  const org = orgName?.trim();
  if (org) {
    text = text.replace(new RegExp(`\\s*\\(\\s*${escapeRegExp(org)}\\s*\\)\\s*$`, 'i'), '');
  }
  text = capLength(text, MAX_TITLE_CHARS).replace(SEVERITY_PREFIX, '');
  text = scrubEmails(text).replace(/\s+/g, ' ').trim();
  return text || 'Detection';
}

/**
 * The vendor's advice for a detection (the "What we advised" column), with the
 * same address scrub as the title: identity advice names the account to reset.
 * Absent advice is an empty string, so the cell stays blank.
 */
export function clientDetectionAdvice(advice: string | null | undefined): string {
  const text = capLength((advice ?? '').trim(), MAX_ADVICE_CHARS);
  return scrubEmails(text).replace(/\s+/g, ' ').trim();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days an unresolved detection has been open at `asOf`, or null when
 *  either instant is missing — never a guessed age. Clock skew clamps to 0. */
export function openForDays(reportedAt: string | null | undefined, asOf: string | null | undefined): number | null {
  if (!reportedAt || !asOf) return null;
  const from = Date.parse(reportedAt);
  const to = Date.parse(asOf);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

export type EndpointCoverageCounts = {
  /** Devices Breeze manages (site-scoped). */
  managed: number | null;
  /** Managed devices with at least one detection agent. */
  withAgent: number | null;
  /** Managed devices with none. `withAgent + withoutAgent === managed`. */
  withoutAgent: number | null;
  /** Detection-service agents reported for the org, matched or not. */
  agentsReported: number | null;
  /** Of those, the ones not matched to a managed device. Null on a legacy
   *  snapshot: two agents can share one device, so it cannot be derived. */
  unmatchedAgents: number | null;
};

const num = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The endpoint-coverage tiles, reconciled. A current snapshot carries the
 * device counts directly: from every source, or, on a data-gap path, from
 * SentinelOne and EDR alone (`deviceCountSourcesNote` says which). A legacy
 * snapshot (before #12046) carried
 * only "managed devices with no Huntress agent", so its pair is derived from
 * that — Huntress-only, but it still adds up to the managed count.
 */
export function endpointCoverageCounts(
  agents: ThreatDetectionSummary['agentCoverage'] | null | undefined,
): EndpointCoverageCounts {
  const managed = num(agents?.breezeDevices);
  const agentsReported = num(agents?.huntressAgents);
  const current = num(agents?.devicesWithDetectionAgent);
  if (current !== null) {
    return {
      managed,
      withAgent: current,
      withoutAgent: num(agents?.devicesWithoutDetectionAgent)
        ?? (managed !== null ? Math.max(0, managed - current) : null),
      agentsReported,
      unmatchedAgents: num(agents?.unmatchedAgents),
    };
  }
  const legacyWithout = num(agents?.devicesWithoutAgent);
  return {
    managed,
    withAgent: managed !== null && legacyWithout !== null ? Math.max(0, managed - legacyWithout) : null,
    withoutAgent: legacyWithout,
    agentsReported,
    unmatchedAgents: null,
  };
}

/**
 * The sentence owed beside the device tiles when they were NOT counted from
 * Huntress (#12046 follow-up): Huntress was unmeasured, so a device protected
 * only by Huntress reads as having no agent. Null when Huntress was counted
 * (the usual case) or the snapshot predates `detectionAgentSources`. Shared by
 * the PDF and the web preview so the two say the same thing. The EDR vendor is
 * never named: it is "managed endpoint protection" everywhere in the artifact.
 */
export function deviceCountSourcesNote(
  agents: ThreatDetectionSummary['agentCoverage'] | null | undefined,
  sourceStatus: ThreatSourceStatus | null | undefined,
): string | null {
  const sources = agents?.detectionAgentSources;
  if (!Array.isArray(sources) || sources.length === 0 || sources.includes('huntress')) return null;
  if (endpointCoverageCounts(agents).withAgent === null) return null;
  const words = [
    ...(sources.includes('sentinelone') ? ['SentinelOne'] : []),
    ...(sources.includes('edr') ? ['managed endpoint protection'] : []),
  ];
  if (words.length === 0) return null;
  const why = sourceStatus === 'never_synced' ? 'Huntress has not completed a sync' : 'Huntress is not connected';
  return `These device counts include ${words.join(' and ')} agents only, because ${why}.`;
}
