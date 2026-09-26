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

  // §2.5 — backup / Hyper-V / MSSQL reads.
  { tool: 'query_backups', routeFile: 'backup/jobs.ts', method: 'get', path: '/jobs' },
  { tool: 'browse_snapshots', routeFile: 'backup/snapshots.ts', method: 'get', path: '/snapshots/:id/browse' },
  { tool: 'get_vm_restore_estimate', routeFile: 'backup/vmrestore.ts', method: 'get', path: '/backup/restore/as-vm/estimate/:snapshotId' },
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
  { tool: 'manage_ticket_checklist', action: 'list_templates', routeFile: 'ticketChecklistTemplates.ts', method: 'get', path: '/' },
  { tool: 'manage_ticket_checklist', action: 'get_template', routeFile: 'ticketChecklistTemplates.ts', method: 'get', path: '/:id' },

  // §2.5 — the per-action extra-permission map.
  { tool: 'manage_tickets', action: 'move_org', routeFile: 'tickets/moveOrg.ts', method: 'post', path: '/:id/move-org' },

  // §2.4 — a registry read is an agent EXECUTION (SR5-01 precedent).
  { tool: 'registry_operations', action: 'read_key', routeFile: 'devices/commands.ts', method: 'post', path: '/:id/commands' },

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

  // Spec 2026-09-23 W01 (#6755): route-binding rows for the read tools newly
  // wired into TOOL_TIERS on this branch. Each pair below already matched its
  // route's permission when checked by hand; this pins that with a mechanical
  // read, same as every other row in this table.
  {
    tool: 'list_remote_sessions',
    routeFile: 'remote/sessions.ts',
    method: 'get',
    path: '/sessions',
    parents: ['remote/index.ts'],
  },
  { tool: 'search_script_library', routeFile: 'scripts.ts', method: 'get', path: '/' },
  { tool: 'get_software_compliance', routeFile: 'softwarePolicies.ts', method: 'get', path: '/violations' },
  { tool: 'query_compliance_policies', routeFile: 'policyManagement/crud.ts', method: 'get', path: '/' },
  { tool: 'get_elevation_history', routeFile: 'pam.ts', method: 'get', path: '/elevation-requests' },
  { tool: 'get_peripheral_activity', routeFile: 'peripheralControl.ts', method: 'get', path: '/activity' },
  { tool: 'get_user_risk_scores', routeFile: 'userRisk.ts', method: 'get', path: '/scores' },
  { tool: 'get_user_risk_detail', routeFile: 'userRisk.ts', method: 'get', path: '/users/:userId' },
  { tool: 'get_backup_status', routeFile: 'backup/jobs.ts', method: 'get', path: '/jobs/:id' },
  { tool: 'query_backup_sla', routeFile: 'backup/sla.ts', method: 'get', path: '/configs' },
  { tool: 'get_sla_breaches', routeFile: 'backup/sla.ts', method: 'get', path: '/events' },
  { tool: 'get_sla_compliance_report', routeFile: 'backup/sla.ts', method: 'get', path: '/dashboard' },
  { tool: 'query_c2c_jobs', routeFile: 'c2c/jobs.ts', method: 'get', path: '/jobs' },
  { tool: 'search_c2c_items', routeFile: 'c2c/items.ts', method: 'get', path: '/items' },
  { tool: 'get_ip_history', routeFile: 'devices/hardware.ts', method: 'get', path: '/:id/ip-history' },
  { tool: 'get_network_changes', routeFile: 'networkChanges.ts', method: 'get', path: '/' },
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

  // Spec 2026-09-23 W01 (#6755): read tools newly wired into TOOL_TIERS on
  // this branch that have no single REST route a permission can be bound to.
  {
    tool: 'query_agent_versions',
    reason: 'no route mirrors the tool\'s list_versions/check_upgrades actions with a single permission: the closest registrations (GET /agent-versions/pinnable, GET /agent-versions) gate on scope or a platform-admin check rather than a requirePermission call, so no route permission set resolves',
  },
  {
    tool: 'query_webhooks',
    reason: 'GET /webhooks gates only on requireScope, with no requirePermission call at all; there is no route permission set to bind the tool\'s devices:read requirement against',
  },
  {
    tool: 'query_analytics',
    reason: 'the tool\'s three actions (sla_compliance, capacity_predictions, sla_definitions) read separate tables with no single corresponding REST route, while TOOL_PERMISSIONS declares one flat grant for the whole tool, so no single route registration can be bound',
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
    binding.action ? { action: binding.action } : {},
  );
  if (required === null) {
    throw new Error(`no RBAC mapping for ${binding.tool}${binding.action ? `.${binding.action}` : ''}`);
  }
  return [...new Set(required.map((r) => `${r.resource}:${r.action}`))].sort();
}

const label = (b: Binding) => `${b.tool}${b.action ? `.${b.action}` : ''}`;

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
