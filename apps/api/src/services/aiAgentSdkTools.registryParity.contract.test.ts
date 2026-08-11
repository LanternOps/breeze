/**
 * Contract test pinning the `aiTools` registry against `TOOL_TIERS` (#3300).
 *
 * `TOOL_TIERS` gates chat visibility twice over:
 *
 *   - `BREEZE_MCP_TOOL_NAMES = Object.keys(TOOL_TIERS)` is the `allowedTools`
 *     list handed to the SDK.
 *   - `createSessionPreToolUse` rejects `!TOOL_TIERS[toolName]` as
 *     "Unknown tool".
 *
 * So the two maps have to agree, and they drift in BOTH directions:
 *
 *   - Registered but untiered → a working, fully-tested tool that chat says
 *     does not exist. 86 tools are in this state today.
 *   - Tiered but unregistered → a name advertised to the SDK as callable that
 *     then fails at execution. 4 entries are in this state today.
 *
 * This is the #2605 drift class. Nothing failed CI when it happened, which is
 * why it reached 86. This suite is the durable half of #3300: it does not fix
 * the existing gap (assigning a tier is an approval-gate decision, made
 * deliberately per tool — see the issue), it stops the gap GROWING. The two
 * allowlists below are frozen snapshots that may only ever shrink, and the
 * last test in each block enforces that by failing on a stale entry.
 *
 * NOTE: no vi.mock — this suite needs the REAL registry, same rationale as
 * aiGuardrails.readonly.contract.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { TOOL_TIERS } from './aiAgentSdkTools';
import { getAllRegisteredToolNames, getToolTier } from './aiTools';

/**
 * Registered tools with no `TOOL_TIERS` entry, and therefore invisible to
 * chat. Frozen as of #3300 (measured against f400fc315: 215 registered, 133
 * tiered, 86 missing).
 *
 * **This list may only shrink.** Removing a name means the tool was given a
 * tier and is now reachable. Adding one means a new tool shipped mute, which
 * is exactly what this file exists to prevent — fix the tool, don't widen the
 * list.
 */
const KNOWN_MISSING_TOOL_TIERS: ReadonlySet<string> = new Set([
  'acknowledge_network_device',
  'assign_security_training',
  'browse_snapshots',
  'collect_evidence',
  'configure_backup_sla',
  'configure_network_baseline',
  'configure_vault',
  'create_incident',
  'create_remote_session',
  'execute_containment',
  'execute_dr_plan',
  'generate_incident_report',
  'get_backup_status',
  'get_browser_security',
  'get_compliance_status',
  'get_dr_execution_status',
  'get_dr_plan_details',
  'get_elevation_history',
  'get_executive_summary',
  'get_hyperv_vm_details',
  'get_incident_timeline',
  'get_ip_history',
  'get_mssql_backup_status',
  'get_network_changes',
  'get_peripheral_activity',
  'get_sensitive_data_overview',
  'get_sla_breaches',
  'get_sla_compliance_report',
  'get_software_compliance',
  'get_user_risk_detail',
  'get_user_risk_scores',
  'get_vault_status',
  'get_vm_restore_estimate',
  'instant_boot_vm',
  'list_remote_sessions',
  'manage_backup_profiles',
  'manage_browser_policy',
  'manage_catalog',
  'manage_dr_plan',
  'manage_hyperv_checkpoints',
  'manage_hyperv_vm',
  'manage_notification_channels',
  'manage_peripheral_policy',
  'manage_processes',
  'manage_quotes',
  'manage_saved_filters',
  'manage_scheduled_tasks',
  'manage_software_policy',
  'manage_tags',
  'manage_tickets',
  'query_agent_versions',
  'query_analytics',
  'query_backup_sla',
  'query_backups',
  'query_c2c_connections',
  'query_c2c_jobs',
  'query_compliance_policies',
  'query_custom_fields',
  'query_dr_plans',
  'query_hyperv_vms',
  'query_mssql_instances',
  'query_psa_status',
  'query_vaults',
  'query_webhooks',
  'registry_operations',
  'remediate_sensitive_data',
  'remediate_software_violation',
  'request_elevation',
  'restore_as_vm',
  'restore_c2c_items',
  'restore_hyperv_vm',
  'restore_mssql_database',
  'restore_snapshot',
  'revoke_elevation',
  'search_c2c_items',
  'search_documentation',
  'search_script_library',
  'test_webhook',
  'trigger_agent_restart',
  'trigger_agent_upgrade',
  'trigger_backup',
  'trigger_c2c_sync',
  'trigger_hyperv_backup',
  'trigger_mssql_backup',
  'trigger_vault_sync',
  'verify_mssql_backup',
]);

/**
 * `TOOL_TIERS` keys with no registry entry. These are advertised to the SDK
 * via `BREEZE_MCP_TOOL_NAMES` and then fail at execution rather than being
 * absent from the tool list.
 *
 * Left in place rather than deleted because any of them may be a rename that
 * is still landing. **This list may only shrink** — either the tool gets
 * registered or the dead entry gets removed.
 */
const KNOWN_UNREGISTERED_TOOL_TIERS: ReadonlySet<string> = new Set([
  'get_backup_health',
  'get_recovery_readiness',
  'propose_action_plan',
  'run_backup_verification',
]);

describe('aiTools registry ⊆ TOOL_TIERS — a registered tool must be reachable from chat (#3300)', () => {
  it('every registered tool has a TOOL_TIERS entry, or is a known pre-existing gap', () => {
    const undeclared = getAllRegisteredToolNames()
      .filter((name) => !(name in TOOL_TIERS))
      .filter((name) => !KNOWN_MISSING_TOOL_TIERS.has(name))
      .sort();

    expect(
      undeclared,
      'These tools are registered but have no TOOL_TIERS entry, so the AI chat ' +
        'will tell users the capability does not exist. Add a tier to TOOL_TIERS ' +
        '(agreeing with the tool\'s registered tier) rather than adding the name ' +
        'to KNOWN_MISSING_TOOL_TIERS.',
    ).toEqual([]);
  });

  it('KNOWN_MISSING_TOOL_TIERS contains no stale entries — the list may only shrink', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const resolved = [...KNOWN_MISSING_TOOL_TIERS]
      .filter((name) => name in TOOL_TIERS || !registered.has(name))
      .sort();

    expect(
      resolved,
      'These names are in KNOWN_MISSING_TOOL_TIERS but are no longer missing ' +
        '(they now have a tier, or are no longer registered). Delete them from ' +
        'the allowlist so it keeps shrinking toward empty.',
    ).toEqual([]);
  });
});

describe('TOOL_TIERS ⊆ aiTools registry — an advertised tool must be executable (#3300)', () => {
  it('every TOOL_TIERS key is a registered tool, or is a known dead entry', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const unbacked = Object.keys(TOOL_TIERS)
      .filter((name) => !registered.has(name))
      .filter((name) => !KNOWN_UNREGISTERED_TOOL_TIERS.has(name))
      .sort();

    expect(
      unbacked,
      'These names are in TOOL_TIERS — and therefore in BREEZE_MCP_TOOL_NAMES, ' +
        'the allowedTools list handed to the SDK — but no tool is registered ' +
        'under them, so a call fails at execution instead of the tool simply ' +
        'not being offered. Register the tool or drop the entry.',
    ).toEqual([]);
  });

  it('KNOWN_UNREGISTERED_TOOL_TIERS contains no stale entries — the list may only shrink', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const resolved = [...KNOWN_UNREGISTERED_TOOL_TIERS]
      .filter((name) => registered.has(name) || !(name in TOOL_TIERS))
      .sort();

    expect(
      resolved,
      'These names are in KNOWN_UNREGISTERED_TOOL_TIERS but are no longer dead ' +
        '(now registered, or the TOOL_TIERS entry was removed). Delete them from ' +
        'the allowlist.',
    ).toEqual([]);
  });
});

describe('TOOL_TIERS agrees with the registry tier (#3300)', () => {
  it('every shared name carries the same tier in both maps', () => {
    // Presence alone is not the contract worth pinning. A tool that is present
    // but carries a LOWER tier than the registry assigned it has had its
    // approval gate quietly weakened — strictly worse than being invisible,
    // and invisible is the bug being tracked. This held for all 133 shared
    // names when the suite was written, so it starts with no allowlist.
    const disagreements = Object.keys(TOOL_TIERS)
      .filter((name) => !KNOWN_UNREGISTERED_TOOL_TIERS.has(name))
      .map((name) => ({
        name,
        declared: TOOL_TIERS[name as keyof typeof TOOL_TIERS],
        registered: getToolTier(name),
      }))
      .filter((row) => row.declared !== row.registered)
      .map((row) => `${row.name}: TOOL_TIERS=${row.declared} registry=${row.registered}`)
      .sort();

    expect(
      disagreements,
      'TOOL_TIERS disagrees with the tier the tool was registered at. The ' +
        'registry is the source of truth for what the tool actually does; a ' +
        'lower tier here silently downgrades its approval gate.',
    ).toEqual([]);
  });
});
