import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_TIERS } from './aiAgentSdkTools';
import { ACT_MANIFEST, resolveActOperation } from './aiAgents/actManifest';
import {
  AGENT_DENIED_READ_TOOLS,
  AGENT_HUMAN_ONLY_TOOLS,
  BLOCKED_TOOLS,
  checkAgentGuardrails,
  checkGuardrails,
  isNeverAgentTool,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER2_READONLY_ACTIONS,
  TIER2_READONLY_TOOLS,
  TIER3_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
  type AgentGuardrailPolicy,
  TIER1_NON_READONLY_TOOLS,
} from './aiGuardrails';
import { listAgentReachableTools } from './aiAgents/agentToolCatalog';
import { aiTools } from './aiToolNames';
import {
  isSecretBearingTool,
  SECRET_BEARING_TOOLS,
} from './actionIntents/secretBearingTools';

const EMPTY = {
  enabled: true,
  mode: 'act' as const,
  toolAllowlist: [],
  protectedResources: {
    services: [],
    paths: [],
    registryKeys: [],
    deviceTags: [],
  },
  deviceSiteId: 'site-a',
  deviceId: 'dev-1',
} satisfies AgentGuardrailPolicy;

const policyWith = (
  overrides: Partial<AgentGuardrailPolicy>,
): AgentGuardrailPolicy => ({ ...EMPTY, ...overrides });

describe('disposition (wave 3b tri-state)', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shadow + mutating + allowlisted => propose, not deny', () => {
    const check = checkAgentGuardrails('manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({ mode: 'shadow', toolAllowlist: ['manage_services:restart'] }));
    expect(check.disposition).toBe('propose');
    expect(check.allowed).toBe(false); // propose NEVER executes
  });

  it('shadow + mutating + NOT allowlisted => deny (ordering: allowlist beats propose)', () => {
    const check = checkAgentGuardrails('manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({ mode: 'shadow', toolAllowlist: [] }));
    expect(check.disposition).toBe('deny');
  });

  it('shadow + mutating + protected resource => deny even when allowlisted', () => {
    const check = checkAgentGuardrails('manage_services',
      { deviceId: 'dev-1', action: 'stop', serviceName: 'backup-agent' },
      policyWith({
        mode: 'shadow',
        toolAllowlist: ['manage_services:stop'],
        protectedResources: { services: ['backup-agent'], paths: [], registryKeys: [], deviceTags: [] },
      }));
    expect(check.disposition).toBe('deny');
  });

  it('read-only tool in shadow => allow', () => {
    const check = checkAgentGuardrails('get_device_details', { deviceId: 'dev-1' },
      policyWith({ mode: 'shadow' }));
    expect(check.disposition).toBe('allow');
    expect(check.allowed).toBe(true);
  });

  it('device-less run cannot propose a mutation', () => {
    const check = checkAgentGuardrails('manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({ mode: 'shadow', toolAllowlist: ['manage_services:restart'], deviceId: null }));
    expect(check.disposition).toBe('deny');
    expect(check.reason).toMatch(/device-bound/);
  });

  it('every deny keeps disposition deny (kill switch case)', () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    const check = checkAgentGuardrails('get_device_details', {}, policyWith({}));
    expect(check.disposition).toBe('deny');
  });
});

// P2-4 (#4191): the ticket-scope exemption to the device-less-mutation deny.
// Truth table: manage_tickets + scope.ticketId passes; manage_tickets with NO
// scope still denies (unchanged); a non-ticket tool with scope set is NOT
// exempted (scope is manage_tickets-specific, never a blanket carve-out).
describe('manage_tickets ticket-scope exemption to the device-less-mutation deny (P2-4)', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('manage_tickets mutation WITH scope.ticketId is not denied for lack of device binding', () => {
    const check = checkAgentGuardrails(
      'manage_tickets',
      { action: 'update_fields', ticketId: 'ticket-1', fields: { priority: 'high' } },
      policyWith({
        mode: 'shadow',
        deviceId: null,
        toolAllowlist: ['manage_tickets:update_fields'],
        scope: { ticketId: 'ticket-1' },
      }),
    );
    expect(check.disposition).not.toBe('deny');
    expect(check.reason).not.toMatch(/device-bound/);
  });

  it('manage_tickets mutation WITHOUT scope still denies device-less (unchanged behavior)', () => {
    const check = checkAgentGuardrails(
      'manage_tickets',
      { action: 'update_fields', ticketId: 'ticket-1', fields: { priority: 'high' } },
      policyWith({
        mode: 'shadow',
        deviceId: null,
        toolAllowlist: ['manage_tickets:update_fields'],
      }),
    );
    expect(check.disposition).toBe('deny');
    expect(check.reason).toMatch(/device-bound/);
  });

  it('scope.ticketId does NOT exempt a different tool from the device-less-mutation deny', () => {
    const check = checkAgentGuardrails(
      'manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({
        mode: 'shadow',
        deviceId: null,
        toolAllowlist: ['manage_services:restart'],
        scope: { ticketId: 'ticket-1' },
      }),
    );
    expect(check.disposition).toBe('deny');
    expect(check.reason).toMatch(/device-bound/);
  });

  it('link_device and draft (new P2-4 actions) also pass the exemption with scope', () => {
    for (const action of ['link_device', 'draft']) {
      const check = checkAgentGuardrails(
        'manage_tickets',
        { action, ticketId: 'ticket-1', hostname: 'WKS-1', kind: 'reply', content: 'x' },
        policyWith({
          mode: 'shadow',
          deviceId: null,
          toolAllowlist: [`manage_tickets:${action}`],
          scope: { ticketId: 'ticket-1' },
        }),
      );
      expect(check.disposition).not.toBe('deny');
    }
  });
});

/**
 * Every tool an agent may call with NO allowlist entry. Deliberately a literal:
 * a tool arriving here must be a reviewed decision, not a side effect of a tier
 * edit elsewhere.
 */
const EXPECTED_EMPTY_ALLOWLIST_ADMISSIONS: string[] = [
  'analyze_boot_performance',
  'analyze_disk_usage',
  'analyze_fleet_metrics',
  'analyze_metrics',
  // W01 (#6755)
  'browse_snapshots',
  'configuration_policy_compliance',
  'export_dataset',
  'get_active_users',
  'get_ai_agent_run', // A-W06 Tier-1 read
  // W01 (#6755)
  'get_backup_status',
  'get_catalog_item',
  'get_cis_compliance',
  'get_cis_device_report',
  'get_configuration_policy',
  'get_contract',
  'get_device_context',
  'get_device_details',
  'get_device_hardware_health',
  'get_device_vulnerabilities',
  'get_dns_security',
  'get_effective_configuration',
  // W01 (#6755)
  'get_elevation_history',
  'get_fleet_findings',
  'get_fleet_health',
  'get_huntress_incidents',
  'get_huntress_status',
  // W01 (#6755)
  'get_hyperv_vm_details',
  'get_invite_funnel',
  'get_invoice',
  // W01 (#6755)
  'get_ip_history',
  'get_log_trends',
  // W01 (#6755)
  'get_monitor',
  'get_mssql_backup_status',
  'get_network_asset', // A-W06 Tier-1 read
  // W01 (spec §4.4) — read-only reachability for a discovered network asset.
  // Tier 1, reads nothing outside the caller's tenant, mutates nothing.
  'get_network_asset_reachability',
  // W01 (#6755)
  'get_network_changes',
  'get_peripheral_activity',
  'get_playbook_history',
  'get_quote',
  'get_running_timer', // A-W06 Tier-1 read
  'get_s1_status',
  'get_s1_threats',
  'get_script_details',
  'get_script_execution',
  'get_script_execution_history',
  // AI script authoring: tier 1 by design — a proposal is inert until a
  // Tier-3 run_script consumes it, and the handler itself returns
  // feature_disabled while BREEZE_AI_SCRIPT_AUTHORING_ENABLED is off.
  'get_script_proposal',
  'get_security_posture',
  'get_service_monitoring_status',
  'get_site', // A-W06 Tier-1 read
  // W01 (#6755)
  'get_sla_breaches',
  'get_sla_compliance_report',
  'get_software_compliance',
  'get_timesheet', // A-W06 Tier-1 read
  'get_user_experience_metrics',
  // W01 (#6755)
  'get_vault_status',
  'get_vm_restore_estimate',
  'get_vulnerability_report',
  'google_email_report',
  'google_list_licenses',
  'google_list_user_groups',
  'google_lookup_user',
  'google_security_drift',
  'list_ai_agent_runs', // A-W06 Tier-1 read
  'list_ai_agents', // A-W06 Tier-1 read
  'list_configuration_policies',
  'list_contracts',
  'list_deliverable_templates',
  'list_incidents', // A-W06 Tier-1 read
  'list_invoices',
  // W01 (#6755)
  'list_monitors',
  'list_network_assets', // A-W06 Tier-1 read
  'list_org_contacts', // A-W06 Tier-1 read
  // W03: read-only document METADATA, same admission shape as the sibling
  // business-object list tools; bytes are not reachable from any tool.
  'list_org_documents',
  'list_organizations',
  'list_playbooks',
  'list_quotes',
  'list_remediation_suggestions', // A-W06 Tier-1 read
  // W01 (#6755)
  'list_remote_sessions',
  'list_script_templates',
  'list_scripts',
  'list_sites', // A-W06 Tier-1 read
  'list_time_entries', // A-W06 Tier-1 read
  'lookup_distributor_product',
  'm365_list_group_memberships',
  'm365_lookup_user',
  'm365_query_groups',
  'm365_query_intune_devices',
  'm365_query_org',
  // m365_query_signins and m365_query_users are listed in
  // AGENT_DENIED_READ_TOOLS (W01-D5, quorum amendment WQ1, #6755): both are
  // org-wide tier-1 reads with no device axis, so they are denied to headless
  // agents explicitly rather than through the session-only filter.
  'm365_query_sites',
  'm365_recent_signins',
  'manage_alert_rules',
  // manage_maintenance_windows was admitted here (its unclassified mutation
  // actions fell to the base tier's read-only resolution) before W01-D3
  // (#6755) added them to TIER3_ACTIONS. Now that it carries a real
  // escalation, it is an action-multiplexed tool and an unresolvable action
  // (the empty-allowlist policy's {} call) denies — exactly the fail-closed
  // behavior isActionMultiplexedTool exists for.
  'manage_monitors', // Only get executes; retired mutations return guidance before DB access.
  'manage_service_monitors',
  'preview_configuration_change',
  'propose_script',
  // W01 (#6755)
  'query_agent_versions',
  'query_analytics',
  'query_audit_log',
  // W01 (#6755)
  'query_backup_sla',
  'query_change_log',
  // W01 (#6755)
  'query_compliance_policies',
  'query_devices',
  // W01 (#6755)
  'query_hyperv_vms',
  'query_monitors',
  // W01 (#6755)
  'query_mssql_instances',
  'query_webhooks',
  'read_artifact', // A-W05 (D13a): Tier 1 read, own-run/session scoped
  'search_agent_logs',
  'search_catalog',
  'search_documentation', // A-W02 Task 5 declared it on the chat server (Tier 1 read)
  'search_logs',
  // W01 (#6755)
  'search_script_library',
];

describe('checkAgentGuardrails — fail closed for every registered tool', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The admitted set is DECLARED, not recomputed from the implementation. The
  // previous oracle re-derived `readOnly` with the same expression the
  // production code uses, against the same base.tier — it could not fail unless
  // someone edited both sides, and it proved only that the implementation
  // equals itself. Moving a mutating tool into TIER2_READONLY_TOOLS must break
  // this test and force a human decision.
  it('exactly these tools are admitted to an agent holding an empty allowlist', () => {
    const admitted = Object.keys(TOOL_TIERS)
      .filter((toolName) => checkAgentGuardrails(toolName, {}, EMPTY).allowed)
      .sort();
    expect(admitted).toEqual(EXPECTED_EMPTY_ALLOWLIST_ADMISSIONS);
  });

  for (const toolName of Object.keys(TOOL_TIERS)) {

    const base = checkGuardrails(toolName, {});
    if (
      base.tier === 3 || base.tier === 4 || !base.allowed
      || isSecretBearingTool(toolName) || AGENT_HUMAN_ONLY_TOOLS.has(toolName)
      || AGENT_DENIED_READ_TOOLS.has(toolName)
    ) {
      it(`${toolName}: explicit allowlisting cannot bypass unconditional denials`, () => {
        // A multiplexed tool needs a resolvable action — calling it with {} now
        // denies on that ground alone, which would mask what this asserts.
        const multiplexedAction = TIER3_ACTIONS[toolName]?.[0]
          ?? TIER2_ACTIONS[toolName]?.[0]
          ?? TIER1_ACTIONS[toolName]?.[0];
        const actionKey = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
        const input = multiplexedAction ? { [actionKey]: multiplexedAction } : {};
        const agent = checkAgentGuardrails(toolName, input, {
          ...EMPTY,
          toolAllowlist: [toolName],
        });
        const unconditionallyDenied = base.tier === 4
          || !base.allowed
          || BLOCKED_TOOLS.has(toolName)
          || isSecretBearingTool(toolName)
          || AGENT_HUMAN_ONLY_TOOLS.has(toolName)
          || AGENT_DENIED_READ_TOOLS.has(toolName);

        // Tier 4, blocked, secret-bearing, human-only and denied-read tools
        // remain denied even when the snapshot names them — these denials
        // sit upstream of the act branch and allowlisting can never reach
        // past them.
        if (unconditionallyDenied) {
          expect(agent.allowed).toBe(false);
          return;
        }

        // The DISPATCHED call's own tier/readOnly-ness governs the
        // expectation from here, not `base` above (computed from an empty
        // input purely to select which tools this test runs for). A
        // multiplexed tool's first listed action can itself downgrade to a
        // Tier-2 read-only call — e.g. execute_command's first TIER2_ACTIONS
        // entry, event_logs_list — which always auto-executes regardless of
        // mode or the act manifest; that's the required "readOnly Tier-2
        // semantics unchanged" invariant, not a act-branch outcome at all.
        const actualBase = checkGuardrails(toolName, input);
        const actuallyReadOnly = actualBase.tier === 1
          || (actualBase.tier === 2 && (actualBase.readOnly === true || TIER2_READONLY_TOOLS.has(toolName)));
        if (actuallyReadOnly) {
          expect(agent.allowed).toBe(true);
          return;
        }

        // Tier 3 under EMPTY's `mode: 'act'` (wave 4b): allowlisting alone no
        // longer unlocks execution — 'allowed' now tracks manifest
        // membership. A manifest-matched op executes (disposition 'act');
        // everything else records a proposal (disposition 'propose',
        // allowed:false), same as it would under shadow. This replaces the
        // pre-wave-4b placeholder where any allowlisted Tier-3 tool reached
        // an 'allow' disposition with requiresApproval:true.
        const manifestMatched = resolveActOperation(toolName, input) !== null;
        expect(agent.allowed).toBe(actualBase.tier === 3 && manifestMatched);
        if (actualBase.tier === 3) {
          expect(agent.disposition).toBe(manifestMatched ? 'act' : 'propose');
        }
      });
    }
  }

  // A non-string action made checkGuardrails skip its TIER3_ACTIONS escalation
  // and fall back to the tool's registered base tier — 1 for most multiplexed
  // tools — collapsing mutating tools to Tier 1 and skipping the allowlist.
  for (const hostile of [['write'], 42, { action: 'write' }, null, true] as const) {
    it(`denies a multiplexed tool whose action is ${JSON.stringify(hostile)}`, () => {
      for (const toolName of Object.keys(TOOL_ACTION_INPUT_KEYS)) {
        const key = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
        const verdict = checkAgentGuardrails(toolName, { [key]: hostile }, EMPTY);
        expect(verdict.allowed, `${toolName} admitted a non-string action`).toBe(false);
      }
    });
  }

  it('denies every tool when the agent is disabled or in off mode', () => {
    for (const toolName of Object.keys(TOOL_TIERS)) {
      expect(checkAgentGuardrails(toolName, {}, { ...EMPTY, enabled: false }).allowed).toBe(false);
      expect(checkAgentGuardrails(toolName, {}, { ...EMPTY, mode: 'off' }).allowed).toBe(false);
    }
  });

  it('shadow mode admits no mutating tool, even an allowlisted one', () => {
    for (const toolName of Object.keys(TOOL_TIERS)) {
      // Execution plane W04 (#5715): the four `workspace_*` tools are the ONE
      // deliberate exception, and they are named here rather than derived so
      // widening the exception takes an edit to this security suite. They are
      // not read-only (that is what makes them allowlist-gated), but there is
      // nothing for shadow mode to protect: the sandbox is inert, reachable
      // only by the run that owns it, and a "proposal" to write a file into it
      // is not something a human could meaningfully approve. See
      // TIER1_NON_READONLY_TOOLS in aiGuardrails.ts and the ordering proof in
      // aiGuardrails.workspace.contract.test.ts (the forced-allow sits AFTER
      // every structural deny, so allowlist and protected-resource refusals
      // still win).
      if (TIER1_NON_READONLY_TOOLS.has(toolName)) continue;
      const shadow = checkAgentGuardrails(toolName, {}, {
        ...EMPTY, mode: 'shadow', toolAllowlist: [toolName],
      });
      const readOnlyAdmitted = checkAgentGuardrails(toolName, {}, EMPTY).allowed;
      if (!readOnlyAdmitted) {
        expect(shadow.allowed, `${toolName} mutated under shadow mode`).toBe(false);
      }
    }
  });

  it('the shadow-mode exception is exactly the four workspace tools, and no more', () => {
    expect([...TIER1_NON_READONLY_TOOLS].sort()).toEqual([
      'workspace_cancel', 'workspace_collect', 'workspace_run', 'workspace_stage',
    ]);
  });

  it('finds a protected path nested inside a parameter object', () => {
    const policy = {
      ...EMPTY,
      toolAllowlist: ['execute_command'],
      protectedResources: { ...EMPTY.protectedResources, paths: ['C:\\Windows\\System32'] },
    };
    // execute_command carries its parameters in a nested `payload`, dispatching
    // the same agent commands as file_operations. A top-level key lookup never
    // saw them.
    expect(checkAgentGuardrails('execute_command', {
      commandType: 'file_list', payload: { path: 'C:\\Windows\\System32\\config' },
    }, policy).allowed).toBe(false);
  });

  it('finds a protected path in an ARRAY-valued parameter', () => {
    const policy = {
      ...EMPTY,
      toolAllowlist: ['disk_cleanup'],
      protectedResources: { ...EMPTY.protectedResources, paths: ['C:\\Windows\\System32'] },
    };
    expect(checkAgentGuardrails('disk_cleanup', {
      action: 'execute', paths: ['C:\\Temp', 'C:\\Windows\\System32\\drivers'],
    }, policy).allowed).toBe(false);
  });

  it('matches protected device tags case-insensitively', () => {
    const policy = {
      ...EMPTY,
      protectedResources: { ...EMPTY.protectedResources, deviceTags: ['production'] },
    };
    expect(checkAgentGuardrails('get_device', { tags: ['Production'] }, policy).allowed).toBe(false);
  });

  it('denies unknown tools even when allowlisted', () => {
    expect(checkAgentGuardrails('future_unregistered_tool', {}, {
      ...EMPTY,
      toolAllowlist: ['future_unregistered_tool'],
    }).allowed).toBe(false);
  });

  it('denies every explicitly blocked tool even when allowlisted', () => {
    for (const toolName of BLOCKED_TOOLS) {
      expect(checkAgentGuardrails(toolName, {}, {
        ...EMPTY,
        toolAllowlist: [toolName],
      }).allowed).toBe(false);
    }
  });

  it('denies every secret-bearing tool even when allowlisted', () => {
    for (const toolName of SECRET_BEARING_TOOLS) {
      expect(checkAgentGuardrails(toolName, {}, {
        ...EMPTY,
        toolAllowlist: [toolName],
      }).allowed).toBe(false);
    }
  });

  it('denies when the run policy snapshot is missing', () => {
    expect(checkAgentGuardrails('query_devices', {}, undefined).allowed).toBe(false);
    expect(checkAgentGuardrails('query_devices', {}, null).allowed).toBe(false);
  });

  it('denies every tool when autonomous agents are disabled', () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');

    for (const toolName of Object.keys(TOOL_TIERS)) {
      expect(checkAgentGuardrails(toolName, {}, {
        ...EMPTY,
        toolAllowlist: [toolName],
      }).allowed).toBe(false);
    }
  });

  it('denies every tool when the feature flag is absent or malformed', () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', '');
    expect(checkAgentGuardrails('query_devices', {}, EMPTY).allowed).toBe(false);

    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'maybe');
    expect(checkAgentGuardrails('query_devices', {}, EMPTY).allowed).toBe(false);
  });

  it('accepts the same truthy spellings as every other flag in config/env', () => {
    // The gate used to compare `!== 'true'` while the resolver used envFlag, so
    // BREEZE_AI_AGENTS_ENABLED=1 enabled the policy and denied every tool.
    for (const spelling of ['1', 'yes', 'on', 'TRUE']) {
      vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', spelling);
      expect(checkAgentGuardrails('query_devices', {}, EMPTY).allowed, spelling).toBe(true);
    }
  });

  it('admits read-only actions on mixed tools but denies mutating actions with an empty allowlist', () => {
    for (const [toolName, actions] of Object.entries(TIER2_READONLY_ACTIONS)) {
      const actionKey = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
      for (const action of actions) {
        expect(checkAgentGuardrails(toolName, { [actionKey]: action }, EMPTY).allowed).toBe(true);
      }
    }

    expect(checkAgentGuardrails('manage_services', { action: 'restart' }, EMPTY).allowed).toBe(false);
  });

  it('preserves Tier-3 metadata (tier, approvalScope) through the act disposition for a manifest-matched op', () => {
    // Pre-wave-4b, an allowlisted Tier-3 tool under mode 'act' fell through
    // to the base tier-3 arm unmodified: disposition 'allow', allowed:true,
    // requiresApproval:true. Wave 4b's act branch (this task) intercepts it
    // instead: a manifest-matched op still carries tier/approvalScope from
    // checkGuardrails' base (spread through), but requiresApproval flips to
    // false — act mode revalidates and executes rather than waiting on a
    // human approval step.
    const result = checkAgentGuardrails('run_script', { scriptId: 'script-1', deviceIds: ['dev-1'] }, {
      ...EMPTY,
      toolAllowlist: ['run_script'],
    });

    expect(result.disposition).toBe('act');
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(false);
    expect(result.approvalScope).toBeDefined();
  });

  it('an allowlisted Tier-3 tool with NO matching manifest entry proposes instead of executing under act', () => {
    // run_script with no scriptId cannot be normalized to a manifest target
    // (actManifest.ts's `matches` requires one) — it is exactly as
    // allowlisted as the case above, but not act-eligible, so it must
    // propose rather than silently fall back to unattended execution.
    const result = checkAgentGuardrails('run_script', {}, {
      ...EMPTY,
      toolAllowlist: ['run_script'],
    });

    expect(result.disposition).toBe('propose');
    expect(result.allowed).toBe(false);
  });

  it('honours exact tool:action allowlist entries', () => {
    const policy = { ...EMPTY, toolAllowlist: ['manage_services:restart'] };

    expect(checkAgentGuardrails('manage_services', { action: 'restart' }, policy).allowed).toBe(true);
    expect(checkAgentGuardrails('manage_services', { action: 'stop' }, policy).allowed).toBe(false);
  });

  it('denies protected services case-insensitively without prefix overmatching', () => {
    const policy = {
      ...EMPTY,
      toolAllowlist: ['manage_services:restart'],
      protectedResources: { ...EMPTY.protectedResources, services: ['MSSQLSERVER'] },
    };

    expect(checkAgentGuardrails('manage_services', {
      action: 'restart', serviceName: 'mssqlserver',
    }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('manage_services', {
      action: 'restart', serviceName: 'MSSQLSERVER-DEV',
    }, policy).allowed).toBe(true);
  });

  it('denies protected Windows paths case-insensitively, including subpaths only', () => {
    const policy = {
      ...EMPTY,
      toolAllowlist: ['file_operations:delete'],
      protectedResources: { ...EMPTY.protectedResources, paths: ['C:\\Windows\\System32'] },
    };

    expect(checkAgentGuardrails('file_operations', {
      action: 'delete', path: 'c:/WINDOWS/system32/drivers/x.sys',
    }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('file_operations', {
      action: 'delete', path: 'C:\\Windows\\Temp\\..\\System32\\drivers\\x.sys',
    }, policy).allowed).toBe(false);
    // file_operations has no ACT_MANIFEST entry, so a non-protected path
    // still never reaches 'allowed:true' under act — it proposes instead.
    // Asserting disposition (not `allowed`) is what proves the protected
    // check itself didn't fire here: a 'deny' above vs. a 'propose' here.
    expect(checkAgentGuardrails('file_operations', {
      action: 'delete', path: 'C:\\Windows\\System32-old\\x.sys',
    }, policy).disposition).toBe('propose');
  });

  it('denies protected registry keys case-insensitively, including subkeys only', () => {
    const policy = {
      ...EMPTY,
      toolAllowlist: ['registry_operations:delete_key'],
      protectedResources: { ...EMPTY.protectedResources, registryKeys: ['HKLM\\SYSTEM'] },
    };

    expect(checkAgentGuardrails('registry_operations', {
      action: 'delete_key', key: 'hklm\\system\\CurrentControlSet',
    }, policy).allowed).toBe(false);
    // registry_operations has no ACT_MANIFEST entry — see the same note on
    // the Windows-paths test above.
    expect(checkAgentGuardrails('registry_operations', {
      action: 'delete_key', key: 'HKLM\\SYSTEM-OLD',
    }, policy).disposition).toBe('propose');
  });

  it('denies inputs carrying a protected device tag', () => {
    const policy = {
      ...EMPTY,
      protectedResources: { ...EMPTY.protectedResources, deviceTags: ['production'] },
    };

    expect(checkAgentGuardrails('query_devices', { deviceTags: ['production'] }, policy).allowed).toBe(false);
    expect(checkAgentGuardrails('query_devices', { deviceTags: ['staging'] }, policy).allowed).toBe(true);
  });

  it("denies an explicit site selector outside the run device's site", () => {
    expect(checkAgentGuardrails('query_devices', { siteId: 'site-b' }, EMPTY).allowed).toBe(false);
    expect(checkAgentGuardrails('query_devices', { siteIds: ['site-a', 'site-b'] }, EMPTY).allowed).toBe(false);
    expect(checkAgentGuardrails('query_devices', { siteId: 'site-a' }, EMPTY).allowed).toBe(true);
  });

  it('denies explicit site selectors when the run device site is unavailable', () => {
    expect(checkAgentGuardrails('query_devices', { siteId: 'site-a' }, {
      ...EMPTY,
      deviceSiteId: null,
    }).allowed).toBe(false);
  });
});

/**
 * Task 2's own disposition matrix, spelled out explicitly rather than left
 * to infer from the tests above — the plan calls this "the heart of the
 * wave", so each row gets its own named test rather than a shared loop that
 * would blur which case failed.
 */
describe('Task 2 — act disposition matrix', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const actPolicy = (overrides: Partial<AgentGuardrailPolicy> = {}) =>
    policyWith({ mode: 'act', ...overrides });

  it('act + manifest-matched restart => act (executes, no approval)', () => {
    const check = checkAgentGuardrails(
      'manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      actPolicy({ toolAllowlist: ['manage_services:restart'] }),
    );
    expect(check.disposition).toBe('act');
    expect(check.allowed).toBe(true);
    expect(check.requiresApproval).toBe(false);
  });

  it('act + stop (same tool, non-manifest action) => propose, not act', () => {
    const check = checkAgentGuardrails(
      'manage_services',
      { deviceId: 'dev-1', action: 'stop', serviceName: 'spooler' },
      actPolicy({ toolAllowlist: ['manage_services:stop'] }),
    );
    expect(check.disposition).toBe('propose');
    expect(check.allowed).toBe(false);
  });

  it('act + execute_command => propose — the lower-level alias path is never act-eligible', () => {
    // A mutating commandType with no TIER2_ACTIONS entry stays base Tier 3
    // (allowed:true, requiresApproval:true from checkGuardrails) — this is
    // NOT a readOnly downgrade, so it genuinely reaches the act branch and
    // must still fail to match the manifest.
    const check = checkAgentGuardrails(
      'execute_command',
      { deviceId: 'dev-1', commandType: 'kill_process', payload: { pid: '4242' } },
      actPolicy({ toolAllowlist: ['execute_command'] }),
    );
    expect(check.disposition).toBe('propose');
    expect(check.allowed).toBe(false);
  });

  it('act + a genuinely unknown (tier-4) tool still denies, even fed a manifest-shaped input — ordering proof', () => {
    // Proves the tier-4/unknown-tool denial in checkAgentGuardrails fires
    // BEFORE the mode branch is ever reached: an act-looking payload on a
    // tool the registry has never heard of is not "rescued" into a proposal
    // or an execution, it is denied on the same unconditional ground a
    // read-only call to it would be.
    const check = checkAgentGuardrails(
      'manage_services_nonexistent',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      actPolicy({ toolAllowlist: ['manage_services_nonexistent'] }),
    );
    expect(check.tier).toBe(4);
    expect(check.disposition).toBe('deny');
    expect(check.allowed).toBe(false);
  });

  it('act + secret-bearing tool still denies, even allowlisted and manifest-shaped — ordering proof', () => {
    // isSecretBearingTool's check sits above the mode branch too; assert it
    // against every entry in the real registry, not a single sample.
    for (const toolName of SECRET_BEARING_TOOLS) {
      const check = checkAgentGuardrails(
        toolName,
        { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
        actPolicy({ toolAllowlist: [toolName] }),
      );
      expect(check.disposition, toolName).toBe('deny');
      expect(check.allowed, toolName).toBe(false);
    }
  });

  it('act + a read-only tool => allow (never enters the act/propose branch at all)', () => {
    const check = checkAgentGuardrails('get_device_details', { deviceId: 'dev-1' }, actPolicy());
    expect(check.disposition).toBe('allow');
    expect(check.allowed).toBe(true);
  });

  it('off + a manifest-matched call still denies — mode gate precedes the manifest entirely', () => {
    const check = checkAgentGuardrails(
      'manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({ mode: 'off', toolAllowlist: ['manage_services:restart'] }),
    );
    expect(check.disposition).toBe('deny');
    expect(check.allowed).toBe(false);
  });

  it('shadow + the exact same manifest-matched call => propose, never act — modes never leak into each other', () => {
    const check = checkAgentGuardrails(
      'manage_services',
      { deviceId: 'dev-1', action: 'restart', serviceName: 'spooler' },
      policyWith({ mode: 'shadow', toolAllowlist: ['manage_services:restart'] }),
    );
    expect(check.disposition).toBe('propose');
    expect(check.allowed).toBe(false);
  });

  it('the manifest key set reachable via checkAgentGuardrails matches ACT_MANIFEST exactly (no drift between the two modules)', () => {
    // manage_services / disk_cleanup / run_script / execute_playbook each get
    // one representative matching call; the virtual remediation_suggestion
    // key is intentionally excluded — it is never reachable via a raw
    // checkAgentGuardrails dispatch (Task 7). manage_processes.kill is also
    // excluded — deferred out of act-manifest v1 (#3826 scoped re-review):
    // see the dedicated test below.
    const reachableKeys = new Set(
      [
        checkAgentGuardrails('manage_services', { deviceId: 'dev-1', action: 'restart', serviceName: 'x' },
          actPolicy({ toolAllowlist: ['manage_services'] })),
        checkAgentGuardrails('disk_cleanup', { deviceId: 'dev-1', action: 'execute', paths: ['/tmp/a'] },
          actPolicy({ toolAllowlist: ['disk_cleanup'] })),
        checkAgentGuardrails('run_script', { scriptId: 's-1', deviceIds: ['dev-1'] },
          actPolicy({ toolAllowlist: ['run_script'] })),
        checkAgentGuardrails('execute_playbook', { deviceId: 'dev-1', playbookId: 'pb-1' },
          actPolicy({ toolAllowlist: ['execute_playbook'] })),
      ].map((c) => c.disposition),
    );
    expect(reachableKeys).toEqual(new Set(['act']));
    // 5 manifest entries total; 4 are reachable through a raw tool call, 1
    // (remediation_suggestion) is virtual — see actManifest.test.ts.
    expect(ACT_MANIFEST.length).toBe(5);
  });

  it('act + manage_processes kill => propose, exactly like shadow — deferred out of v1 (#3826), no capability regression', () => {
    // manage_processes.kill was removed from ACT_MANIFEST (unreachable via
    // the agent SDK to begin with — manage_processes is not in TOOL_TIERS —
    // and its identity pin was never implemented). Under act mode this call
    // now falls through to the ordinary unmatched-mutation branch, which
    // records a proposal exactly like shadow mode would for the same call:
    // no capability regression, since nothing could execute it before either.
    const actCheck = checkAgentGuardrails(
      'manage_processes',
      { deviceId: 'dev-1', action: 'kill', processId: '1', processName: 'x' },
      actPolicy({ toolAllowlist: ['manage_processes'] }),
    );
    expect(actCheck.disposition).toBe('propose');
    expect(actCheck.allowed).toBe(false);

    const shadowCheck = checkAgentGuardrails(
      'manage_processes',
      { deviceId: 'dev-1', action: 'kill', processId: '1', processName: 'x' },
      policyWith({ mode: 'shadow', toolAllowlist: ['manage_processes'] }),
    );
    expect(shadowCheck.disposition).toBe('propose');
    expect(shadowCheck.allowed).toBe(false);
  });
});

/**
 * AGENT_DENIED_READ_TOOLS (W01-D5, quorum amendments WQ1/WQ2, #6755): tier-1
 * reads a headless agent may never call, whatever its allowlist says. Pinned
 * as a literal so a membership change is a deliberate, reviewed edit.
 */
const EXPECTED_AGENT_DENIED_READ_TOOLS = [
  'get_user_risk_detail',
  'get_sensitive_data_overview',
  'get_user_risk_scores',
  'm365_query_signins', // WQ1
  'm365_query_users', // WQ1
  'query_c2c_jobs', // WQ2
  'search_c2c_items',
].sort();

describe('AGENT_DENIED_READ_TOOLS (W01-D5 / WQ1 / WQ2, #6755)', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is exactly the pinned set, each registered and each with a real reason (>= 20 chars)', () => {
    expect([...AGENT_DENIED_READ_TOOLS.keys()].sort()).toEqual(EXPECTED_AGENT_DENIED_READ_TOOLS);
    for (const [name, reason] of AGENT_DENIED_READ_TOOLS) {
      expect(aiTools.has(name), `${name}: not a registered tool`).toBe(true);
      expect(reason.trim().length, `${name}: reason must say why (>= 20 chars)`).toBeGreaterThanOrEqual(20);
    }
  });

  it('is disjoint from AGENT_HUMAN_ONLY_TOOLS', () => {
    for (const name of AGENT_DENIED_READ_TOOLS.keys()) {
      expect(AGENT_HUMAN_ONLY_TOOLS.has(name), `${name}: also in AGENT_HUMAN_ONLY_TOOLS`).toBe(false);
    }
  });

  for (const name of EXPECTED_AGENT_DENIED_READ_TOOLS) {
    it(`${name}: denied to an agent principal even when it is the ONLY allowlist entry`, () => {
      const check = checkAgentGuardrails(name, {}, policyWith({ toolAllowlist: [name] }));
      expect(check.disposition).toBe('deny');
      expect(check.allowed).toBe(false);
      expect(check.reason).toMatch(/never available to agents/);
    });

    it(`${name}: chat/Helper path (checkGuardrails, not checkAgentGuardrails) is unaffected — still allowed`, () => {
      const chatCheck = checkGuardrails(name, {});
      expect(chatCheck.allowed).toBe(true);
      expect(chatCheck.tier).toBe(1);
    });

    it(`${name}: excluded from listAgentReachableTools()`, () => {
      expect(listAgentReachableTools()).not.toContain(name);
    });
  }

  it('control: an already-exposed read (query_devices) is allowed for an agent principal', () => {
    const check = checkAgentGuardrails('query_devices', {}, policyWith({ toolAllowlist: ['query_devices'] }));
    expect(check.disposition).not.toBe('deny');
    expect(check.allowed).toBe(true);
  });

  it('isNeverAgentTool agrees with checkAgentGuardrails: every denied name is unconditionally denied, and query_devices is not', () => {
    for (const name of EXPECTED_AGENT_DENIED_READ_TOOLS) {
      expect(isNeverAgentTool(name), `${name}: isNeverAgentTool should be true`).toBe(true);
    }
    expect(isNeverAgentTool('query_devices')).toBe(false);
  });

  it('isNeverAgentTool agrees with listAgentReachableTools: no reachable name is ever isNeverAgentTool', () => {
    for (const name of listAgentReachableTools()) {
      expect(isNeverAgentTool(name), `${name}: reachable but isNeverAgentTool is true`).toBe(false);
    }
  });
});
