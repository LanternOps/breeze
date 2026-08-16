import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

// Routine agent telemetry + MCP plumbing actions that saturate the
// dashboard Recent Activity widget. Passed as a CSV `excludeActions=` query
// param to GET /audit-logs/logs so the API filters them server-side. The
// full Audit Log viewer does NOT use this list — it shows everything.
export const DEFAULT_DASHBOARD_EXCLUDE_ACTIONS: readonly string[] = [
  'agent.sessions.submit',
  'agent.security_status.submit',
  'agent.management_posture.submit',
  'agent.patches.submit',
  'agent.eventlogs.submit',
  'agent.reliability.submit',
  'agent.filesystem.threshold_scan.queued',
  'mcp.tools.list',
  'mcp.resources.list',
  'mcp.notifications.initialized',
  'mcp.initialize',
  'api.post.events.ws-ticket',
  'api.get.events.ws-ticket',
];

// Map raw audit action codes (dotted, machine-shaped) to human-readable
// phrases. Falls back to a generic prettifier for unknown codes.
//
// The catalog itself lives in the locale files under `admin:audit.actions`, so
// the Audit Trail reads in the operator's language rather than always English
// (issue #3432). This English copy is the LAST-RESORT fallback for callers that
// have no `t` available (and for the eager-loaded first render before a
// non-English bundle has landed); `useAuditActionFormatter` is what components
// should use.
//
// The locale nodes are read whole via `returnObjects` rather than looked up key
// by key: action codes contain dots, which i18next would otherwise treat as key
// separators, and a code that is both a leaf and a prefix of another code
// (`agent.command` vs `agent.command.result.submit`) cannot be expressed as a
// nested tree at all.
const ACTION_DISPLAY: Record<string, string> = {
  // Agent telemetry submissions (high volume)
  'agent.sessions.submit': 'Reported sessions',
  'agent.security_status.submit': 'Reported security status',
  'agent.management_posture.submit': 'Reported management posture',
  'agent.patches.submit': 'Reported patches',
  'agent.eventlogs.submit': 'Reported event logs',
  'agent.reliability.submit': 'Reported reliability',
  'agent.command.result.submit': 'Submitted command result',
  'agent.filesystem.threshold_scan.queued': 'Filesystem scan queued',
  'agent.enroll': 'Agent enrolled',

  // User/auth
  'user.login': 'Signed in',
  'user.logout': 'Signed out',
  'session_initiated': 'Session initiated',
  'session_offer_submitted': 'Session offer submitted',

  // Devices
  'device.wake_on_lan': 'Sent Wake-on-LAN',
  'device.create': 'Added device',
  'device.update': 'Updated device',
  'device.delete': 'Removed device',
  'device.archive': 'Archived device',

  // Orgs/sites
  'organization.create': 'Created organization',
  'organization.update': 'Updated organization',
  'organization.delete': 'Deleted organization',
  'site.create': 'Created site',
  'site.update': 'Updated site',
  'site.delete': 'Deleted site',

  // Alerts
  'alert.create': 'Raised alert',
  'alert.resolve': 'Resolved alert',
  'alert.acknowledge': 'Acknowledged alert',
  'alert.dismiss': 'Dismissed alert',

  // Enrollment
  'enrollment_key.create': 'Created enrollment key',
  'enrollment_key.revoke': 'Revoked enrollment key',

  // Partner
  'partner.settings.update': 'Updated partner settings',

  // AI / MCP
  'ai.message.send': 'Sent AI message',
  'ai.tool_approval.update': 'Updated AI tool approval',
  'mcp.initialize': 'MCP: initialize',
  'mcp.notifications.initialized': 'MCP: initialized notifications',
  'mcp.tools.list': 'MCP: list tools',
  'mcp.tools.call': 'MCP: call tool',
  'mcp.resources.list': 'MCP: list resources',

  // Remote sessions
  'terminal.session.summary': 'Terminal session summary',

  // Scripts / automation
  'script.run': 'Ran script',
  'script.create': 'Created script',
  'script.update': 'Updated script',
  'script.delete': 'Deleted script',
  'automation.create': 'Created automation',
  'automation.update': 'Updated automation',
  'automation.delete': 'Deleted automation',
};

// Generic prettifier for codes that aren't in the map.
// Examples:
//   "foo.bar_baz.update" -> "Foo bar baz update"
//   "api.post.events.ws-ticket" -> "Api post events ws-ticket"
function prettify(action: string): string {
  const cleaned = action
    .replace(/[._]/g, ' ')
    .trim()
    .toLowerCase();
  if (!cleaned) return action;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Render an audit action code for humans.
 *
 * `labels` is the translated catalog (see `useAuditActionFormatter`). When it
 * is omitted or does not cover the code, we fall back to the built-in English
 * catalog and finally to `prettify`. Unmapped codes therefore still render in
 * English under a non-English locale — acceptable, because the API emits many
 * hundreds of action codes and only the common ones are worth translating.
 */
export function formatAuditAction(
  action: string | null | undefined,
  labels?: Record<string, string>,
): string {
  if (!action) return '';
  return labels?.[action] ?? ACTION_DISPLAY[action] ?? prettify(action);
}

/**
 * Hook returning a locale-aware `formatAuditAction`. Prefer this in components
 * — calling the bare function leaves the action untranslated.
 */
export function useAuditActionFormatter(): (
  action: string | null | undefined,
) => string {
  const { t } = useTranslation('admin');

  const labels = useMemo(() => {
    const raw = t('audit.actions', { returnObjects: true }) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    // Guard against a malformed/partial bundle handing us non-string leaves.
    const entries = Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }, [t]);

  return useCallback(
    (action: string | null | undefined) => formatAuditAction(action, labels),
    [labels],
  );
}

// Keys we never want to show in the compact Details cell — they're internal
// plumbing, not human-relevant context.
const NOISY_DETAIL_KEYS = new Set<string>([
  'rawActorId',
  'checksum',
  'rawUserAgent',
  'fingerprint',
  'requestId',
  'traceId',
  'spanId',
  'correlationId',
]);

// Pretty-print the relevant subset of an audit details payload as a compact
// "key: value, key: value" string. Returns '' if nothing useful remains.
export function formatAuditDetails(details: unknown): string {
  if (details == null) return '';
  if (typeof details === 'string') {
    const trimmed = details.trim();
    if (!trimmed) return '';
    // Try to parse JSON strings; fall back to the raw string.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return formatAuditDetails(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (typeof details !== 'object') return String(details);
  if (Array.isArray(details)) {
    return details.length === 0 ? '' : `${details.length} items`;
  }

  const entries = Object.entries(details as Record<string, unknown>).filter(
    ([key, value]) => {
      if (NOISY_DETAIL_KEYS.has(key)) return false;
      if (value === null || value === undefined) return false;
      if (typeof value === 'string' && value.trim() === '') return false;
      return true;
    }
  );

  if (entries.length === 0) return '';

  return entries
    .map(([key, value]) => {
      const label = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase().trim();
      let rendered: string;
      if (value === null || value === undefined) {
        rendered = '';
      } else if (typeof value === 'object') {
        rendered = Array.isArray(value) ? `${value.length} items` : '{ ... }';
      } else {
        rendered = String(value);
      }
      return `${label}: ${rendered}`;
    })
    .join(', ');
}
