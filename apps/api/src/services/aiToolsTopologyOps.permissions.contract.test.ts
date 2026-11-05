import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requiredPermissionsForTool } from './aiGuardrails';
import { topologyPermissionPairs, type TopologyCapability } from './topology/permissionPairs';

/**
 * W08 (#6778) route parity for the topology tools. The topology routes gate on `requireTopologySiteCapability(...)`
 * (not `requirePermission`), so `aiGuardrails.routeBinding.contract.test.ts` cannot parse them. This contract does
 * the same job from the other side: it reads each route's capability from the route SOURCE and requires the tool's
 * resolved permission set (`requiredPermissionsForTool` — what checkToolPermission and approver eligibility read)
 * to include the WHOLE capability floor (`topologyPermissionPairs`). A tool may be stronger than its route; never
 * weaker.
 */
const ROUTES = join(fileURLToPath(new URL('..', import.meta.url)), 'routes', 'topology');
const read = (file: string) => readFileSync(join(ROUTES, file), 'utf8');

type Row = { tool: string; action: string; file: string; method: 'get' | 'post' | 'patch' | 'delete'; path: string; capability: TopologyCapability | 'library' };

/** Tool action -> the route registration it mirrors. 'library' = authorised in the service (topology + devices pair by read/write). */
const ROWS: Row[] = [
  { tool: 'get_topology_graph', action: 'graph', file: 'graphs.ts', method: 'get', path: '/graph`', capability: 'read' },
  { tool: 'get_topology_graph', action: 'nodes', file: 'graphs.ts', method: 'get', path: '/nodes`', capability: 'read' },
  { tool: 'get_topology_graph', action: 'health', file: 'graphs.ts', method: 'get', path: '/health`', capability: 'read' },
  { tool: 'run_topology_diagnostic', action: 'collectors', file: 'diagnostics.ts', method: 'get', path: '/collectors`', capability: 'read' },
  { tool: 'run_topology_diagnostic', action: 'get', file: 'diagnostics.ts', method: 'get', path: '/diagnostic-runs/:runId`', capability: 'read' },
  { tool: 'run_topology_diagnostic', action: 'start', file: 'diagnostics.ts', method: 'post', path: '/diagnostic-runs`', capability: 'execute' },
  { tool: 'run_topology_diagnostic', action: 'cancel', file: 'diagnostics.ts', method: 'post', path: '/diagnostic-runs/:runId/cancel`', capability: 'execute' },
  { tool: 'manage_topology_manual', action: 'create_node', file: 'manual.ts', method: 'post', path: '/manual-nodes`', capability: 'write' },
  { tool: 'manage_topology_manual', action: 'delete_relationship', file: 'manual.ts', method: 'delete', path: '/manual-relationships/:relationshipId`', capability: 'write' },
  { tool: 'manage_topology_monitoring', action: 'list_policies', file: 'policies.ts', method: 'get', path: 'base,', capability: 'read' },
  { tool: 'manage_topology_monitoring', action: 'upsert_policy', file: 'policies.ts', method: 'post', path: 'base,', capability: 'configure' },
  { tool: 'manage_topology_monitoring', action: 'delete_policy', file: 'policies.ts', method: 'delete', path: '`${base}/:id`', capability: 'configure' },
  { tool: 'manage_topology_monitoring', action: 'upsert_target', file: 'targets.ts', method: 'post', path: 'base,', capability: 'configure' },
  { tool: 'manage_topology_monitoring', action: 'delete_target', file: 'targets.ts', method: 'delete', path: '`${base}/:id`', capability: 'configure' },
  { tool: 'manage_topology_monitoring', action: 'get_settings', file: 'settings.ts', method: 'get', path: "'/sites/:siteId/settings'", capability: 'read' },
  { tool: 'manage_topology_monitoring', action: 'patch_settings', file: 'settings.ts', method: 'patch', path: "'/sites/:siteId/settings'", capability: 'write' },
  { tool: 'manage_topology_templates', action: 'site_options', file: 'templates.ts', method: 'get', path: "'/sites/:siteId/template-options'", capability: 'read' },
  { tool: 'manage_topology_templates', action: 'list_templates', file: 'templates.ts', method: 'get', path: "'/templates'", capability: 'library' },
  { tool: 'manage_topology_templates', action: 'publish_version', file: 'templates.ts', method: 'post', path: "'/templates/:templateId/versions/:versionId/publish'", capability: 'library' },
  { tool: 'apply_topology_template', action: 'preview', file: 'templateApplications.ts', method: 'post', path: "'/template-applications/preview'", capability: 'library' },
  { tool: 'apply_topology_template', action: 'apply', file: 'templateApplications.ts', method: 'post', path: "'/template-applications'", capability: 'library' },
];

const key = (p: { resource: string; action: string }) => `${p.resource}:${p.action}`;

/** The capability literal the registration is guarded by, read from the route source. */
function routeCapability(row: Row): TopologyCapability | 'library' {
  const src = read(row.file);
  // Registrations in source order: `<router>.<method>(` ... up to the next registration.
  const parts = src.split(/\b\w+Routes\.(?=(?:get|post|patch|delete)\()/).slice(1);
  const chunk = parts.find((part) => part.startsWith(`${row.method}(`) && part.slice(0, 160).includes(row.path));
  expect(chunk, `${row.file} has no ${row.method} registration containing ${row.path}`).toBeDefined();
  if (/topologyLibraryPermissions/.test(chunk!)) return 'library';
  const inline = /requireTopologySiteCapability\('(\w+)'\)/.exec(chunk!);
  if (inline) return inline[1] as TopologyCapability;
  // A file-level alias (`const authorized = requireTopologySiteCapability('read')`, `const write = …`) used in the chunk.
  for (const alias of chunk!.slice(0, 200).matchAll(/\b(authorized|write)\b/g)) {
    const decl = new RegExp(`const ${alias[1]} = requireTopologySiteCapability\\('(\\w+)'\\)`).exec(src);
    if (decl) return decl[1] as TopologyCapability;
  }
  throw new Error(`no capability found for ${row.method} ${row.path} in ${row.file}`);
}

describe('W08 topology tools: capability floor mirrors the route', () => {
  it.each(ROWS)('$tool:$action reads the route capability and carries its whole floor', (row) => {
    const fromRoute = routeCapability(row);
    expect(fromRoute, `${row.tool}:${row.action} declared ${row.capability} but the route says ${fromRoute}`).toBe(row.capability);

    const resolved = requiredPermissionsForTool(row.tool, { action: row.action });
    expect(resolved, `${row.tool}:${row.action} resolved no permissions`).not.toBeNull();
    const have = new Set(resolved!.map(key));
    const floor: Array<readonly [string, string]> = fromRoute === 'library'
      // assertTopologyTemplateAccess: topology + devices, read for a read and write for a write.
      ? (/^(list_|site_options|status)/.test(row.action)
        ? [['topology', 'read'], ['devices', 'read']]
        : [['topology', 'write'], ['devices', 'write'], ['devices', 'read']])
      : topologyPermissionPairs(fromRoute);
    for (const [resource, action] of floor) {
      expect(have.has(`${resource}:${action}`), `${row.tool}:${row.action} is missing ${resource}:${action}`).toBe(true);
    }
  });

  it('every action of every W08 tool resolves to a permission (no action falls through to nothing)', () => {
    const actions: Record<string, string[]> = {
      get_topology_graph: ['graph', 'nodes', 'node', 'relationship', 'evidence', 'group_members', 'expansion', 'health'],
      run_topology_diagnostic: ['collectors', 'start', 'get', 'cancel'],
      manage_topology_manual: ['create_node', 'update_node', 'delete_node', 'create_relationship', 'delete_relationship'],
      manage_topology_monitoring: ['list_policies', 'upsert_policy', 'delete_policy', 'list_targets', 'upsert_target', 'delete_target', 'get_settings', 'patch_settings'],
      manage_topology_templates: ['list_templates', 'create_template', 'update_template', 'revoke_template', 'list_versions', 'create_version', 'publish_version', 'site_options'],
      apply_topology_template: ['preview', 'apply', 'status'],
    };
    for (const [tool, list] of Object.entries(actions)) {
      for (const action of list) {
        expect(requiredPermissionsForTool(tool, { action }), `${tool}:${action}`).not.toBeNull();
      }
    }
  });

  it('guard-flip: a tool that dropped the devices:execute extra would fail the floor check', () => {
    const resolved = requiredPermissionsForTool('run_topology_diagnostic', { action: 'start' })!.map(key);
    expect(resolved).toContain('devices:execute');
    const withoutExtra = resolved.filter((p) => p !== 'devices:execute');
    const floor = topologyPermissionPairs('execute').map(([r, a]) => `${r}:${a}`);
    expect(floor.every((p) => withoutExtra.includes(p))).toBe(false); // the control: the check can go red
  });
});
