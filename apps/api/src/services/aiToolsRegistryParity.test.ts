import { describe, it, expect } from 'vitest';
import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS } from './aiGuardrails';

describe('aiTools registry parity', () => {
  const toolNames = Array.from(aiTools.keys());

  // Pre-existing registered tools missing schemas/permissions; tracked as known debt for a separate follow-up.
  //
  // These are not cosmetic: both gates fail closed, so a listed tool is dead on
  // every surface that dispatches it — the chat MCP server AND the external
  // /api/v1/mcp server, which advertises the whole registry via
  // getToolDefinitions(). That is how the configuration-policy tools stayed
  // broken through #2814. The two staleness tests at the bottom of this file
  // stop a fixed tool from silently keeping its exemption.
  const legacySchemaGaps = new Set([
    'query_analytics',
    'get_executive_summary',
    'query_webhooks',
    'query_psa_status',
    'test_webhook',
    'manage_tags',
    'query_custom_fields',
    'get_browser_security',
    'manage_browser_policy',
    'manage_scheduled_tasks',
    'registry_operations',
    'query_compliance_policies',
    'get_compliance_status',
    'manage_notification_channels',
    'create_incident',
    'execute_containment',
    'collect_evidence',
    'get_incident_timeline',
    'generate_incident_report',
    'search_documentation',
    'list_remote_sessions',
    'create_remote_session',
    'query_agent_versions',
    'trigger_agent_upgrade',
    'trigger_agent_restart',
    'manage_saved_filters',
  ]);

  // Pre-existing registered tools missing schemas/permissions; tracked as known debt for a separate follow-up.
  const legacyPermissionGaps = new Set([
    'get_network_changes',
    'acknowledge_network_device',
    'configure_network_baseline',
    'get_ip_history',
    'get_sensitive_data_overview',
    'remediate_sensitive_data',
    'get_dns_security',
    'manage_dns_policy',
    'get_peripheral_activity',
    'manage_peripheral_policy',
    'get_browser_security',
    'manage_browser_policy',
    'get_software_compliance',
    'manage_software_policy',
    'remediate_software_violation',
    'create_incident',
    'execute_containment',
    'collect_evidence',
    'get_incident_timeline',
    'generate_incident_report',
    'get_active_users',
    'get_user_experience_metrics',
    'request_elevation',
    'revoke_elevation',
    'get_elevation_history',
  ]);

  it('every registered tool has a Zod input schema, except tracked legacy gaps', () => {
    const missing = toolNames.filter(name => !(name in toolInputSchemas));
    const untracked = missing.filter(name => !legacySchemaGaps.has(name));
    expect(untracked, `Tools missing from toolInputSchemas: ${untracked.join(', ')}`).toEqual([]);
  });

  it('every registered tool has a TOOL_PERMISSIONS RBAC entry, except tracked legacy gaps', () => {
    const missing = toolNames.filter(name => !(name in TOOL_PERMISSIONS));
    const untracked = missing.filter(name => !legacyPermissionGaps.has(name));
    expect(untracked, `Tools missing from TOOL_PERMISSIONS: ${untracked.join(', ')}`).toEqual([]);
  });

  // Both exemption lists above are `.filter()`ed out of the MISSING set, so a
  // tool that later gets its schema/permission keeps its exemption forever and
  // the list quietly stops describing reality. These two tests are what make
  // the lists shrink-only (#2814).
  it('keeps legacySchemaGaps honest — every entry is still missing a schema', () => {
    const stale = Array.from(legacySchemaGaps).filter(name => name in toolInputSchemas);
    expect(stale, `Now have schemas — drop from legacySchemaGaps: ${stale.join(', ')}`).toEqual([]);
  });

  it('keeps legacyPermissionGaps honest — every entry is still missing a permission', () => {
    const stale = Array.from(legacyPermissionGaps).filter(name => name in TOOL_PERMISSIONS);
    expect(stale, `Now have permissions — drop from legacyPermissionGaps: ${stale.join(', ')}`).toEqual([]);
  });

  // Neither list may name a tool that no longer exists in the registry, which
  // would otherwise mask a rename.
  it('neither exemption list names an unregistered tool', () => {
    const registered = new Set(toolNames);
    const unknown = [...legacySchemaGaps, ...legacyPermissionGaps].filter(name => !registered.has(name));
    expect(unknown, `Not in the aiTools registry: ${unknown.join(', ')}`).toEqual([]);
  });
});
