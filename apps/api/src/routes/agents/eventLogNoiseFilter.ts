/**
 * Windows Security event-log noise filter (#11735).
 *
 * Agent v0.126.0 (#10702) widened the Windows Security query to every "Audit
 * Failure" record. A handful of operational IDs then made up most of
 * device_event_logs growth: ~100x the previous Security volume, with no MSP
 * value at that rate. Newer agents query an explicit allowlist instead
 * (agent/internal/collectors/eventlogs_winquery.go, securityAuditEventIDs);
 * this filter stops agents already deployed from filling the table.
 *
 * It is a denylist, not a mirror of the agent allowlist, so a newer agent can
 * add a security-relevant ID without an API release. Extend it only with IDs
 * seen at volume in production. Never add 4625 (failed logon) or 4719 (system
 * audit policy changed): those are the signal the Security stream exists for.
 */

/** Provider of every Windows Security audit record. */
export const WINDOWS_SECURITY_AUDITING_PROVIDER = 'Microsoft-Windows-Security-Auditing';

/** Event IDs dropped at ingest, each with the reason it is noise. */
export const WINDOWS_SECURITY_NOISE_EVENT_IDS: ReadonlyMap<number, string> = new Map([
  [5038, 'code integrity: image hash invalid (fires per unsigned/mismatched image load)'],
  [5157, 'Windows Filtering Platform blocked a connection'],
  [5152, 'Windows Filtering Platform blocked a packet'],
  [4957, 'Windows Firewall did not apply a rule (per rule, per policy refresh)'],
  [5061, 'cryptographic operation (per CNG key operation)'],
]);

interface EventLogLike {
  category: string;
  source: string;
  eventId?: string;
  details?: Record<string, unknown>;
}

const PROVIDER_LOWER = WINDOWS_SECURITY_AUDITING_PROVIDER.toLowerCase();

// The Windows agent sends eventId as "<windows id>:<record id>"; Linux/macOS
// ids start with a non-numeric source name, so they never match.
const WINDOWS_EVENT_ID_PREFIX = /^(\d{1,5})(?::|$)/;

// Both ids are agent-supplied. When they disagree the record is ambiguous and
// is kept: a failed logon must never be dropped because one id says 5157.
function windowsEventId(event: EventLogLike): number | null {
  const raw = event.details?.eventId;
  const fromDetails = typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
  const match = event.eventId ? WINDOWS_EVENT_ID_PREFIX.exec(event.eventId) : null;
  const fromPrefix = match ? Number(match[1]) : null;
  if (fromDetails !== null && fromPrefix !== null && fromDetails !== fromPrefix) return null;
  return fromDetails ?? fromPrefix;
}

/**
 * Returns the noise event ID when the event is a Windows Security-log audit
 * record on the noise list, otherwise null. Applies only to the agent's
 * Security stream: category `security`, the Security-Auditing provider, and
 * (when the agent reports it) the `Security` log. Other logs and providers
 * that reuse the same numeric IDs are never dropped.
 */
export function windowsSecurityNoiseEventId(event: EventLogLike): number | null {
  if (event.category !== 'security') return null;
  if (event.source.toLowerCase() !== PROVIDER_LOWER) return null;
  const logName = event.details?.logName;
  if (logName !== undefined && (typeof logName !== 'string' || logName.toLowerCase() !== 'security')) {
    return null;
  }
  const id = windowsEventId(event);
  return id !== null && WINDOWS_SECURITY_NOISE_EVENT_IDS.has(id) ? id : null;
}
