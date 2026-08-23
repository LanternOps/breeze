import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_TIERS } from './aiAgentSdkTools';
import {
  BLOCKED_TOOLS,
  checkAgentGuardrails,
  checkGuardrails,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER2_READONLY_ACTIONS,
  TIER2_READONLY_TOOLS,
  TIER3_ACTIONS,
  TOOL_ACTION_INPUT_KEYS,
  type AgentGuardrailPolicy,
} from './aiGuardrails';
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
} satisfies AgentGuardrailPolicy;

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
  'configuration_policy_compliance',
  'get_active_users',
  'get_catalog_item',
  'get_cis_compliance',
  'get_cis_device_report',
  'get_configuration_policy',
  'get_contract',
  'get_device_context',
  'get_device_details',
  'get_device_vulnerabilities',
  'get_dns_security',
  'get_effective_configuration',
  'get_fleet_findings',
  'get_fleet_health',
  'get_fleet_status',
  'get_huntress_incidents',
  'get_huntress_status',
  'get_invoice',
  'get_log_trends',
  'get_playbook_history',
  'get_quote',
  'get_s1_status',
  'get_s1_threats',
  'get_script_details',
  'get_script_execution',
  'get_script_execution_history',
  'get_security_posture',
  'get_service_monitoring_status',
  'get_user_experience_metrics',
  'get_vulnerability_report',
  'google_email_report',
  'google_list_licenses',
  'google_list_user_groups',
  'google_lookup_user',
  'google_security_drift',
  'list_configuration_policies',
  'list_contracts',
  'list_invoices',
  'list_organizations',
  'list_playbooks',
  'list_quotes',
  'list_script_templates',
  'list_scripts',
  'lookup_distributor_product',
  'm365_list_group_memberships',
  'm365_lookup_user',
  'm365_query_groups',
  'm365_query_intune_devices',
  'm365_query_org',
  'm365_query_signins',
  'm365_query_sites',
  'm365_query_users',
  'm365_recent_signins',
  'manage_alert_rules',
  'manage_maintenance_windows',
  'manage_service_monitors',
  'preview_configuration_change',
  'query_audit_log',
  'query_change_log',
  'query_devices',
  'query_monitors',
  'search_agent_logs',
  'search_catalog',
  'search_logs',
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
    if (base.tier === 3 || base.tier === 4 || !base.allowed || isSecretBearingTool(toolName)) {
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
          || isSecretBearingTool(toolName);

        // Tier 3 is the explicitly allowlistable case. Tier 4, blocked, and
        // secret-bearing tools remain denied even when the snapshot names them.
        expect(agent.allowed).toBe(base.tier === 3 && !unconditionallyDenied);
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
      const shadow = checkAgentGuardrails(toolName, {}, {
        ...EMPTY, mode: 'shadow', toolAllowlist: [toolName],
      });
      const readOnlyAdmitted = checkAgentGuardrails(toolName, {}, EMPTY).allowed;
      if (!readOnlyAdmitted) {
        expect(shadow.allowed, `${toolName} mutated under shadow mode`).toBe(false);
      }
    }
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

  it('preserves Tier-3 approval semantics for an allowlisted tool', () => {
    const result = checkAgentGuardrails('run_script', {}, {
      ...EMPTY,
      toolAllowlist: ['run_script'],
    });

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(true);
    expect(result.approvalScope).toBeDefined();
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
    expect(checkAgentGuardrails('file_operations', {
      action: 'delete', path: 'C:\\Windows\\System32-old\\x.sys',
    }, policy).allowed).toBe(true);
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
    expect(checkAgentGuardrails('registry_operations', {
      action: 'delete_key', key: 'HKLM\\SYSTEM-OLD',
    }, policy).allowed).toBe(true);
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
