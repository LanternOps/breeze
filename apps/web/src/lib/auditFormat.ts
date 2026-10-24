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
  // Template for `agent.command.<type>` (one code per audited command type);
  // `{command}` is the friendly command name - see `formatAgentCommandAction`.
  'agent.command.*': 'Queued command: {command}',
  'agent.filesystem.threshold_scan.queued': 'Filesystem scan queued',
  'agent.enroll': 'Agent enrolled',

  // User/auth
  'user.login': 'Signed in',
  'user.logout': 'Signed out',
  'session_initiated': 'Session initiated',
  'session_offer_submitted': 'Session offer submitted',
  'session_consent_granted': 'Remote session consent granted',
  'session_consent_denied': 'Remote session declined by user',
  'session_consent_blocked_unanswered': 'Remote session blocked: consent prompt not answered',
  'session_consent_blocked_unavailable': 'Remote session blocked: consent prompt unavailable',
  'session_consent_bypassed': 'Remote session started without an answer to the consent prompt',
  'screen_access_consent_blocked': 'Screen access blocked: device requires user consent',

  // Devices
  'device.wake_on_lan': 'Sent Wake-on-LAN',
  'device.create': 'Added device',
  'device.update': 'Updated device',
  'device.delete': 'Removed device',
  'device.archive': 'Archived device',

  // Recovery keys
  'device.recovery_key.reveal': 'Revealed a recovery key',
  'device.recovery_key.rotate': 'Rotated a recovery key',

  // Orgs/sites
  'organization.create': 'Created organization',
  'organization.update': 'Updated organization',
  'organization.delete': 'Deleted organization',
  'site.create': 'Created site',
  'site.update': 'Updated site',
  'site.delete': 'Deleted site',

  // Scripts run on a device (#9672)
  'script.execute': 'Ran script on device',

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
  // Template for the per-tool rows (`ai.tool.<toolName>`, #9534); `{tool}` is
  // the humanized tool name — see `formatAiToolAction`. `*` keeps the key from
  // ever colliding with a real tool name.
  'ai.tool.*': 'AI tool: {tool}',
  'ai.session.create': 'Started AI chat',
  'ai.session.close': 'Closed AI chat',
  'ai.session.flag': 'Flagged AI chat',
  'ai.session.unflag': 'Unflagged AI chat',
  'ai.message.interrupt': 'Stopped AI response',
  'ai.command.executed': 'AI ran a command',
  'ai.script.executed': 'AI ran a script',
  'ai.external_tool.call': 'AI called an external tool',
  'ai.plan_approval.update': 'Updated AI plan approval',
  'ai.plan.abort': 'Aborted AI plan',
  'ai.security.prompt_injection_detected': 'AI: prompt injection detected',
  'ai.budget.update': 'Updated AI budget',
  'mcp.initialize': 'MCP: initialize',
  'mcp.notifications.initialized': 'MCP: initialized notifications',
  'mcp.tools.list': 'MCP: list tools',
  'mcp.tools.call': 'MCP: call tool',
  'mcp.resources.list': 'MCP: list resources',

  // Backup restores (#9630)
  'backup.restore.create': 'Started a restore',
  'backup.restore.cancel': 'Cancelled a restore',
  'backup.restore.unattested_override': 'Confirmed restore of an unverified snapshot',

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

  // Verb templates for catch-all HTTP audit rows (`api.<verb>.<path>`, #3991).
  // `{target}` is the path with ids stripped - see `formatFallbackAction`.
  'api.fallback.post': 'Submitted {target}',
  'api.fallback.put': 'Updated {target}',
  'api.fallback.patch': 'Updated {target}',
  'api.fallback.delete': 'Deleted {target}',
};

// The API's catch-all audit middleware names rows `api.<verb>.<seg>.<seg>`
// (see buildFallbackAction in apps/api/src/index.ts), with `:id` / `:n`
// standing in for UUIDs and numeric ids. Render those as an operation instead
// of leaking the HTTP verb and the route template.
const FALLBACK_ACTION_RE = /^api\.(post|put|patch|delete)\.(.+)$/;

function formatFallbackAction(
  action: string,
  labels?: Record<string, string>,
): string | null {
  const match = FALLBACK_ACTION_RE.exec(action);
  if (!match) return null;
  const [, verb, path] = match;
  const target = path
    .split('.')
    .filter((seg) => seg && seg !== ':id' && seg !== ':n')
    .map((seg) => seg.replace(/[-_]/g, ' '))
    .join(' \u203a ');
  const template = labels?.[`api.fallback.${verb}`] ?? ACTION_DISPLAY[`api.fallback.${verb}`];
  if (!target || !template) return null;
  return template.replace('{target}', target);
}

// Every AI tool call is audited as `ai.tool.<toolName>` (aiAgentSdk.ts), one
// code per tool — far too many to catalog. Render it as "AI tool: <Tool name>"
// rather than prettifying it to "Ai tool remediate vulnerability" (#9534).
const AI_TOOL_ACTION_RE = /^ai\.tool\.(.+)$/;

function formatAiToolAction(
  action: string,
  labels?: Record<string, string>,
): string | null {
  const match = AI_TOOL_ACTION_RE.exec(action);
  if (!match) return null;
  // A namespaced MCP id (`mcp__<server>__<tool>`) shows only the tool.
  const words = match[1].replace(/^mcp__.+?__/, '').replace(/[_.]+/g, ' ').trim();
  const template = labels?.['ai.tool.*'] ?? ACTION_DISPLAY['ai.tool.*'];
  if (!words || !template) return null;
  return template.replace('{tool}', words.charAt(0).toUpperCase() + words.slice(1));
}

// Every audited command queued to an agent is logged as `agent.command.<type>`
// (commandQueue.ts AUDITED_COMMANDS). Friendly names for those types; an
// unlisted type still renders readably by humanizing the type, so a new
// command type needs no edit here to be legible (#9630).
const AGENT_COMMAND_NAMES: Readonly<Record<string, string>> = {
  kill_process: 'Kill process',
  start_service: 'Start service',
  stop_service: 'Stop service',
  restart_service: 'Restart service',
  task_run: 'Run scheduled task',
  task_enable: 'Enable scheduled task',
  task_disable: 'Disable scheduled task',
  registry_set: 'Set registry value',
  registry_delete: 'Delete registry value',
  registry_key_create: 'Create registry key',
  registry_key_delete: 'Delete registry key',
  file_write: 'Write file',
  file_delete: 'Delete file',
  file_mkdir: 'Create folder',
  file_rename: 'Rename file',
  file_copy: 'Copy file',
  file_trash_restore: 'Restore file from trash',
  file_trash_purge: 'Purge trash',
  terminal_start: 'Start terminal',
  script: 'Run script',
  script_cancel: 'Cancel script',
  patch_scan: 'Scan for patches',
  install_patches: 'Install patches',
  rollback_patches: 'Roll back patches',
  software_install: 'Install software',
  software_uninstall: 'Uninstall software',
  software_update: 'Update software',
  homebrew_bootstrap: 'Install Homebrew',
  cis_benchmark: 'Run CIS benchmark',
  apply_cis_remediation: 'Apply CIS remediation',
  security_scan: 'Run security scan',
  security_threat_quarantine: 'Quarantine threat',
  security_threat_remove: 'Remove threat',
  security_threat_restore: 'Restore threat',
  sensitive_data_scan: 'Scan for sensitive data',
  encrypt_file: 'Encrypt file',
  secure_delete_file: 'Securely delete file',
  quarantine_file: 'Quarantine file',
  take_screenshot: 'Take screenshot',
  computer_action: 'Computer action',
  capture_pprof: 'Capture agent profile',
  manage_startup_item: 'Manage startup item',
  apply_audit_policy_baseline: 'Apply audit policy baseline',
  peripheral_policy_sync: 'Sync peripheral policy',
  peripheral_policy_sync_v2: 'Sync peripheral policy',
  reboot: 'Reboot',
  schedule_reboot: 'Scheduled reboot',
  reboot_safe_mode: 'Reboot into safe mode',
  self_uninstall: 'Uninstall agent',
  backup_run: 'Run backup',
  backup_stop: 'Stop backup',
  backup_restore: 'Restore backup',
  backup_verify: 'Verify backup',
  backup_test_restore: 'Test restore',
  vss_writer_list: 'List VSS writers',
  mssql_backup: 'SQL Server backup',
  mssql_restore: 'SQL Server restore',
  mssql_verify: 'Verify SQL Server backup',
  hyperv_backup: 'Hyper-V backup',
  hyperv_restore: 'Hyper-V restore',
  hyperv_checkpoint: 'Hyper-V checkpoint',
  hyperv_vm_state: 'Change Hyper-V VM state',
  vm_restore_from_backup: 'Restore VM from backup',
  vm_instant_boot: 'Instant-boot VM',
  bmr_recover: 'Bare-metal recovery',
  bare_metal_rebuild: 'Bare-metal rebuild',
  vault_sync: 'Sync vault',
  vault_configure: 'Configure vault',
  collect_evidence: 'Collect evidence',
  execute_containment: 'Execute containment',
};

const AGENT_COMMAND_ACTION_RE = /^agent\.command\.(.+)$/;

function formatAgentCommandAction(
  action: string,
  labels?: Record<string, string>,
): string | null {
  const match = AGENT_COMMAND_ACTION_RE.exec(action);
  if (!match) return null;
  const type = match[1];
  const humanized = type.replace(/[_.]+/g, ' ').trim();
  const name = AGENT_COMMAND_NAMES[type] ?? humanized.charAt(0).toUpperCase() + humanized.slice(1);
  const template = labels?.['agent.command.*'] ?? ACTION_DISPLAY['agent.command.*'];
  if (!humanized || !template) return null;
  return template.replace('{command}', name);
}

// Acronyms the prettifier must not render as ordinary words ("Ai session close").
const PRETTIFY_ACRONYMS: Readonly<Record<string, string>> = { ai: 'AI', mcp: 'MCP' };

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
  const words = cleaned.split(/\s+/).map((word) => PRETTIFY_ACRONYMS[word] ?? word).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  return (
    labels?.[action] ??
    ACTION_DISPLAY[action] ??
    formatFallbackAction(action, labels) ??
    formatAiToolAction(action, labels) ??
    formatAgentCommandAction(action, labels) ??
    prettify(action)
  );
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

/**
 * Action-code prefixes for the Audit Trail's Action filter (#9672), derived from
 * the catalog so the options are real dotted-code families (`script`, `device`,
 * `agent.command`, ...) rather than bare verbs. The API matches each as a code
 * prefix (`script` -> `script.*`). `api.*` catch-all rows are skipped: they are
 * HTTP-verb templates, not a family anyone filters by.
 */
export function auditActionFilterOptions(): string[] {
  const prefixes = new Set<string>();
  for (const code of Object.keys(ACTION_DISPLAY)) {
    if (!code.includes('.')) continue;
    const first = code.split('.')[0];
    if (first === 'api') continue;
    prefixes.add(code.startsWith('agent.command.') ? 'agent.command' : first);
  }
  return [...prefixes].sort();
}

/** Human label for an action prefix / resource type option ("agent.command" -> "Agent command"). */
export function auditPrefixLabel(prefix: string): string {
  return prettify(prefix);
}
