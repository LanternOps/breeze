import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSION_GRANTS } from '@breeze/shared';
import { requiredPermissionsForTool } from './aiGuardrails';
import { SERVICES_DIR, blankComments, matchClose } from './__testutils__/aiToolScopeScan';

/**
 * Contract: a tool's RBAC requirement is MECHANICALLY tied to the HTTP route it
 * mirrors (#6110 review 4).
 *
 * The gap this closes. `TOOL_PERMISSIONS` in `aiGuardrails.ts` claims parity
 * with a route in a COMMENT — "Mirrors routes/groups.ts:25-26", "routes/
 * backup/vault.ts:135, 186, 231". A comment is not a contract: the route can be
 * re-gated, an alias can be repointed at a different `PERMISSIONS.*`, or a
 * `requirePermission` can be deleted outright, and every AI-tool suite in this
 * directory stays green while the tool silently becomes WEAKER than the door a
 * human goes through. That is precisely the class of defect the 2026-09-17
 * audit §2.5 found ten times over (seeded Org Technician could `configure_vault`
 * through chat while the route refused), and `aiGuardrails.routeParity.contract`
 * pins only the OUTCOME for a few hand-written role/grant pairs — it never reads
 * the route.
 *
 * So this suite reads the route. For each pair below it parses the real route
 * file, finds the registration for that method+path, collects every
 * `requirePermission(...)` that applies to it (inline, via a same-file alias, or
 * via a router-level `.use('*', …)` in the file or in the parent that mounts
 * it), resolves `PERMISSIONS.X` through the canonical `PERMISSION_GRANTS`
 * constant, and compares the result with what `requiredPermissionsForTool` —
 * the same resolution `checkToolPermission` performs, extras and per-action
 * extras included — resolves for the tool.
 *
 * Two assertions per pair, and the asymmetry is deliberate:
 *   1. ROUTE ⊆ TOOL. A tool may never require LESS than its route. No
 *      exceptions, ever.
 *   2. TOOL \ ROUTE equals the row's declared `toolOnly.extra`. A tool that is
 *      STRONGER than its route is legitimate but must say so out loud, with a
 *      reason — otherwise "stronger" is indistinguishable from "the route lost
 *      a gate and nobody noticed".
 *
 * What it does NOT claim: that the route named here is the only route reaching
 * the same data, nor that scope/MFA middleware is mirrored (this file has no
 * MFA concept — see the note beside `TOOL_EXTRA_PERMISSIONS`).
 */

const ROUTES_DIR = join(SERVICES_DIR, '..', 'routes');

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

// ----------------------------------------------------------- the extractor
//
// Pure functions over a source STRING, fixture-tested at the bottom of the
// file. Nothing here reads the filesystem, so the fixtures drive exactly the
// code that runs against the repo.

/** `PERMISSIONS.DEVICES_READ` / `PERMISSION_GRANTS.DEVICES_READ` → `devices:read`. */
function grantKeyToSpec(key: string): string {
  const grant = (PERMISSION_GRANTS as Record<string, { resource: string; action: string }>)[key];
  if (!grant) throw new Error(`unknown PERMISSIONS key "${key}" — not in the canonical catalog`);
  return `${grant.resource}:${grant.action}`;
}

/**
 * The permission a single `requirePermission(...)` argument list denotes.
 *
 * Two forms are in use and both are accepted; anything else THROWS rather than
 * returning nothing, so a new spelling shows up as a loud failure instead of a
 * silently empty route set (the failure mode that would make this whole suite
 * vacuous).
 */
export function permissionFromRequireArgs(args: string): string {
  const constForm = /PERMISSION(?:S|_GRANTS)\.(\w+)\.resource\s*,\s*PERMISSION(?:S|_GRANTS)\.(\w+)\.action/.exec(args);
  if (constForm) {
    if (constForm[1] !== constForm[2]) {
      throw new Error(`requirePermission mixes two grants: ${constForm[1]} / ${constForm[2]}`);
    }
    return grantKeyToSpec(constForm[1]!);
  }
  const literalForm = /^\s*'([a-z_*]+)'\s*,\s*'([a-z_*]+)'\s*$/.exec(args);
  if (literalForm) return `${literalForm[1]}:${literalForm[2]}`;
  throw new Error(`unrecognised requirePermission(...) form: ${args.trim().slice(0, 120)}`);
}

/** Every `requirePermission(...)` inside `slice`, in source order. */
function requirePermissionsIn(slice: string): string[] {
  const out: string[] = [];
  const re = /\brequirePermission\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    const open = slice.indexOf('(', m.index);
    const close = matchClose(slice, open, '(', ')');
    out.push(permissionFromRequireArgs(slice.slice(open + 1, close)));
  }
  return out;
}

/**
 * Same-file middleware ALIASES: `const requireGroupRead = requirePermission(…)`.
 * One level only, which is all the codebase uses — an alias of an alias would
 * simply not resolve, and the pair would fail loudly rather than quietly bind
 * to an empty set.
 */
export function permissionAliases(src: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const re = /\b(?:const|let)\s+(\w+)\s*=\s*requirePermission\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index + m[0].length - 1);
    const close = matchClose(src, open, '(', ')');
    aliases.set(m[1]!, permissionFromRequireArgs(src.slice(open + 1, close)));
  }
  return aliases;
}

/** The first string literal at `from`, skipping whitespace. Null if there is none. */
function leadingStringLiteral(src: string, from: number): string | null {
  let i = from;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  const quote = src[i];
  if (quote !== "'" && quote !== '"') return null;
  const end = src.indexOf(quote, i + 1);
  if (end < 0) return null;
  return src.slice(i + 1, end);
}

/**
 * The middleware slice of a route registration: everything between the path
 * literal and the handler. Stopping at the handler is what keeps this parser
 * honest — the handler body is full of braces, template literals and regexes
 * that a general argument splitter would choke on, and nothing in it is
 * middleware anyway.
 */
function middlewareSlice(call: string): string {
  const pathQuote = call.search(/['"]/);
  const afterPath = call.indexOf(call[pathQuote]!, pathQuote + 1) + 1;
  const handler = /\basync\s*\(\s*c\b|\(\s*c\s*(?::[^)]*)?\)\s*=>/.exec(call.slice(afterPath));
  return handler ? call.slice(afterPath, afterPath + handler.index) : call.slice(afterPath);
}

/** Permissions applied by a `<router>.use('*', …)` anywhere in the file. */
export function routerLevelPermissions(rawSrc: string): string[] {
  const src = blankComments(rawSrc);
  const aliases = permissionAliases(src);
  const out: string[] = [];
  const re = /\.use\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index);
    const close = matchClose(src, open, '(', ')');
    const inner = src.slice(open + 1, close);
    if (leadingStringLiteral(inner, 0) !== '*') continue;
    out.push(...requirePermissionsIn(inner), ...aliasesNamedIn(inner, aliases));
  }
  return out;
}

function aliasesNamedIn(slice: string, aliases: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [name, spec] of aliases) {
    if (new RegExp(`\\b${name}\\b`).test(slice)) out.push(spec);
  }
  return out;
}

/**
 * Permissions gating ONE route registration, identified by method + path.
 *
 * Returns null when the registration cannot be located, and throws when the
 * same method+path is registered more than once — both are "I could not bind
 * this mechanically", which the caller turns into a failure rather than an
 * empty set.
 */
export function routeRegistrationPermissions(
  rawSrc: string,
  method: Method,
  path: string,
): string[] | null {
  const src = blankComments(rawSrc);
  const aliases = permissionAliases(src);
  const found: string[][] = [];
  const re = new RegExp(`\\.${method}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('(', m.index);
    const close = matchClose(src, open, '(', ')');
    const inner = src.slice(open + 1, close);
    if (leadingStringLiteral(inner, 0) !== path) continue;
    const slice = middlewareSlice(inner);
    found.push([...requirePermissionsIn(slice), ...aliasesNamedIn(slice, aliases)]);
  }
  if (found.length === 0) return null;
  if (found.length > 1) {
    throw new Error(`${method.toUpperCase()} ${path} is registered ${found.length} times — ambiguous`);
  }
  return found[0]!;
}

// ------------------------------------------------------------- the bindings

interface Binding {
  tool: string;
  action?: string;
  /**
   * Extra tool input for a tool whose permission follows a non-`action` input
   * (a boolean that asks for fresh data from the device). Merged with `action`.
   */
  input?: Record<string, unknown>;
  /** Relative to `src/routes/`. */
  routeFile: string;
  method: Method;
  path: string;
  /** Route files whose router-level `.use('*', …)` also applies to this path. */
  parents?: string[];
  /**
   * Permissions the TOOL requires that the route does not. Legitimate, but it
   * has to be declared with a reason so "stronger" can never be confused with
   * "the route quietly lost a gate".
   */
  toolOnly?: { extra: string[]; reason: string };
}

/**
 * The tools #6110 remapped or corrected. Route located from the evidence
 * comments in `aiGuardrails.ts` beside each mapping.
 */
const BINDINGS: readonly Binding[] = [
  {
    tool: 'read_artifact', routeFile: 'aiArtifacts.ts', method: 'get', path: '/:id',
    toolOnly: { extra: [], reason: 'Only artifacts anchored to the caller\'s own session or agent run, and only where capture is enabled; the REST download is org-wide.' },
  },
  { tool: 'list_ai_agents', routeFile: 'aiAgents.ts', method: 'get', path: '/' },
  {
    tool: 'list_ai_agent_runs', routeFile: 'aiAgents.ts', method: 'get', path: '/runs',
    toolOnly: { extra: [], reason: 'Exact-device callers only see runs for allowed devices; the REST list applies no device gate.' },
  },
  {
    tool: 'get_ai_agent_run', routeFile: 'aiAgents.ts', method: 'get', path: '/runs/:runId',
    toolOnly: { extra: [], reason: 'Exact-device callers only see runs for allowed devices, and intent summaries are narrowed to devices allowed within the run\'s own org; the REST read applies no device gate.' },
  },
  { tool: 'list_sites', routeFile: 'orgs.ts', method: 'get', path: '/sites', toolOnly: { extra: [], reason: 'Device counts are additionally narrowed to exact-device scope.' } },
  { tool: 'get_site', routeFile: 'orgs.ts', method: 'get', path: '/sites/:id', toolOnly: { extra: [], reason: 'Requires a site UUID and conceals inaccessible sites as not found.' } },
  {
    tool: 'list_remediation_suggestions', routeFile: 'remediationSuggestions.ts', method: 'get', path: '/',
    toolOnly: { extra: [], reason: 'Explicit orgId requires organization access; exact-device scope also narrows device rows; empty site access returns no rows, including device-less suggestions.' },
  },
  {
    tool: 'find_proven_fixes', routeFile: 'remediationSuggestions.ts', method: 'get', path: '/',
    toolOnly: { extra: [], reason: 'Source alert/episode is resolved through the caller org condition, exact-device scope and site scope before any memory read; memory output is counts only.' },
  },
  // Exact-device scope additionally limits these reads to linked assets.
  { tool: 'list_network_assets', routeFile: 'discovery.ts', method: 'get', path: '/assets', toolOnly: { extra: [], reason: 'Exact-device callers only see assets linked to allowed devices.' } },
  { tool: 'get_network_asset', routeFile: 'discovery.ts', method: 'get', path: '/assets/:id', toolOnly: { extra: [], reason: 'Exact-device callers only see assets linked to allowed devices.' } },
  {
    tool: 'list_incidents', routeFile: 'incidents.ts', method: 'get', path: '/',
    toolOnly: { extra: [], reason: 'Site/device-bound callers only see incidents with a reachable affected device; REST list has no site/device gate.' },
  },
  {
    tool: 'list_org_contacts', routeFile: 'orgContacts.ts', method: 'get', path: '/organizations/:id/contacts',
    toolOnly: { extra: [], reason: 'An empty site allowlist hides all contacts; REST visibility is org-level only.' },
  },
  // Time reads narrow other-user access to platform admins (route also accepts *:* grants).
  {
    tool: 'list_time_entries', routeFile: 'timeEntries/timeEntries.ts', method: 'get', path: '/',
    toolOnly: { extra: [], reason: 'Cross-user reads are restricted to platform admins; the route also accepts *:* grants.' },
  },
  {
    tool: 'get_running_timer', routeFile: 'timeEntries/timeEntries.ts', method: 'get', path: '/running',
    toolOnly: { extra: [], reason: 'Cross-user reads are restricted to platform admins; the route also accepts *:* grants.' },
  },
  {
    tool: 'get_timesheet', routeFile: 'timeEntries/timeEntries.ts', method: 'get', path: '/timesheet',
    toolOnly: { extra: [], reason: 'Cross-user reads are restricted to platform admins; the route also accepts *:* grants.' },
  },

  // §2.5 — report generation is an EXPORT, not a report read.
  { tool: 'generate_report', action: 'generate', routeFile: 'reports/generate.ts', method: 'post', path: '/generate' },

  // §2.5 — the vault cluster: reads are organizations:read, configure WRITES.
  { tool: 'query_vaults', routeFile: 'backup/vault.ts', method: 'get', path: '/' },
  { tool: 'get_vault_status', routeFile: 'backup/vault.ts', method: 'get', path: '/:id/status' },
  { tool: 'configure_vault', routeFile: 'backup/vault.ts', method: 'post', path: '/' },

  // Restore tools and DR plan management/execution.
  { tool: 'restore_snapshot', routeFile: 'backup/restore.ts', method: 'post', path: '/restore' },
  { tool: 'restore_as_vm', routeFile: 'backup/vmrestore.ts', method: 'post', path: '/restore/as-vm' },
  { tool: 'instant_boot_vm', routeFile: 'backup/vmrestore.ts', method: 'post', path: '/restore/instant-boot' },
  { tool: 'restore_hyperv_vm', routeFile: 'backup/hyperv.ts', method: 'post', path: '/restore' },
  { tool: 'restore_mssql_database', routeFile: 'backup/mssql.ts', method: 'post', path: '/mssql/restore' },
  { tool: 'manage_dr_plan', action: 'create_plan', routeFile: 'dr.ts', method: 'post', path: '/plans' },
  { tool: 'manage_dr_plan', action: 'update_plan', routeFile: 'dr.ts', method: 'patch', path: '/plans/:id' },
  { tool: 'manage_dr_plan', action: 'add_group', routeFile: 'dr.ts', method: 'post', path: '/plans/:id/groups' },
  { tool: 'manage_dr_plan', action: 'update_group', routeFile: 'dr.ts', method: 'patch', path: '/plans/:id/groups/:gid' },
  { tool: 'manage_dr_plan', action: 'delete_group', routeFile: 'dr.ts', method: 'delete', path: '/plans/:id/groups/:gid' },
  // backup:write for plans with a BARE_METAL_REBUILD group is data-dependent;
  // the handler enforces it (aiToolsDR.ts execute_dr_plan).
  { tool: 'execute_dr_plan', routeFile: 'dr.ts', method: 'post', path: '/plans/:id/execute' },

  // Full-control W03 (#6757): every backup / DR / Hyper-V write action wired
  // into chat binds to the route a technician uses for the same act.
  { tool: 'trigger_backup', routeFile: 'backup/jobs.ts', method: 'post', path: '/jobs/run/:deviceId' },
  { tool: 'trigger_hyperv_backup', routeFile: 'backup/hyperv.ts', method: 'post', path: '/backup' },
  { tool: 'trigger_mssql_backup', routeFile: 'backup/mssql.ts', method: 'post', path: '/mssql/backup' },
  { tool: 'verify_mssql_backup', routeFile: 'backup/mssql.ts', method: 'post', path: '/mssql/verify/:snapshotId' },
  { tool: 'trigger_vault_sync', routeFile: 'backup/vault.ts', method: 'post', path: '/:id/sync' },
  { tool: 'configure_vault', action: 'update', routeFile: 'backup/vault.ts', method: 'patch', path: '/:id' },
  { tool: 'trigger_c2c_sync', routeFile: 'c2c/jobs.ts', method: 'post', path: '/configs/:id/run' },
  { tool: 'restore_c2c_items', routeFile: 'c2c/items.ts', method: 'post', path: '/restore' },
  ...(['start', 'stop', 'force_stop', 'pause', 'resume', 'save'] as const).map((action) => (
    { tool: 'manage_hyperv_vm', action, routeFile: 'backup/hyperv.ts', method: 'post' as const, path: '/vm-state/:deviceId/:vmId' }
  )),
  ...(['create', 'delete', 'apply'] as const).map((action) => (
    { tool: 'manage_hyperv_checkpoints', action, routeFile: 'backup/hyperv.ts', method: 'post' as const, path: '/checkpoints/:deviceId/:vmId' }
  )),
  { tool: 'manage_backup_profiles', action: 'list', routeFile: 'backup/profiles.ts', method: 'get', path: '/profiles' },
  { tool: 'manage_backup_profiles', action: 'get', routeFile: 'backup/profiles.ts', method: 'get', path: '/profiles/:id' },
  { tool: 'manage_backup_profiles', action: 'create', routeFile: 'backup/profiles.ts', method: 'post', path: '/profiles' },
  { tool: 'manage_backup_profiles', action: 'update', routeFile: 'backup/profiles.ts', method: 'patch', path: '/profiles/:id' },
  { tool: 'manage_backup_profiles', action: 'delete', routeFile: 'backup/profiles.ts', method: 'delete', path: '/profiles/:id' },
  { tool: 'configure_backup_sla', action: 'create', routeFile: 'backup/sla.ts', method: 'post', path: '/configs' },
  { tool: 'configure_backup_sla', action: 'update', routeFile: 'backup/sla.ts', method: 'patch', path: '/configs/:id' },

  // §2.5 — backup / Hyper-V / MSSQL reads. query_backups' own binding moved to
  // the per-action rows below (its base tier-1 map is per-action, so a
  // bare-tool binding here can no longer resolve).
  { tool: 'browse_snapshots', routeFile: 'backup/snapshots.ts', method: 'get', path: '/snapshots/:id/browse' },
  { tool: 'get_vm_restore_estimate', routeFile: 'backup/vmrestore.ts', method: 'get', path: '/restore/as-vm/estimate/:snapshotId' },
  { tool: 'query_hyperv_vms', routeFile: 'backup/hyperv.ts', method: 'get', path: '/vms' },
  { tool: 'query_mssql_instances', routeFile: 'backup/mssql.ts', method: 'get', path: '/mssql/instances' },

  // §2.5 — the remote gate lives on the PARENT router, not on the session
  // route, which is exactly why it was missing from the tool.
  {
    tool: 'create_remote_session',
    routeFile: 'remote/sessions.ts',
    method: 'post',
    path: '/sessions',
    parents: ['remote/index.ts'],
    toolOnly: {
      extra: ['devices:execute'],
      reason: 'POST /remote/sessions carries no device grant of its own; the tool keeps devices:execute because starting a session dispatches to the agent, and dropping it would let remote:access alone drive a device',
    },
  },

  // #6930 — ticket checklist steps and templates.
  { tool: 'manage_ticket_checklist', action: 'list', routeFile: 'tickets/checklist.ts', method: 'get', path: '/:id/checklist' },
  { tool: 'manage_ticket_checklist', action: 'add_item', routeFile: 'tickets/checklist.ts', method: 'post', path: '/:id/checklist' },
  { tool: 'manage_ticket_checklist', action: 'update_item', routeFile: 'tickets/checklist.ts', method: 'patch', path: '/checklist/:itemId' },
  { tool: 'manage_ticket_checklist', action: 'delete_item', routeFile: 'tickets/checklist.ts', method: 'delete', path: '/checklist/:itemId' },
  { tool: 'manage_ticket_checklist', action: 'reorder', routeFile: 'tickets/checklist.ts', method: 'post', path: '/:id/checklist/reorder' },
  { tool: 'manage_ticket_checklist', action: 'apply_template', routeFile: 'tickets/checklist.ts', method: 'post', path: '/:id/checklist/apply-template' },
  { tool: 'manage_ticket_checklist', action: 'save_as_template', routeFile: 'tickets/checklist.ts', method: 'post', path: '/:id/checklist/save-as-template' },
  { tool: 'manage_ticket_checklist', action: 'duplicate_template', routeFile: 'ticketChecklistTemplates.ts', method: 'post', path: '/:id/duplicate' },
  { tool: 'manage_ticket_checklist', action: 'list_templates', routeFile: 'ticketChecklistTemplates.ts', method: 'get', path: '/' },
  { tool: 'manage_ticket_checklist', action: 'get_template', routeFile: 'ticketChecklistTemplates.ts', method: 'get', path: '/:id' },

  // §2.5 — the per-action extra-permission map.
  { tool: 'manage_tickets', action: 'move_org', routeFile: 'tickets/moveOrg.ts', method: 'post', path: '/:id/move-org' },

  // §2.4 — a registry read is an agent EXECUTION (privileged-read precedent).
  { tool: 'registry_operations', action: 'read_key', routeFile: 'devices/commands.ts', method: 'post', path: '/:id/commands' },

  // Live device inspection: every /system-tools route dispatches to the agent,
  // and the router (systemTools/index.ts) gates every method on devices:execute.
  { tool: 'manage_processes', action: 'list', routeFile: 'systemTools/processes.ts', method: 'get', path: '/devices/:deviceId/processes', parents: ['systemTools/index.ts'] },
  { tool: 'manage_scheduled_tasks', action: 'list', routeFile: 'systemTools/scheduledTasks.ts', method: 'get', path: '/devices/:deviceId/tasks', parents: ['systemTools/index.ts'] },
  { tool: 'manage_services', action: 'list', routeFile: 'systemTools/services.ts', method: 'get', path: '/devices/:deviceId/services', parents: ['systemTools/index.ts'] },
  { tool: 'file_operations', action: 'list', routeFile: 'systemTools/fileBrowser.ts', method: 'get', path: '/devices/:deviceId/files', parents: ['systemTools/index.ts'] },
  { tool: 'registry_operations', action: 'get_value', routeFile: 'systemTools/registry.ts', method: 'get', path: '/devices/:deviceId/registry/value', parents: ['systemTools/index.ts'] },
  // Live device reads outside /system-tools. The live request is bound to the
  // route that sends the same command; the stored-data read to the route that
  // reads the stored result.
  { tool: 'system_cleanup', action: 'list', routeFile: 'devices/filesystemSystemCleanup.ts', method: 'post', path: '/:id/filesystem/system-cleanup/list' },
  { tool: 'system_cleanup', action: 'run', routeFile: 'devices/filesystemSystemCleanup.ts', method: 'post', path: '/:id/filesystem/system-cleanup/run' },
  { tool: 'system_cleanup', action: 'status', routeFile: 'devices/filesystemSystemCleanup.ts', method: 'get', path: '/:id/filesystem/system-cleanup/run/:cleanupRunId' },
  { tool: 'analyze_disk_usage', input: { refresh: true }, routeFile: 'devices/filesystem.ts', method: 'post', path: '/:id/filesystem/scan' },
  { tool: 'analyze_disk_usage', routeFile: 'devices/filesystem.ts', method: 'get', path: '/:id/filesystem' },
  { tool: 'analyze_boot_performance', input: { triggerCollection: true }, routeFile: 'devices/bootMetrics.ts', method: 'post', path: '/:id/collect-boot-metrics' },
  { tool: 'analyze_boot_performance', routeFile: 'devices/bootMetrics.ts', method: 'get', path: '/:id/boot-metrics' },

  // §2.6 — the ten resources that did not exist in the canonical catalog.
  { tool: 'manage_deployments', action: 'get', routeFile: 'deployments.ts', method: 'get', path: '/:id' },
  { tool: 'manage_deployments', action: 'create', routeFile: 'deployments.ts', method: 'post', path: '/' },
  { tool: 'manage_deployments', action: 'start', routeFile: 'deployments.ts', method: 'post', path: '/:id/start' },

  { tool: 'manage_patches', action: 'list', routeFile: 'patches/list.ts', method: 'get', path: '/' },
  { tool: 'manage_patches', action: 'approve', routeFile: 'patches/approvals.ts', method: 'post', path: '/:id/approve' },
  { tool: 'manage_patches', action: 'install', routeFile: 'configurationPolicies/patchJobs.ts', method: 'post', path: '/:id/patch-job' },

  { tool: 'manage_groups', action: 'list', routeFile: 'groups.ts', method: 'get', path: '/' },
  { tool: 'manage_groups', action: 'create', routeFile: 'groups.ts', method: 'post', path: '/' },

  { tool: 'manage_maintenance_windows', action: 'list', routeFile: 'maintenance.ts', method: 'get', path: '/windows' },
  { tool: 'manage_maintenance_windows', action: 'create', routeFile: 'maintenance.ts', method: 'post', path: '/windows' },

  { tool: 'manage_backup_configs', action: 'list', routeFile: 'backup/configs.ts', method: 'get', path: '/configs' },
  { tool: 'manage_backup_configs', action: 'create', routeFile: 'backup/configs.ts', method: 'post', path: '/configs' },

  { tool: 'manage_peripheral_policies', action: 'create', routeFile: 'peripheralControl.ts', method: 'post', path: '/policies' },

  { tool: 'manage_automations', action: 'run', routeFile: 'automations.ts', method: 'post', path: '/:id/run' },

  { tool: 'manage_configuration_policy', action: 'create', routeFile: 'configurationPolicies/crud.ts', method: 'post', path: '/' },

  { tool: 'manage_update_rings', action: 'list', routeFile: 'updateRings.ts', method: 'get', path: '/' },
  { tool: 'manage_update_rings', action: 'create', routeFile: 'updateRings.ts', method: 'post', path: '/' },

  // These tools require the same permission as the route they mirror
  // (aiGuardrails.ts TOOL_PERMISSIONS / TOOL_ACTION_EXTRA_PERMISSIONS). Bound
  // here so a later change to the route's permission is reflected here too.
  { tool: 'manage_quotes', action: 'decline', routeFile: 'quotes/lifecycle.ts', method: 'post', path: '/:id/decline-on-behalf' },
  {
    tool: 'manage_quotes', action: 'create_pay_link', routeFile: 'invoices/stripe.ts', method: 'post', path: '/:id/pay-link',
    toolOnly: {
      extra: ['quotes:read'],
      reason: 'the handler resolves the pay link from the CONVERTED QUOTE by id before delegating to the invoice route\'s own logic (createQuotePayLink → quotePay.ts), so it needs quotes:read on top of the route\'s invoices:send.',
    },
  },
  { tool: 'manage_billing_catalog', action: 'archive_item', routeFile: 'catalog/catalog.ts', method: 'post', path: '/:id/archive' },
  { tool: 'test_webhook', routeFile: 'webhooks.ts', method: 'post', path: '/:id/test' },
  // Full-control W04 (#6758) — every write action of the security / incident /
  // device-operation tools is bound to the route it mirrors (spec #6096/#6110:
  // a tool is never weaker than its route). Actions with no single REST twin
  // are in UNBOUND below.
  { tool: 'collect_evidence', routeFile: 'devices/commands.ts', method: 'post', path: '/:id/commands' },
  { tool: 'create_incident', routeFile: 'incidents.ts', method: 'post', path: '/' },
  {
    tool: 'execute_containment', routeFile: 'devices/commands.ts', method: 'post', path: '/:id/commands',
    toolOnly: {
      extra: ['alerts:write'],
      reason: 'the tool dispatches the containment command (the route bound here) AND writes incident_actions, which moves the incident to contained; REST gates that incident mutation separately on alerts:write (routes/incidentActions.ts POST /:id/contain), so the single AI call must hold both (W04-D9, quorum QW6).',
    },
  },
  { tool: 'revoke_elevation', routeFile: 'pam.ts', method: 'post', path: '/elevation-requests/:id/revoke' },
  { tool: 'manage_processes', action: 'kill', routeFile: 'systemTools/processes.ts', method: 'post', path: '/devices/:deviceId/processes/:pid/kill', parents: ['systemTools/index.ts'] },
  { tool: 'manage_scheduled_tasks', action: 'run', routeFile: 'systemTools/scheduledTasks.ts', method: 'post', path: '/devices/:deviceId/tasks/:path/run', parents: ['systemTools/index.ts'] },
  { tool: 'manage_scheduled_tasks', action: 'disable', routeFile: 'systemTools/scheduledTasks.ts', method: 'post', path: '/devices/:deviceId/tasks/:path/disable', parents: ['systemTools/index.ts'] },
  { tool: 'manage_scheduled_tasks', action: 'enable', routeFile: 'systemTools/scheduledTasks.ts', method: 'post', path: '/devices/:deviceId/tasks/:path/enable', parents: ['systemTools/index.ts'] },
  { tool: 'registry_operations', action: 'set_value', routeFile: 'systemTools/registry.ts', method: 'put', path: '/devices/:deviceId/registry/value', parents: ['systemTools/index.ts'] },
  { tool: 'registry_operations', action: 'create_key', routeFile: 'systemTools/registry.ts', method: 'post', path: '/devices/:deviceId/registry/key', parents: ['systemTools/index.ts'] },
  { tool: 'registry_operations', action: 'delete_key', routeFile: 'systemTools/registry.ts', method: 'delete', path: '/devices/:deviceId/registry/key', parents: ['systemTools/index.ts'] },
  { tool: 'trigger_agent_restart', routeFile: 'devices/agentRecovery.ts', method: 'post', path: '/:id/agent-recovery' },
  { tool: 'manage_software_policy', action: 'list', routeFile: 'softwarePolicies.ts', method: 'get', path: '/' },
  { tool: 'manage_software_policy', action: 'get', routeFile: 'softwarePolicies.ts', method: 'get', path: '/:id' },
  { tool: 'manage_software_policy', action: 'create', routeFile: 'softwarePolicies.ts', method: 'post', path: '/' },
  { tool: 'manage_software_policy', action: 'update', routeFile: 'softwarePolicies.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_software_policy', action: 'delete', routeFile: 'softwarePolicies.ts', method: 'delete', path: '/:id' },
  { tool: 'manage_browser_policy', action: 'list', routeFile: 'browserSecurity.ts', method: 'get', path: '/policies' },
  { tool: 'manage_browser_policy', action: 'create', routeFile: 'browserSecurity.ts', method: 'post', path: '/policies' },
  { tool: 'manage_browser_policy', action: 'update', routeFile: 'browserSecurity.ts', method: 'put', path: '/policies/:policyId' },
  // manage_peripheral_policy: create and update share POST /policies (update = body `id`);
  // add_exception and remove_exception share POST /exceptions (body `operation`).
  { tool: 'manage_peripheral_policy', action: 'create', routeFile: 'peripheralControl.ts', method: 'post', path: '/policies' },
  { tool: 'manage_peripheral_policy', action: 'update', routeFile: 'peripheralControl.ts', method: 'post', path: '/policies' },
  { tool: 'manage_peripheral_policy', action: 'disable', routeFile: 'peripheralControl.ts', method: 'post', path: '/policies/:id/disable' },
  { tool: 'manage_peripheral_policy', action: 'add_exception', routeFile: 'peripheralControl.ts', method: 'post', path: '/exceptions' },
  { tool: 'manage_peripheral_policy', action: 'remove_exception', routeFile: 'peripheralControl.ts', method: 'post', path: '/exceptions' },
  { tool: 'remediate_sensitive_data', action: 'encrypt', routeFile: 'sensitiveData.ts', method: 'post', path: '/remediate' },
  { tool: 'remediate_sensitive_data', action: 'quarantine', routeFile: 'sensitiveData.ts', method: 'post', path: '/remediate' },
  { tool: 'remediate_sensitive_data', action: 'secure_delete', routeFile: 'sensitiveData.ts', method: 'post', path: '/remediate' },
  { tool: 'remediate_sensitive_data', action: 'accept_risk', routeFile: 'sensitiveData.ts', method: 'post', path: '/remediate' },
  { tool: 'remediate_sensitive_data', action: 'false_positive', routeFile: 'sensitiveData.ts', method: 'post', path: '/remediate' },
  { tool: 'remediate_sensitive_data', action: 'mark_remediated', routeFile: 'sensitiveData.ts', method: 'post', path: '/remediate' },
  { tool: 'remediate_software_violation', routeFile: 'softwarePolicies.ts', method: 'post', path: '/:id/remediate' },
  { tool: 'assign_security_training', routeFile: 'userRisk.ts', method: 'post', path: '/assign-training' },
  // configure_network_baseline has no action enum: it creates AND updates. POST / and
  // PATCH /:id both gate on devices:write, so the create route stands for both.
  { tool: 'configure_network_baseline', routeFile: 'networkBaselines.ts', method: 'post', path: '/' },
  { tool: 'acknowledge_network_device', routeFile: 'networkChanges.ts', method: 'post', path: '/:id/acknowledge' },
  // W02 (#6756) — every write action of the PSA/billing write tools is bound
  // to its route (W02-D11). The only actions with no REST twin are the
  // agent-only ticket-triage executors (link_device, draft): their
  // `tickets:update` grant is deliberately held by no role.
  { tool: 'manage_tickets', action: 'create', routeFile: 'tickets/tickets.ts', method: 'post', path: '/' },
  { tool: 'manage_tickets', action: 'update_fields', routeFile: 'tickets/tickets.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_tickets', action: 'update_status', routeFile: 'tickets/tickets.ts', method: 'post', path: '/:id/status' },
  { tool: 'manage_tickets', action: 'assign', routeFile: 'tickets/tickets.ts', method: 'post', path: '/:id/assign' },
  { tool: 'manage_tickets', action: 'comment', routeFile: 'tickets/tickets.ts', method: 'post', path: '/:id/comments' },
  { tool: 'manage_tickets', action: 'edit_comment', routeFile: 'tickets/tickets.ts', method: 'patch', path: '/:id/comments/:commentId' },
  { tool: 'manage_tickets', action: 'delete_comment', routeFile: 'tickets/tickets.ts', method: 'delete', path: '/:id/comments/:commentId' },
  { tool: 'manage_tickets', action: 'link_alert', routeFile: 'tickets/tickets.ts', method: 'post', path: '/:id/alerts' },
  { tool: 'manage_tickets', action: 'unlink_alert', routeFile: 'tickets/tickets.ts', method: 'delete', path: '/:id/alerts/:alertId' },
  { tool: 'manage_tickets', action: 'create_from_alert', routeFile: 'alerts/alerts.ts', method: 'post', path: '/:id/create-ticket' },
  { tool: 'manage_tickets', action: 'log_time_entry', routeFile: 'timeEntries/timeEntries.ts', method: 'post', path: '/' },
  { tool: 'manage_tickets', action: 'start_timer', routeFile: 'timeEntries/timeEntries.ts', method: 'post', path: '/start' },
  { tool: 'manage_tickets', action: 'stop_timer', routeFile: 'timeEntries/timeEntries.ts', method: 'post', path: '/stop' },
  { tool: 'manage_tickets', action: 'update_time_entry', routeFile: 'timeEntries/timeEntries.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_tickets', action: 'link_ticket', routeFile: 'tickets/links.ts', method: 'post', path: '/:id/links' },
  { tool: 'manage_tickets', action: 'unlink_ticket', routeFile: 'tickets/links.ts', method: 'delete', path: '/:id/links/:linkId' },
  { tool: 'manage_quotes', action: 'create_draft', routeFile: 'quotes/quotes.ts', method: 'post', path: '/' },
  { tool: 'manage_quotes', action: 'update', routeFile: 'quotes/quotes.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_quotes', action: 'delete_draft', routeFile: 'quotes/quotes.ts', method: 'delete', path: '/:id' },
  { tool: 'manage_quotes', action: 'add_block', routeFile: 'quotes/quotes.ts', method: 'post', path: '/:id/blocks' },
  { tool: 'manage_quotes', action: 'update_block', routeFile: 'quotes/quotes.ts', method: 'patch', path: '/:id/blocks/:blockId' },
  { tool: 'manage_quotes', action: 'delete_block', routeFile: 'quotes/quotes.ts', method: 'delete', path: '/:id/blocks/:blockId' },
  { tool: 'manage_quotes', action: 'reorder_blocks', routeFile: 'quotes/quotes.ts', method: 'patch', path: '/:id/blocks/reorder' },
  { tool: 'manage_quotes', action: 'add_manual_line', routeFile: 'quotes/quotes.ts', method: 'post', path: '/:id/lines' },
  { tool: 'manage_quotes', action: 'add_catalog_line', routeFile: 'quotes/quotes.ts', method: 'post', path: '/:id/lines/catalog' },
  { tool: 'manage_quotes', action: 'update_line', routeFile: 'quotes/quotes.ts', method: 'patch', path: '/:id/lines/:lineId' },
  { tool: 'manage_quotes', action: 'remove_line', routeFile: 'quotes/quotes.ts', method: 'delete', path: '/:id/lines/:lineId' },
  { tool: 'manage_quotes', action: 'move_line', routeFile: 'quotes/quotes.ts', method: 'patch', path: '/:id/lines/:lineId/move' },
  { tool: 'manage_quotes', action: 'reorder_lines', routeFile: 'quotes/quotes.ts', method: 'patch', path: '/:id/blocks/:blockId/lines/reorder' },
  { tool: 'manage_quotes', action: 'send', routeFile: 'quotes/lifecycle.ts', method: 'post', path: '/:id/send' },
  { tool: 'manage_billing_catalog', action: 'create_item', routeFile: 'catalog/catalog.ts', method: 'post', path: '/' },
  { tool: 'manage_billing_catalog', action: 'update_item', routeFile: 'catalog/catalog.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_billing_catalog', action: 'set_price', routeFile: 'catalog/pricing.ts', method: 'put', path: '/:id/prices/:currencyCode' },
  { tool: 'manage_billing_catalog', action: 'remove_price', routeFile: 'catalog/pricing.ts', method: 'delete', path: '/:id/prices/:currencyCode' },
  { tool: 'manage_billing_catalog', action: 'set_org_price', routeFile: 'catalog/pricing.ts', method: 'put', path: '/:id/pricing/:orgId' },
  { tool: 'manage_billing_catalog', action: 'remove_org_price', routeFile: 'catalog/pricing.ts', method: 'delete', path: '/:id/pricing/:orgId' },
  { tool: 'manage_billing_catalog', action: 'set_bundle_components', routeFile: 'catalog/bundles.ts', method: 'put', path: '/:id/components' },
  { tool: 'manage_saved_filters', action: 'create', routeFile: 'filters.ts', method: 'post', path: '/' },
  { tool: 'manage_saved_filters', action: 'delete', routeFile: 'filters.ts', method: 'delete', path: '/:id' },
  { tool: 'manage_tags', action: 'add', routeFile: 'devices/core.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_tags', action: 'remove', routeFile: 'devices/core.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_notification_channels', action: 'create', routeFile: 'alerts/channels.ts', method: 'post', path: '/channels' },
  { tool: 'manage_notification_channels', action: 'update', routeFile: 'alerts/channels.ts', method: 'put', path: '/channels/:id' },
  { tool: 'manage_notification_channels', action: 'delete', routeFile: 'alerts/channels.ts', method: 'delete', path: '/channels/:id' },
  { tool: 'manage_notification_channels', action: 'test', routeFile: 'alerts/channels.ts', method: 'post', path: '/channels/:id/test' },
  // Read-only tools: each requires the same permission as its route.
  { tool: 'query_backups', action: 'list_configs', routeFile: 'backup/configs.ts', method: 'get', path: '/configs' },
  { tool: 'query_backups', action: 'list_jobs', routeFile: 'backup/jobs.ts', method: 'get', path: '/jobs' },
  { tool: 'query_backups', action: 'list_policies', routeFile: 'configurationPolicies/crud.ts', method: 'get', path: '/' },
  { tool: 'get_backup_status', routeFile: 'backup/dashboard.ts', method: 'get', path: '/status/:deviceId' },
  { tool: 'query_backup_sla', routeFile: 'backup/sla.ts', method: 'get', path: '/configs' },
  { tool: 'get_sla_breaches', routeFile: 'backup/sla.ts', method: 'get', path: '/events' },
  { tool: 'get_sla_compliance_report', routeFile: 'backup/sla.ts', method: 'get', path: '/dashboard' },
  { tool: 'query_dr_plans', routeFile: 'dr.ts', method: 'get', path: '/plans' },
  { tool: 'get_dr_plan_details', routeFile: 'dr.ts', method: 'get', path: '/plans/:id' },
  { tool: 'get_dr_execution_status', routeFile: 'dr.ts', method: 'get', path: '/executions/:id' },
  { tool: 'query_c2c_connections', routeFile: 'c2c/connections.ts', method: 'get', path: '/connections' },
  { tool: 'query_c2c_jobs', routeFile: 'c2c/jobs.ts', method: 'get', path: '/jobs' },
  { tool: 'search_c2c_items', routeFile: 'c2c/items.ts', method: 'get', path: '/items' },
  { tool: 'get_browser_security', routeFile: 'browserSecurity.ts', method: 'get', path: '/extensions' },
  { tool: 'get_software_compliance', routeFile: 'softwarePolicies.ts', method: 'get', path: '/violations' },
  { tool: 'query_compliance_policies', routeFile: 'policyManagement/crud.ts', method: 'get', path: '/' },
  { tool: 'get_compliance_status', routeFile: 'policyManagement/compliance.ts', method: 'get', path: '/:id/compliance' },
  { tool: 'get_elevation_history', routeFile: 'pam.ts', method: 'get', path: '/elevation-requests' },
  { tool: 'get_peripheral_activity', routeFile: 'peripheralControl.ts', method: 'get', path: '/activity' },
  { tool: 'get_sensitive_data_overview', routeFile: 'sensitiveData.ts', method: 'get', path: '/scans' },
  { tool: 'get_user_risk_scores', routeFile: 'userRisk.ts', method: 'get', path: '/scores' },
  { tool: 'get_user_risk_detail', routeFile: 'userRisk.ts', method: 'get', path: '/users/:userId' },
  { tool: 'get_incident_timeline', routeFile: 'incidents.ts', method: 'get', path: '/:id' },
  { tool: 'generate_incident_report', routeFile: 'incidents.ts', method: 'get', path: '/:id/report' },
  { tool: 'query_analytics', action: 'capacity_predictions', routeFile: 'analytics.ts', method: 'get', path: '/capacity' },
  { tool: 'get_executive_summary', routeFile: 'analytics.ts', method: 'get', path: '/executive-summary' },
  { tool: 'list_monitors', routeFile: 'monitorDefinitions.ts', method: 'get', path: '/' },
  { tool: 'get_monitor', routeFile: 'monitorDefinitions.ts', method: 'get', path: '/:id' },
  { tool: 'get_ip_history', routeFile: 'devices/hardware.ts', method: 'get', path: '/:id/ip-history' },
  { tool: 'get_network_changes', routeFile: 'networkChanges.ts', method: 'get', path: '/' },
  {
    tool: 'list_remote_sessions',
    routeFile: 'remote/sessions.ts',
    method: 'get',
    path: '/sessions',
    // remote:access comes from the parent router (remote/index.ts), not the session route.
    parents: ['remote/index.ts'],
  },
  { tool: 'query_custom_fields', action: 'list_definitions', routeFile: 'customFields.ts', method: 'get', path: '/' },
  { tool: 'query_psa_status', routeFile: 'psa.ts', method: 'get', path: '/connections' },
  { tool: 'query_webhooks', routeFile: 'webhooks.ts', method: 'get', path: '/' },
  // includeDeliveries returns per-webhook delivery history, the data behind GET /:id/deliveries.
  { tool: 'query_webhooks', input: { includeDeliveries: true }, routeFile: 'webhooks.ts', method: 'get', path: '/:id/deliveries' },
  { tool: 'search_script_library', routeFile: 'scripts.ts', method: 'get', path: '/' },
  { tool: 'list_scripts', routeFile: 'scripts.ts', method: 'get', path: '/' },
  { tool: 'get_script_details', routeFile: 'scripts.ts', method: 'get', path: '/:id' },
  { tool: 'get_script_execution_history', routeFile: 'scripts.ts', method: 'get', path: '/:id/executions' },

  // Full-control W06 (#6776): every PSA configuration / ticket-ops action binds to the route a technician uses for the same act.
  { tool: 'manage_ticket_config', action: 'get_org_settings', routeFile: 'orgTicketSettings.ts', method: 'get', path: '/organizations/:id/ticket-settings' },
  { tool: 'manage_ticket_config', action: 'update_org_settings', routeFile: 'orgTicketSettings.ts', method: 'patch', path: '/organizations/:id/ticket-settings' },
  { tool: 'manage_ticket_config', action: 'list_categories', routeFile: 'ticketCategories.ts', method: 'get', path: '/' },
  { tool: 'manage_ticket_config', action: 'create_category', routeFile: 'ticketCategories.ts', method: 'post', path: '/' },
  { tool: 'manage_ticket_config', action: 'update_category', routeFile: 'ticketCategories.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_ticket_config', action: 'delete_category', routeFile: 'ticketCategories.ts', method: 'delete', path: '/:id' },
  { tool: 'manage_ticket_config', action: 'reorder_categories', routeFile: 'ticketCategories.ts', method: 'put', path: '/reorder' },
  { tool: 'manage_ticket_config', action: 'get_config', routeFile: 'ticketConfig.ts', method: 'get', path: '/' },
  { tool: 'manage_ticket_config', action: 'create_status', routeFile: 'ticketConfig.ts', method: 'post', path: '/statuses' },
  { tool: 'manage_ticket_config', action: 'update_status', routeFile: 'ticketConfig.ts', method: 'patch', path: '/statuses/:id' },
  { tool: 'manage_ticket_config', action: 'reorder_statuses', routeFile: 'ticketConfig.ts', method: 'post', path: '/statuses/reorder' },
  { tool: 'manage_ticket_config', action: 'set_priorities', routeFile: 'ticketConfig.ts', method: 'put', path: '/priorities' },
  { tool: 'manage_ticket_config', action: 'list_domains', routeFile: 'ticketConfig.ts', method: 'get', path: '/inbound-domains' },
  { tool: 'manage_ticket_config', action: 'create_domain', routeFile: 'ticketConfig.ts', method: 'post', path: '/inbound-domains' },
  { tool: 'manage_ticket_config', action: 'update_domain', routeFile: 'ticketConfig.ts', method: 'patch', path: '/inbound-domains/:id' },
  { tool: 'manage_ticket_config', action: 'delete_domain', routeFile: 'ticketConfig.ts', method: 'delete', path: '/inbound-domains/:id' },
  // The email-inbound LIST is gated on tickets:write (writePerm) like its mutations; the admin predicate is applied in the handler.
  { tool: 'manage_ticket_inbox', action: 'list', routeFile: 'ticketConfig.ts', method: 'get', path: '/email-inbound' },
  { tool: 'manage_ticket_inbox', action: 'convert', routeFile: 'ticketConfig.ts', method: 'post', path: '/email-inbound/:id/convert' },
  { tool: 'manage_ticket_inbox', action: 'dismiss', routeFile: 'ticketConfig.ts', method: 'patch', path: '/email-inbound/:id/dismiss' },
  { tool: 'manage_ticket_checklist_templates', action: 'list', routeFile: 'ticketChecklistTemplates.ts', method: 'get', path: '/' },
  { tool: 'manage_ticket_checklist_templates', action: 'get', routeFile: 'ticketChecklistTemplates.ts', method: 'get', path: '/:id' },
  { tool: 'manage_ticket_checklist_templates', action: 'create', routeFile: 'ticketChecklistTemplates.ts', method: 'post', path: '/' },
  { tool: 'manage_ticket_checklist_templates', action: 'update', routeFile: 'ticketChecklistTemplates.ts', method: 'patch', path: '/:id' },
  { tool: 'manage_ticket_checklist_templates', action: 'delete', routeFile: 'ticketChecklistTemplates.ts', method: 'delete', path: '/:id' },
  { tool: 'manage_ticket_checklist_templates', action: 'add_item', routeFile: 'ticketChecklistTemplates.ts', method: 'post', path: '/:id/items' },
  { tool: 'manage_ticket_checklist_templates', action: 'update_item', routeFile: 'ticketChecklistTemplates.ts', method: 'patch', path: '/items/:itemId' },
  { tool: 'manage_ticket_checklist_templates', action: 'remove_item', routeFile: 'ticketChecklistTemplates.ts', method: 'delete', path: '/items/:itemId' },
  { tool: 'manage_ticket_checklist_templates', action: 'reorder_items', routeFile: 'ticketChecklistTemplates.ts', method: 'post', path: '/:id/items/reorder' },
  // `list` has no REST twin of its own: attachments ride the ticket detail feed (GET /tickets/:id, tickets:read).
  { tool: 'manage_ticket_attachments', action: 'list', routeFile: 'tickets/tickets.ts', method: 'get', path: '/:id' },
  { tool: 'manage_ticket_attachments', action: 'read_content', routeFile: 'tickets/attachments.ts', method: 'get', path: '/:id/attachments/:attachmentId/content' },
  { tool: 'manage_ticket_attachments', action: 'attach_from_artifact', routeFile: 'tickets/attachments.ts', method: 'post', path: '/:id/attachments/from-artifact' },
  { tool: 'manage_ticket_attachments', action: 'delete', routeFile: 'tickets/attachments.ts', method: 'delete', path: '/:id/attachments/:attachmentId' },
  { tool: 'manage_ticket_forms', action: 'list', routeFile: 'tickets/forms.ts', method: 'get', path: '/ticket-forms' },
  { tool: 'manage_ticket_forms', action: 'available', routeFile: 'tickets/forms.ts', method: 'get', path: '/ticket-forms/available' },
  { tool: 'manage_ticket_forms', action: 'create', routeFile: 'tickets/forms.ts', method: 'post', path: '/ticket-forms' },
  { tool: 'manage_ticket_forms', action: 'update', routeFile: 'tickets/forms.ts', method: 'put', path: '/ticket-forms/:id' },
  { tool: 'manage_ticket_forms', action: 'delete', routeFile: 'tickets/forms.ts', method: 'delete', path: '/ticket-forms/:id' },
  { tool: 'manage_ticket_response_templates', action: 'list', routeFile: 'tickets/ticketResponseTemplates.ts', method: 'get', path: '/ticket-response-templates' },
  { tool: 'manage_ticket_response_templates', action: 'create', routeFile: 'tickets/ticketResponseTemplates.ts', method: 'post', path: '/ticket-response-templates' },
  { tool: 'manage_ticket_response_templates', action: 'update', routeFile: 'tickets/ticketResponseTemplates.ts', method: 'patch', path: '/ticket-response-templates/:id' },
  { tool: 'manage_ticket_response_templates', action: 'delete', routeFile: 'tickets/ticketResponseTemplates.ts', method: 'delete', path: '/ticket-response-templates/:id' },
  { tool: 'manage_time_suggestions', action: 'list', routeFile: 'timeEntries/suggestions.ts', method: 'get', path: '/' },
  { tool: 'manage_time_suggestions', action: 'confirm', routeFile: 'timeEntries/suggestions.ts', method: 'post', path: '/confirm' },
  { tool: 'manage_time_suggestions', action: 'dismiss', routeFile: 'timeEntries/suggestions.ts', method: 'post', path: '/dismiss' },
  { tool: 'manage_time_suggestions', action: 'undo', routeFile: 'timeEntries/suggestions.ts', method: 'delete', path: '/dismiss' },
  { tool: 'manage_tickets', action: 'bulk_update', routeFile: 'tickets/bulk.ts', method: 'post', path: '/bulk' },
  // Full-control W07 (#6777): alert correlation + signal triage. Each action binds to the route a technician uses for the same act.
  { tool: 'get_alert_correlations', routeFile: 'alerts/correlations.ts', method: 'get', path: '/correlations' },
  { tool: 'get_alert_correlations', routeFile: 'alerts/correlations.ts', method: 'get', path: '/correlations/evaluation' },
  { tool: 'get_alert_correlations', routeFile: 'alerts/correlations.ts', method: 'get', path: '/correlations/:groupId' },
  { tool: 'get_alert_correlations', routeFile: 'alerts/correlations.ts', method: 'post', path: '/correlations/:groupId/explain' },
  { tool: 'get_alert_correlations', routeFile: 'alerts/correlations.ts', method: 'get', path: '/:alertId/correlations' },
  { tool: 'get_alert_correlations', routeFile: 'alertTemplates/correlations.ts', method: 'get', path: '/correlations' },
  { tool: 'get_alert_correlations', routeFile: 'alertTemplates/correlations.ts', method: 'post', path: '/correlations/analyze' },
  { tool: 'manage_alert_correlations', action: 'acknowledge_group', routeFile: 'alerts/correlations.ts', method: 'post', path: '/correlations/:groupId/acknowledge' },
  { tool: 'manage_alert_correlations', action: 'resolve_group', routeFile: 'alerts/correlations.ts', method: 'post', path: '/correlations/:groupId/resolve' },
  { tool: 'manage_alert_correlations', action: 'acknowledge_related', routeFile: 'alerts/correlations.ts', method: 'post', path: '/:alertId/correlations/acknowledge' },
  // Both feedback routes are gated on alerts:read (not a write grant); the tool mirrors them exactly.
  { tool: 'manage_alert_correlations', action: 'feedback', routeFile: 'alerts/correlations.ts', method: 'post', path: '/correlations/:groupId/feedback' },
  { tool: 'manage_alert_correlations', action: 'rca_feedback', routeFile: 'alerts/correlations.ts', method: 'post', path: '/correlations/:groupId/rca-feedback' },
  { tool: 'manage_device_anomalies', action: 'list', routeFile: 'devices/anomalies.ts', method: 'get', path: '/:id/anomalies' },
  { tool: 'manage_device_anomalies', action: 'dismiss', routeFile: 'devices/anomalies.ts', method: 'patch', path: '/:id/anomalies/:anomalyId/status' },
  { tool: 'manage_device_anomalies', action: 'resolve', routeFile: 'devices/anomalies.ts', method: 'patch', path: '/:id/anomalies/:anomalyId/status' },
  { tool: 'manage_device_anomalies', action: 'promote', routeFile: 'devices/anomalies.ts', method: 'patch', path: '/:id/anomalies/:anomalyId/status' },
  // The reliability label route is gated on devices:read (requireReliabilityRead), like the reads.
  { tool: 'reliability_feedback', routeFile: 'reliability.ts', method: 'post', path: '/:deviceId/feedback' },
  { tool: 'get_fleet_health', routeFile: 'reliability.ts', method: 'get', path: '/' },
  { tool: 'get_fleet_health', routeFile: 'reliability.ts', method: 'get', path: '/evaluation' },
  { tool: 'get_fleet_health', routeFile: 'reliability.ts', method: 'get', path: '/org/:orgId/summary' },
  { tool: 'get_fleet_health', routeFile: 'reliability.ts', method: 'get', path: '/:deviceId/history' },
  { tool: 'get_fleet_health', routeFile: 'reliability.ts', method: 'get', path: '/:deviceId/offenders' },
];

/**
 * Pairs that CANNOT be bound mechanically, with the reason. Keep this short —
 * an entry here is a tool whose route evidence is still only a comment.
 */
const UNBOUND: ReadonlyArray<{ tool: string; action?: string; reason: string }> = [
  {
    tool: 'get_hyperv_vm_details',
    reason: 'two registrations (routes/backup/hyperv.ts:94 and :124) gate the same tool; the binder refuses an ambiguous method+path rather than picking one',
  },
  {
    tool: 'get_mssql_backup_status',
    reason: 'same shape as get_hyperv_vm_details — routes/backup/mssql.ts:94 and :127',
  },
  {
    tool: 'computer_control',
    reason: 'no single HTTP route: it rides an already-established remote session over the signalling channel, so its remote:access extra is inherited from create_remote_session rather than from a route of its own',
  },
  {
    tool: 'list_script_templates',
    reason: 'global template table with no matching HTTP route: no endpoint reads script_templates directly',
  },
  // Full-control W04 (#6758)
  {
    tool: 'request_elevation',
    reason: 'no human REST create route; requests are agent-ingested (routes/agents/elevationRequests.ts) or remediation-created',
  },
  {
    tool: 'trigger_agent_upgrade',
    reason: "no per-device REST upgrade route; agentRecovery.ts deliberately rejects update_agent ('a release decision, not a button'); upgrades are heartbeat/pin-driven",
  },
  {
    tool: 'manage_browser_policy',
    action: 'apply',
    reason: 'no REST twin: applying queues browser-policy deviceCommands from the AI tool only; it requires devices:execute (parity with apply_cis_remediation)',
  },
  {
    tool: 'query_agent_versions',
    action: 'list_versions',
    reason: 'reads the global agent_versions table (no tenant data, no matching read route); REST GET /agent-versions/ (agentVersions.ts:1232) is platform-admin only, a different audience than the tool',
  },
];

function routePermissionsFor(binding: Binding): string[] {
  const read = (rel: string) => readFileSync(join(ROUTES_DIR, rel), 'utf8');
  const own = routeRegistrationPermissions(read(binding.routeFile), binding.method, binding.path);
  if (own === null) {
    throw new Error(
      `${binding.method.toUpperCase()} ${binding.path} not found in routes/${binding.routeFile} — the route moved; re-point the binding`,
    );
  }
  const inherited = [
    ...routerLevelPermissions(read(binding.routeFile)),
    ...(binding.parents ?? []).flatMap((p) => routerLevelPermissions(read(p))),
  ];
  return [...new Set([...own, ...inherited])].sort();
}

function toolPermissionsFor(binding: Binding): string[] {
  const required = requiredPermissionsForTool(
    binding.tool,
    { ...(binding.input ?? {}), ...(binding.action ? { action: binding.action } : {}) },
  );
  if (required === null) {
    throw new Error(`no RBAC mapping for ${binding.tool}${binding.action ? `.${binding.action}` : ''}`);
  }
  return [...new Set(required.map((r) => `${r.resource}:${r.action}`))].sort();
}

const label = (b: Binding) =>
  `${b.tool}${b.action ? `.${b.action}` : ''}${b.input ? ` ${JSON.stringify(b.input)}` : ''}`;

describe('contract: every remapped AI tool requires what its HTTP route requires', () => {
  it('the binder actually resolves a permission for every pair (not vacuously empty)', () => {
    // Without this, a parser that silently returned [] for everything would
    // satisfy "route ⊆ tool" for the whole table.
    const empty = BINDINGS
      .filter((b) => routePermissionsFor(b).length === 0)
      .map(label);
    expect(empty).toEqual([]);
  });

  it.each(BINDINGS.map((b) => [label(b), b] as const))(
    '%s is never WEAKER than its route',
    (_name, binding) => {
      const route = routePermissionsFor(binding);
      const tool = toolPermissionsFor(binding);
      const missing = route.filter((p) => !tool.includes(p));
      // A failure here is the audit §2.5 bug class: the HTTP door refuses and
      // the chat door does not. Fix the mapping in aiGuardrails.ts — never the
      // expectation here, and never the route.
      expect(missing, `routes/${binding.routeFile} requires ${route.join(', ')}`).toEqual([]);
    },
  );

  it.each(BINDINGS.map((b) => [label(b), b] as const))(
    '%s declares any permission it requires BEYOND its route',
    (_name, binding) => {
      const route = routePermissionsFor(binding);
      const tool = toolPermissionsFor(binding);
      const surplus = tool.filter((p) => !route.includes(p));
      // Being stronger than the route is allowed; being stronger SILENTLY is
      // not — an undeclared surplus is indistinguishable from a route that
      // quietly lost a `requirePermission`.
      expect(surplus, binding.toolOnly?.reason ?? 'add a toolOnly entry with a reason')
        .toEqual([...(binding.toolOnly?.extra ?? [])].sort());
    },
  );

  it('every UNBOUND entry carries a real reason and is not silently bound anyway', () => {
    for (const entry of UNBOUND) {
      expect(entry.reason.length, `${entry.tool} needs a real reason`).toBeGreaterThan(40);
      expect(
        BINDINGS.some((b) => b.tool === entry.tool && b.action === entry.action),
        `${entry.tool} is both UNBOUND and bound — delete one`,
      ).toBe(false);
    }
  });
});

// --------------------------------------------------------- extractor fixtures
//
// String fixtures, not live routes: the extractor is the only thing standing
// between a re-gated route and a green suite, so its discrimination is proven
// on text a concurrent PR cannot change.

const FIXTURE = `
import { requirePermission } from '../middleware/permissions';
import { PERMISSIONS } from '../services/permissions';

export const fixtureRoutes = new Hono();
const requireFixtureRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireFixtureWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);

fixtureRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requireFixtureRead,
  // requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  zValidator('query', listSchema),
  async (c) => {
    const gate = 'requireFixtureWrite';
    return c.json({ requireFixtureWrite: true });
  },
);

fixtureRoutes.post(
  '/:id/move-org',
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  async (c) => c.json({}),
);

fixtureRoutes.get('/inline', requirePermission('backup', 'read'), async (c) => c.json({}));

fixtureRoutes.get('/ungated', requireScope('partner', 'system'), async (c) => c.json({}));
`;

const PARENT_FIXTURE = `
export const parentRoutes = new Hono();
parentRoutes.use('*', requirePermission(PERMISSIONS.REMOTE_ACCESS.resource, PERMISSIONS.REMOTE_ACCESS.action), requireMfa());
parentRoutes.route('/sessions', sessionRoutes);
`;

describe('extractor: route-registration permission parsing', () => {
  it('resolves a same-file ALIAS one level down to its real grant', () => {
    expect(routeRegistrationPermissions(FIXTURE, 'get', '/')).toEqual(['devices:read']);
  });

  it('collects BOTH requirePermission calls on a two-gate route', () => {
    expect(routeRegistrationPermissions(FIXTURE, 'post', '/:id/move-org'))
      .toEqual(['tickets:write', 'organizations:write']);
  });

  it('reads the inline literal form', () => {
    expect(routeRegistrationPermissions(FIXTURE, 'get', '/inline')).toEqual(['backup:read']);
  });

  it('reports an empty set — not a match failure — for a scope-only route', () => {
    expect(routeRegistrationPermissions(FIXTURE, 'get', '/ungated')).toEqual([]);
  });

  it('returns null when the method+path is not registered at all', () => {
    expect(routeRegistrationPermissions(FIXTURE, 'delete', '/')).toBeNull();
    expect(routeRegistrationPermissions(FIXTURE, 'get', '/nope')).toBeNull();
  });

  it('ignores a gate named only in a COMMENT or a STRING inside the handler', () => {
    // The whole reason the source is comment-blanked and the middleware slice
    // stops at the handler: `/` mentions ORGS_WRITE in a comment and
    // `requireFixtureWrite` twice in the body, and must still be devices:read.
    expect(routeRegistrationPermissions(FIXTURE, 'get', '/')).toEqual(['devices:read']);
  });

  it('does not confuse a path PREFIX with the path', () => {
    // `'/'` must not match `'/inline'` or `'/:id/move-org'`.
    expect(routeRegistrationPermissions(FIXTURE, 'get', '/')).toHaveLength(1);
  });

  it('picks up a router-level `use(\'*\')` gate', () => {
    expect(routerLevelPermissions(PARENT_FIXTURE)).toEqual(['remote:access']);
    expect(routerLevelPermissions(FIXTURE)).toEqual([]);
  });

  it('throws on an unrecognised requirePermission form rather than returning nothing', () => {
    // Silently returning [] here would make every affected pair pass
    // "route ⊆ tool" vacuously — the exact failure mode that kills a scanner.
    expect(() => routeRegistrationPermissions(
      `r.get('/x', requirePermission(resolveResource(), 'read'), async (c) => c.json({}));`,
      'get',
      '/x',
    )).toThrow(/unrecognised requirePermission/);
  });

  it('rejects an unknown PERMISSIONS key instead of inventing a grant', () => {
    expect(() => permissionFromRequireArgs('PERMISSIONS.NOT_A_GRANT.resource, PERMISSIONS.NOT_A_GRANT.action'))
      .toThrow(/not in the canonical catalog/);
  });

  it('throws when the same method+path is registered twice (ambiguous binding)', () => {
    const dup = `
      r.get('/dup', requirePermission('devices', 'read'), async (c) => c.json({}));
      r.get('/dup', requirePermission('devices', 'write'), async (c) => c.json({}));
    `;
    expect(() => routeRegistrationPermissions(dup, 'get', '/dup')).toThrow(/registered 2 times/);
  });

  it('finds the aliases a file declares', () => {
    expect([...permissionAliases(blankComments(FIXTURE))]).toEqual([
      ['requireFixtureRead', 'devices:read'],
      ['requireFixtureWrite', 'devices:write'],
    ]);
  });
});
