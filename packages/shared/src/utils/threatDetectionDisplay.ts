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
import type { ThreatDetectionSummary } from '../types/threatDetectionReport';

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

/** `CRITICAL - `, `LOW: ` and the like, which repeat the Severity column. */
const SEVERITY_PREFIX = /^\s*(critical|high|medium|low|info(?:rmational)?)\s*[-–—:|]\s*/i;
/** Deliberately loose: any address-shaped token is replaced, not validated. */
const EMAIL = /[^\s()<>@,;:"[\]]+@[^\s()<>@,;:"[\]]+\.[a-z]{2,}/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A vendor detection subject rewritten for the client: the leading severity
 * (already its own column) and a trailing `(Org name)` (the whole report is
 * about that org) are dropped, and an email address — identity incidents carry
 * the user's sign-in name — becomes "a user account".
 */
export function clientDetectionTitle(title: string | null | undefined, orgName?: string | null): string {
  let text = (title ?? '').trim().replace(SEVERITY_PREFIX, '');
  const org = orgName?.trim();
  if (org) {
    text = text.replace(new RegExp(`\\s*\\(\\s*${escapeRegExp(org)}\\s*\\)\\s*$`, 'i'), '');
  }
  text = text.replace(EMAIL, 'a user account').replace(/\s+/g, ' ').trim();
  return text || 'Detection';
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
 * any-source device counts directly. A legacy snapshot (before #12046) carried
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
