/**
 * W19 (#10065): first-call cases for the lazy chat tool index. Kept apart
 * from GOLDEN_CASES so its count pins hold. Each case runs on the chat
 * surface with the PRODUCTION chat prompt for a page: `buildSystemPrompt`
 * itself, given a fixture page context. The device fixture id is not a UUID,
 * so the builder skips the device-row and memory lookup and needs no DB.
 *
 * Run `--suite lazy-index` with `AI_TOOL_INDEX=lazy` and with
 * `AI_TOOL_INDEX=full`: the full arm is the pre-W19 prompt with the same page
 * lines, so the two arms differ only in the index text.
 */
import type { AiPageContext } from '@breeze/shared';
import type { AuthContext } from '../../../middleware/auth';
import type { GoldenCase } from './goldenPrompts';

export const LAZY_INDEX_PAGES = {
  device: { type: 'device', id: 'device-fixture', hostname: 'FS-01', os: 'Windows Server 2022', status: 'online' },
  alertCpu: { type: 'alert', id: 'alert-fixture-cpu', title: 'High CPU on FS-01', severity: 'high', deviceHostname: 'FS-01' },
  alertSpooler: { type: 'alert', id: 'alert-fixture-spooler', title: 'Service stopped: Print Spooler', severity: 'medium', deviceHostname: 'PRINT-SRV' },
  dashboard: { type: 'dashboard', orgName: 'Contoso', deviceCount: 120, alertCount: 4 },
} as const satisfies Record<string, AiPageContext>;

export type LazyIndexPageId = keyof typeof LAZY_INDEX_PAGES;

export interface LazyIndexCase extends GoldenCase {
  page: LazyIndexPageId;
  /** What the case probes, for the report. */
  kind: 'page-expanded' | 'unexpanded-domain' | 'always-on' | 'action-enum';
}

export const LAZY_INDEX_CASES: readonly LazyIndexCase[] = [
  { id: 'l01', page: 'device', kind: 'page-expanded', prompt: 'Why is the disk almost full on this machine?', expect: [{ tool: 'analyze_disk_usage' }] },
  { id: 'l02', page: 'device', kind: 'page-expanded', prompt: 'Restart the Print Spooler service here.', expect: [{ tool: 'manage_services', action: 'restart' }] },
  { id: 'l03', page: 'device', kind: 'page-expanded', prompt: 'Run the "Clear Teams cache" script on this device.', expect: [{ tool: 'run_script' }, { tool: 'list_scripts' }, { tool: 'search_script_library' }] },
  { id: 'l04', page: 'alertCpu', kind: 'page-expanded', prompt: 'Has this happened before, and what fixed it last time?', expect: [{ tool: 'find_proven_fixes' }, { tool: 'get_incident_timeline' }, { tool: 'list_remediation_suggestions' }] },
  { id: 'l05', page: 'alertSpooler', kind: 'page-expanded', prompt: 'Which alert rule raised this alert?', expect: [{ tool: 'manage_alert_rules' }] },
  { id: 'l06', page: 'dashboard', kind: 'unexpanded-domain', prompt: 'Which invoices are overdue?', expect: [{ tool: 'list_invoices' }] },
  { id: 'l07', page: 'dashboard', kind: 'unexpanded-domain', prompt: 'Did any backup jobs fail last night?', expect: [{ tool: 'query_backups' }, { tool: 'get_backup_status' }] },
  { id: 'l08', page: 'dashboard', kind: 'always-on', prompt: 'Which devices are offline right now?', expect: [{ tool: 'query_devices' }] },
  { id: 'l09', page: 'device', kind: 'action-enum', prompt: 'Disable the OneDrive startup item on this machine.', expect: [{ tool: 'manage_startup_items', action: 'disable' }] },
  { id: 'l10', page: 'dashboard', kind: 'action-enum', prompt: 'Turn off the automation called Nightly Reboot.', expect: [{ tool: 'manage_automations', action: 'disable' }, { tool: 'manage_automations', action: 'list' }] },
];

/** Minimal caller for `buildSystemPrompt`: it reads only the first name and the scope. */
const EVAL_AUTH = { user: { id: 'eval-user', name: 'Tess Tech' }, scope: 'organization' } as unknown as AuthContext;

/** The production chat prompt for this case's page (index mode from `AI_TOOL_INDEX`). */
export async function buildLazyIndexCasePrompt(c: LazyIndexCase): Promise<string> {
  const { buildSystemPrompt } = await import('../../aiAgent');
  return buildSystemPrompt(EVAL_AUTH, LAZY_INDEX_PAGES[c.page]);
}
