/**
 * Contract test: category/capability parity between the two hand-maintained
 * AI-tool grouping tables (issue #5056).
 *
 * `apps/web/src/components/ai-risk/tierConfig.ts` groups tools into DISPLAY
 * categories (`ToolCategory`) for the customer-facing AI Risk page — "what is
 * this AI capable of, grouped the way an MSP tech thinks about their fleet".
 *
 * `apps/api/src/services/aiAgents/agentToolCatalog.ts` groups the same tools
 * into PERMISSION capabilities (`AgentCapabilityId`) for the agent-builder
 * picker — "what RBAC-shaped bundle of access does granting this tool
 * require". These are DELIBERATELY two different axes over the same tool set
 * (per #5056: "the two UIs serve different questions — risk posture vs what
 * an agent may change"). A 1:1 mapping is NOT the goal and this test does not
 * enforce one — it enforces three narrower things instead:
 *
 *   1. Every `TOOL_CAPABILITY` tool is represented somewhere in tierConfig.ts,
 *      except a documented pre-existing gap
 *      (`TOOL_CAPABILITY_NOT_YET_IN_TIER_CONFIG`) of newer feature families
 *      the risk page has never been updated to cover. That gap is pinned
 *      EXACTLY, the same discipline as the unreachable-tools snapshot in
 *      `agentToolCatalog.contract.test.ts`: it can only shrink by actually
 *      adding the tool to tierConfig.ts (and deleting the entry here), and it
 *      can only grow via a deliberate edit to this file — never silently, by
 *      a new tool landing in the picker but never the risk page.
 *   2. Every agent-reachable tool tierConfig.ts DOES reference has a
 *      `TOOL_CAPABILITY` entry (catches a typo'd or retired tool name
 *      surviving in tierConfig.ts after the capability map moves on).
 *   3. The (web category, API capability) pair for every tool present in BOTH
 *      tables is a member of the hand-authored `CATEGORY_CAPABILITY_PAIRS`
 *      allowlist below, so a new tool can't land in a category that makes no
 *      sense for its permission shape without a deliberate edit here.
 *
 * Reuses `parseToolLabel` from the tier-parity shared module (the
 * `tool (action/action)` grammar tierConfig.ts entries already use) rather
 * than re-deriving a base-name regex, so both parity tests treat an
 * unparseable label the same way.
 */
import { describe, it, expect } from 'vitest';
import '../aiTools'; // populates the registry

import {
  TOOL_CAPABILITY,
  listAgentReachableTools,
  type AgentCapabilityId,
} from './agentToolCatalog';
import { parseToolLabel } from '../aiGuardrailsTierParity.shared';
import { TIER_DEFINITIONS, type ToolCategory } from '../../../../web/src/components/ai-risk/tierConfig';

// ── Derive base-tool-name -> web category from tierConfig.ts ───────────────
// Tier 4 lists concepts ("Cross-org access", "Unknown tools"), not tools.
const tierConfigCategoryByTool = new Map<string, ToolCategory>();
const duplicateCategoryConflicts: string[] = [];

for (const tier of TIER_DEFINITIONS) {
  if (tier.tier === 4) continue;
  for (const entry of tier.tools) {
    // tierConfig.ts lists the same tool once per action group (e.g.
    // `manage_alerts (list/get)` in Tier 1, `manage_alerts (acknowledge)` in
    // Tier 2); parseToolLabel strips the `(...)` suffix to the bare tool name.
    const parsed = parseToolLabel(entry.name);
    const base = parsed?.tool ?? entry.name;
    const existing = tierConfigCategoryByTool.get(base);
    if (existing !== undefined && existing !== entry.category) {
      duplicateCategoryConflicts.push(
        `"${base}" is listed under both "${existing}" and "${entry.category}" — ` +
        'a tool must sit in exactly one display category across all tiers.',
      );
    }
    tierConfigCategoryByTool.set(base, entry.category);
  }
}

const reachableTools = new Set(listAgentReachableTools());

/**
 * `TOOL_CAPABILITY` entries with no representation anywhere in tierConfig.ts
 * — a pre-existing gap this test discovered, not a design decision. These
 * cover feature families added to the agent-builder capability map after
 * tierConfig.ts was last swept: SentinelOne containment, CIS baseline
 * remediation, Huntress, PAM/just-in-time elevation, user risk scoring,
 * Hyper-V and MSSQL backup/DR, backup vaults + SLA reporting, cloud-to-cloud
 * (M365/Google) backup, browser/peripheral device policy, patch update
 * rings, script/catalog listing helpers, quotes/invoices/contracts/catalog
 * business objects, tenancy management, and M365 typed Graph reads. Closing
 * this gap means authoring a tier + description + category per tool — a
 * content-authoring task, not a category fix — tracked as a follow-up, not
 * silently accepted here forever.
 *
 * Pinned EXACTLY (see the completeness test below): shrinking it requires
 * actually adding the tool to tierConfig.ts and deleting the entry here;
 * growing it requires a deliberate edit, so a brand-new capability-only tool
 * can't land in the picker without this test forcing a decision about
 * whether the risk page needs it too.
 */
const TOOL_CAPABILITY_NOT_YET_IN_TIER_CONFIG: readonly string[] = [
  'apply_cis_remediation',
  'assign_security_training',
  'collect_evidence',
  'configure_backup_sla',
  'configure_vault',
  'create_incident',
  'delete_tenant',
  'execute_containment',
  'execute_dr_plan',
  'generate_incident_report',
  'get_browser_security',
  'get_catalog_item',
  'get_cis_compliance',
  'get_cis_device_report',
  'get_contract',
  'get_device_vulnerabilities',
  'get_dr_execution_status',
  'get_dr_plan_details',
  'get_elevation_history',
  'get_huntress_incidents',
  'get_huntress_status',
  'get_hyperv_vm_details',
  'get_incident_timeline',
  'get_invite_funnel',
  'get_invoice',
  'get_mssql_backup_status',
  'get_peripheral_activity',
  'get_quote',
  'get_s1_status',
  'get_s1_threats',
  'get_sensitive_data_overview',
  'get_service_monitoring_status',
  'get_sla_breaches',
  'get_sla_compliance_report',
  'get_user_risk_detail',
  'get_user_risk_scores',
  'get_vault_status',
  'get_vm_restore_estimate',
  'get_vulnerability_report',
  'instant_boot_vm',
  'list_contracts',
  // Service deliverables W02 (#5573): same content gap as the contracts family
  // above — the AI Risk page has no deliverables/key-dates copy yet, and
  // authoring a tier + description + category for them belongs with the
  // customer-facing deliverables UI, not this wave.
  'list_deliverable_templates',
  'list_deliverables',
  'list_invoices',
  'list_organizations',
  'list_quotes',
  'list_script_templates',
  'list_scripts',
  'lookup_distributor_product',
  'm365_query_groups',
  'm365_query_intune_devices',
  'm365_query_org',
  'm365_query_signins',
  'm365_query_sites',
  'm365_query_users',
  'manage_backup_configs',
  'manage_backup_profiles',
  'manage_browser_policy',
  'manage_catalog',
  'manage_contracts',
  'manage_deliverables',
  'manage_dr_plan',
  'manage_hyperv_checkpoints',
  'manage_hyperv_vm',
  'manage_invoices',
  'manage_key_dates',
  'manage_organizations',
  'manage_peripheral_policies',
  'manage_peripheral_policy',
  'manage_policy_feature_link',
  'manage_quotes',
  'manage_service_monitors',
  'manage_software_policies',
  'manage_update_rings',
  'query_backup_sla',
  'query_c2c_connections',
  'query_c2c_jobs',
  'query_dr_plans',
  'query_hyperv_vms',
  'query_mssql_instances',
  'query_vaults',
  'remediate_sensitive_data',
  'remediate_vulnerability',
  'request_elevation',
  'restore_as_vm',
  'restore_c2c_items',
  'restore_hyperv_vm',
  'restore_mssql_database',
  'revoke_elevation',
  's1_isolate_device',
  's1_threat_action',
  'search_c2c_items',
  'search_catalog',
  'search_documentation',
  'sync_huntress_data',
  'trigger_c2c_sync',
  'trigger_hyperv_backup',
  'trigger_mssql_backup',
  'trigger_vault_sync',
  'verify_mssql_backup',
];

/**
 * The contract: which API permission capabilities a web display category may
 * legitimately contain. Hand-authored from the CURRENT tables (after fixing
 * the plainly-wrong placements #5056 called out — `manage_alert_rules` and
 * the `*_device_context` tools moved categories rather than being allowlisted
 * here; see the PR for the one-line reason on each). Every other
 * (category, capability) pair below is a deliberate judgment call that the
 * display grouping is coherent even though it doesn't match the API's finer
 * permission axis — e.g. "Files, Disk & Registry" reads as one bucket to an
 * MSP tech even though the API separates plain file ops (`files_disk`) from
 * registry edits (`scripts_commands`) as a permission matter.
 *
 * A pair NOT in this list fails the test below with the offending tool,
 * category, and capability named — so a new tool landing in a nonsensical
 * category/capability combination is a deliberate edit, not a silent drift.
 */
const CATEGORY_CAPABILITY_PAIRS: Record<ToolCategory, AgentCapabilityId[]> = {
  'Devices & Hardware': [
    'automations_reports', // device/fleet lookups, metrics, device-context resolution
    'alerts_monitoring', // get_fleet_findings: fleet hygiene findings display next to fleet health
  ],
  'Network & DNS': ['network', 'config_policies'],
  'Security & Compliance': ['security_response', 'patching_software'],
  'Alerts & Notifications': ['alerts_monitoring'],
  'Files, Disk & Registry': ['files_disk', 'scripts_commands'],
  'Logs & Audit': ['alerts_monitoring', 'automations_reports', 'endpoint_agent'],
  'Services & Processes': ['services_startup', 'scripts_commands'],
  'Scripts & Automation': ['scripts_commands'],
  'Configuration Policies': ['config_policies'],
  'Fleet Operations': [
    'automations_reports',
    'patching_software',
    'alerts_monitoring', // manage_maintenance_windows: a fleet-wide scheduling construct on display, even though its main effect is alert suppression permission-wise
  ],
  'Backup & Recovery': ['backup_recovery'],
  'Monitoring & Analytics': ['alerts_monitoring', 'automations_reports'],
  'Remote Access & Control': ['remote_access', 'scripts_commands'],
  Integrations: ['endpoint_agent', 'tenancy'],
  Ticketing: ['tickets'],
  'AI Governance': ['tenancy'],
  Other: ['automations_reports'],
};

describe('tierConfig.ts ↔ agentToolCatalog.ts category/capability parity (#5056)', () => {
  it('tierConfig.ts assigns exactly one display category per tool across all tiers', () => {
    expect(duplicateCategoryConflicts).toEqual([]);
  });

  it('every TOOL_CAPABILITY tool appears in tierConfig.ts, except the documented pre-existing gap', () => {
    const missing = Object.keys(TOOL_CAPABILITY)
      .filter((name) => !tierConfigCategoryByTool.has(name))
      .sort();
    expect(
      missing,
      'A tool was added to (or removed from) TOOL_CAPABILITY without a matching tierConfig.ts ' +
      'update. Either add the tool to tierConfig.ts (and drop it from ' +
      'TOOL_CAPABILITY_NOT_YET_IN_TIER_CONFIG), or add it to that list deliberately.',
    ).toEqual([...TOOL_CAPABILITY_NOT_YET_IN_TIER_CONFIG].sort());
  });

  it('every agent-reachable tool referenced in tierConfig.ts has a TOOL_CAPABILITY entry', () => {
    const missing = [...tierConfigCategoryByTool.keys()]
      .filter((name) => reachableTools.has(name) && !(name in TOOL_CAPABILITY));
    expect(missing).toEqual([]);
  });

  it('every (web category, API capability) pair in use is in the CATEGORY_CAPABILITY_PAIRS allowlist', () => {
    const mismatches: string[] = [];
    for (const [tool, category] of tierConfigCategoryByTool) {
      const capability = TOOL_CAPABILITY[tool];
      // Absence is covered by the completeness test above; nothing new to
      // assert about a pairing that doesn't exist.
      if (!capability) continue;
      const allowed = CATEGORY_CAPABILITY_PAIRS[category];
      if (!allowed.includes(capability)) {
        mismatches.push(
          `${tool}: tierConfig.ts category "${category}" paired with TOOL_CAPABILITY "${capability}" ` +
          'is not in CATEGORY_CAPABILITY_PAIRS',
        );
      }
    }
    expect(
      mismatches,
      'apps/web/src/components/ai-risk/tierConfig.ts and ' +
      'apps/api/src/services/aiAgents/agentToolCatalog.ts have drifted (#5056): a tool landed in a ' +
      '(category, capability) combination this test has never approved. Either fix the tierConfig.ts ' +
      'category if it is plainly wrong for what the tool does, or add the pair to ' +
      'CATEGORY_CAPABILITY_PAIRS if the display grouping is a deliberate, coherent choice.\n' +
      mismatches.map((m) => `  • ${m}`).join('\n'),
    ).toEqual([]);
  });

  it('CATEGORY_CAPABILITY_PAIRS carries no stale (category, capability) entries', () => {
    const used = new Set<string>();
    for (const [tool, category] of tierConfigCategoryByTool) {
      const capability = TOOL_CAPABILITY[tool];
      if (capability) used.add(`${category}::${capability}`);
    }
    const unused: string[] = [];
    for (const category of Object.keys(CATEGORY_CAPABILITY_PAIRS) as ToolCategory[]) {
      for (const capability of CATEGORY_CAPABILITY_PAIRS[category]) {
        if (!used.has(`${category}::${capability}`)) unused.push(`${category} -> ${capability}`);
      }
    }
    expect(unused).toEqual([]);
  });
});
