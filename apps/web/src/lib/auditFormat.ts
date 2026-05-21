// Map raw audit action codes (dotted, machine-shaped) to human-readable
// phrases. Falls back to a generic prettifier for unknown codes.

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

export function formatAuditAction(action: string | null | undefined): string {
  if (!action) return '';
  return ACTION_DISPLAY[action] ?? prettify(action);
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
