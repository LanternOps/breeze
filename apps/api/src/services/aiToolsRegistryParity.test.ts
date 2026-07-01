import { describe, it, expect } from 'vitest';
import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS } from './aiGuardrails';

describe('aiTools registry parity', () => {
  const toolNames = Array.from(aiTools.keys());

  const legacySchemaGaps = new Set([
    'query_analytics',
    'get_executive_summary',
    'manage_update_rings',
    'manage_software_policies',
    'manage_peripheral_policies',
    'manage_backup_configs',
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

  const legacyPermissionGaps = new Set([
    'manage_update_rings',
    'manage_software_policies',
    'manage_peripheral_policies',
    'manage_backup_configs',
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
});
