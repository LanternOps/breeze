/**
 * Curated tool profiles for small-context models (#11393 W01, spec
 * 2026-11-06-small-model-tool-profiles §3.1). Each list is a SUBSET filter:
 * `resolveToolExposure` intersects it with what a surface already registers,
 * so a name here never adds a tool to a surface that does not have it.
 *
 * `minimal` is read-only, literally: every registry tool in a `minimal` list
 * has base tier 1 and no action in TIER2_ACTIONS / TIER3_ACTIONS /
 * MFA_GATED_TOOL_ACTIONS (pinned by toolProfiles.contract.test.ts). The only
 * tier-2 name a `minimal` chat session carries is `set_device_context`, kept
 * by the resolver's always-keep rule, outside these lists.
 *
 * No AI tool is added by this feature; every name here is already declared.
 */
import type { AiSurface } from '@breeze/shared';

export type ConstrainedProfile = 'minimal' | 'standard';
export type ProfiledSurface = 'chat' | 'helper' | 'script_builder' | 'ai_agents' | 'office_chat';
export const PROFILED_SURFACES: readonly ProfiledSurface[] = ['chat', 'helper', 'script_builder', 'ai_agents', 'office_chat'];

export function isProfiledSurface(surface: AiSurface): surface is ProfiledSurface {
  return (PROFILED_SURFACES as readonly string[]).includes(surface);
}

/** Chat `minimal`: plan Decision 5, exactly these 12 (plus `set_device_context` by the always-keep rule). */
export const CHAT_MINIMAL_TOOLS = [
  'query_devices',
  'get_device_details',
  'get_device_health',
  'get_device_hardware_health',
  'get_fleet_health',
  'get_alert_correlations',
  'search_logs',
  'analyze_metrics',
  'query_audit_log',
  'search_documentation',
  'list_organizations',
  'get_org_summary',
] as const;

/** Chat `standard`: minimal + the everyday helpdesk set, including supervised (tier 2/3) actions. */
export const CHAT_STANDARD_TOOLS = [
  ...CHAT_MINIMAL_TOOLS,
  'resolve_device_context',
  'manage_alerts',
  'manage_alert_rules',
  'manage_tickets',
  'list_scripts',
  'get_script_details',
  'run_script',
  'manage_services',
  'manage_patches',
  'get_security_posture',
  'get_vulnerability_report',
  'browse_device_event_log',
  'manage_delivery',
  'analyze_disk_usage',
  'get_active_users',
  'get_device_events',
  'get_device_software',
  'get_device_context',
  'find_proven_fixes',
  'list_sites',
  'get_script_execution',
  'get_script_execution_history',
  'execute_command',
  'manage_processes',
  'get_backup_status',
  'get_device_vulnerabilities',
  'file_operations',
  'take_screenshot',
  'disk_cleanup',
] as const;

/** Helper: single-device reads. Intersected at runtime with the level's list (`getHelperAllowedTools`). */
const HELPER_MINIMAL_TOOLS = [
  'get_device_details',
  'get_device_hardware_health',
  'get_device_time_status',
  'query_device_workloads',
  'list_time_sync_issues',
  'analyze_metrics',
  'analyze_disk_usage',
  'get_security_posture',
  'search_logs',
  'get_active_users',
  'get_user_experience_metrics',
] as const;

const HELPER_STANDARD_TOOLS = [
  ...HELPER_MINIMAL_TOOLS,
  'get_cis_device_report',
  'take_screenshot',
  'analyze_screen',
  'manage_alerts',
  'manage_services',
  'disk_cleanup',
  'file_operations',
  'execute_command',
] as const;

/**
 * Script builder: bare `SCRIPT_BUILDER_TOOL_TIERS` keys. `minimal` has no
 * `execute_script_on_device`, so the surface's floor refuses it
 * (`SURFACE_REQUIRED_TOOLS.script_builder`): a read-only profile cannot test
 * a script, and the operator is told to widen it rather than given a builder
 * that silently cannot run anything.
 */
const SCRIPT_BUILDER_MINIMAL_TOOLS = [
  'apply_script_code',
  'apply_script_metadata',
  'query_devices',
  'get_device_details',
  'list_scripts',
  'get_script_details',
  'list_script_templates',
] as const;

const SCRIPT_BUILDER_STANDARD_TOOLS = [
  ...SCRIPT_BUILDER_MINIMAL_TOOLS,
  'get_device_hardware_health',
  'get_script_execution_history',
  'get_script_execution',
  'execute_script_on_device',
] as const;

/**
 * Office client tool names across hosts (CLIENT_TOOL_REGISTRIES), listed
 * rather than derived so this module stays out of the client registry's
 * import graph; toolProfiles.contract.test.ts pins both lists to the registry
 * (`minimal` = every non-mutating name, `standard` = every name).
 */
const OFFICE_MINIMAL_TOOLS = [
  'extract_action_items', 'get_document_overview', 'get_message_metadata', 'get_presentation_overview',
  'get_workbook_overview', 'read_cell_details', 'read_range', 'read_selection', 'search_workbook', 'summarize_thread',
] as const;

const OFFICE_STANDARD_TOOLS = [
  ...OFFICE_MINIMAL_TOOLS,
  'add_slide', 'clear_range', 'create_chart', 'create_pivot_table', 'create_sheet', 'create_table', 'draft_reply',
  'find_replace', 'format_range', 'format_selection', 'format_text', 'insert_formula', 'insert_text', 'insert_text_box',
  'sort_range', 'write_range',
] as const;

/**
 * Per surface, per constrained profile. AI agents use the chat lists (they
 * register the same Breeze registry); a run's outcome tools ride as extra
 * tools that always survive. Office lists are bare client tool names across
 * hosts: `minimal` = the non-mutating ones, `standard` = all of them.
 */
export const CURATED_PROFILES: Readonly<Record<ProfiledSurface, Readonly<Record<ConstrainedProfile, readonly string[]>>>> = Object.freeze({
  chat: { minimal: CHAT_MINIMAL_TOOLS, standard: CHAT_STANDARD_TOOLS },
  ai_agents: { minimal: CHAT_MINIMAL_TOOLS, standard: CHAT_STANDARD_TOOLS },
  helper: { minimal: HELPER_MINIMAL_TOOLS, standard: HELPER_STANDARD_TOOLS },
  script_builder: { minimal: SCRIPT_BUILDER_MINIMAL_TOOLS, standard: SCRIPT_BUILDER_STANDARD_TOOLS },
  office_chat: { minimal: OFFICE_MINIMAL_TOOLS, standard: OFFICE_STANDARD_TOOLS },
});

/**
 * Measured fixed prefix (system prompt + advertised tool schemas) per surface
 * and profile, in tokens (bytes / 3), used by `auto` (#11395 W03). Measured
 * on a gateway connection, the transport `auto` is live on: the translated
 * upstream request, compacted when the exposure says so
 * (llm/toolCapture/advertisedPrefix.ts `measureProfilePrefixes`). A surface
 * with variants (helper level, agent run profile) pins its largest.
 * toolProfiles.prefix.contract.test.ts re-measures every pin and fails when
 * one drifts by more than 10 %: re-measure and update the numbers then.
 *
 * `null` means "not measured": if ANY of a surface's three prefixes is null,
 * `pickAutoProfile` answers `full` for it (nothing is constrained on a
 * guess). Office is not measured yet. Measured 2026-11-11 on origin/main
 * 0616d40358 + W03.
 *
 * Note for W02: chat `full` is ~128k tokens on a gateway (tool search is off
 * there, so every schema is inline), so a 131,072-token window resolves to
 * `standard`, not the plan's worked-example `full` (which assumed 68,000).
 */
export type ProfilePrefixTokens = Readonly<Record<ProfiledSurface, Readonly<Record<'minimal' | 'standard' | 'full', number | null>>>>;
export const PROFILE_PREFIX_TOKENS: ProfilePrefixTokens = Object.freeze({
  chat: { minimal: 3289, standard: 11037, full: 128300 },
  helper: { minimal: 2789, standard: 4600, full: 8562 },
  script_builder: { minimal: 3419, standard: 4238, full: 6372 },
  ai_agents: { minimal: 2995, standard: 10292, full: 79071 },
  office_chat: { minimal: null, standard: null, full: null },
});
