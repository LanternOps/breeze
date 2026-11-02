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
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { aiTools } from './aiToolNames';
import { TOOL_TIERS, SESSION_TOOL_DESCRIPTIONS, attachRegistryMeta, buildBreezeSdkTools } from './aiAgentSdkTools';
import { getAllRegisteredToolNames, getToolTier, getToolAlwaysLoad, getToolSearchHint } from './aiTools';
import { HUMAN_ONLY_TOOLS } from './aiToolExposure';
import { listAgentReachableTools } from './aiAgents/agentToolCatalog';

/**
 * Pure check extracted so the "HUMAN_ONLY_TOOLS entries are valid" rule can be
 * exercised against a fixture, not only against the (currently empty) real
 * map — an assertion against an empty map never fails, so it proves nothing
 * on its own (see the vacuity-control test below).
 */
function humanOnlyProblems(
  map: ReadonlyMap<string, string>,
  registered: ReadonlySet<string>,
  tiers: Record<string, number>,
): string[] {
  return [...map].flatMap(([name, reason]) => [
    ...(!registered.has(name) ? [`${name}: not registered`] : []),
    ...(name in tiers ? [`${name}: also in TOOL_TIERS — human-only means never tiered`] : []),
    ...(reason.trim().length < 20 ? [`${name}: reason must say why (>= 20 chars)`] : []),
  ]);
}

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
  'propose_action_plan',
]);

/**
 * Spec 2026-09-23 "Contracts": registry ⊆ TOOL_TIERS ∪ HUMAN_ONLY_TOOLS, with
 * no exceptions. The frozen `KNOWN_MISSING_TOOL_TIERS` allowlist (#3300: 86
 * mute tools at f400fc315, re-frozen at 88 on d1cbf4fe27) reached zero when
 * full-control W03 (#6757) and W04 (#6758) wired the last 38, and was deleted
 * in W04. A newly registered tool with no tier now fails here outright.
 */
describe('aiTools registry ⊆ TOOL_TIERS ∪ HUMAN_ONLY_TOOLS — a registered tool must be reachable from chat (#3300)', () => {
  it('every registered tool is tiered, or human-only with a reason', () => {
    const uncovered = getAllRegisteredToolNames()
      .filter((n) => !(n in TOOL_TIERS) && !HUMAN_ONLY_TOOLS.has(n))
      .sort();
    expect(
      uncovered,
      'Give the tool a TOOL_TIERS entry, or list it in HUMAN_ONLY_TOOLS (aiToolExposure.ts) with a written reason.',
    ).toEqual([]);
  });

  it('HUMAN_ONLY_TOOLS entries are registered, untiered, and carry a reason', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const bad = humanOnlyProblems(HUMAN_ONLY_TOOLS, registered, TOOL_TIERS);
    expect(bad).toEqual([]);
  });

  it('humanOnlyProblems is not vacuous — it flags a tiered entry and a too-short reason', () => {
    const bad = humanOnlyProblems(
      new Map([['query_devices', 'x']]),
      new Set(['query_devices']),
      TOOL_TIERS,
    );
    expect(bad).toEqual([
      'query_devices: also in TOOL_TIERS — human-only means never tiered',
      'query_devices: reason must say why (>= 20 chars)',
    ]);
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

/**
 * Contract (a) (spec 2026-09-23, W01-D2): `TOOL_TIERS` must be a
 * subset of what the MAIN chat/agent SDK server declares — not the union
 * across every SDK server. The script-builder server has its own
 * `SCRIPT_BUILDER_TOOL_TIERS` map (scriptBuilderTools.ts:40), so a tool
 * declared only there does not make it reachable from chat or a headless
 * agent run, both of which attach `createBreezeMcpServer` /
 * `buildBreezeSdkTools`. A union contract would also pass when a read is
 * declared only on the script-builder server, which is exactly the case this
 * contract exists to catch.
 */
const ALL_FLAGS_ON = {
  M365_ENABLED: 'true',
  GOOGLE_WORKSPACE_ENABLED: 'true',
  BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'true',
  FLOWS_ENABLED: 'true',
  DELEGANT_BASE_URL: 'https://delegant.example.com',
  // Wisp W03 memory tools are declared only when wispEnabled() (all three).
  IS_HOSTED: 'true',
  BREEZE_AI_AGENTS_ENABLED: 'true',
  BREEZE_WISP_ENABLED: 'true',
};

function declaredOnMainServer(): Set<string> {
  for (const [k, v] of Object.entries(ALL_FLAGS_ON)) vi.stubEnv(k, v);
  try {
    const built = buildBreezeSdkTools(() => { throw new Error('handlers must not run in this test'); });
    return new Set(built.map((t) => t.name));
  } finally {
    vi.unstubAllEnvs();
  }
}

/** Same declaration pass as declaredOnMainServer, but keyed by name so a
 * caller can inspect each declaration's inputSchema. */
function declaredToolsByName(): Map<string, ReturnType<typeof buildBreezeSdkTools>[number]> {
  for (const [k, v] of Object.entries(ALL_FLAGS_ON)) vi.stubEnv(k, v);
  try {
    const built = buildBreezeSdkTools(() => { throw new Error('handlers must not run in this test'); });
    return new Map(built.map((t) => [t.name, t]));
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('TOOL_TIERS ⊆ main chat/agent SDK server declarations (L2, spec 2026-09-23)', () => {
  it('every tiered tool is declared on buildBreezeSdkTools with every env-gated builder on', () => {
    const declared = declaredOnMainServer();
    expect(
      Object.keys(TOOL_TIERS).filter((n) => !declared.has(n)).sort(),
      'Tiered (so allowlisted via BREEZE_MCP_TOOL_NAMES) but never shown to the model. A declaration on the script-builder server does not count: that server has its own tier map.',
    ).toEqual([]);
  });

  it('every agent-reachable tool is declared on the server the agent run builds (createBreezeMcpServer → buildBreezeSdkTools)', () => {
    const declared = declaredOnMainServer();
    expect(listAgentReachableTools().filter((n) => !declared.has(n))).toEqual([]);
  });
});

describe('SDK declarations carry registry search metadata (A-W02)', () => {
  const fakeAuth = () => { throw new Error('handlers must not run in this test'); };
  const raw = (() => {
    vi.stubEnv('M365_ENABLED', 'true');
    vi.stubEnv('GOOGLE_WORKSPACE_ENABLED', 'true');
    vi.stubEnv('BREEZE_AI_SCRIPT_AUTHORING_ENABLED', 'true');
    vi.stubEnv('FLOWS_ENABLED', 'true');
    try {
      return buildBreezeSdkTools(fakeAuth as never);
    } finally {
      vi.unstubAllEnvs();
    }
  })();
  const declared = raw.map(attachRegistryMeta);

  it('builds the full declared set', () => {
    expect(declared.length).toBeGreaterThan(140);
  });

  it('every declared tool has the registry hint in _meta and alwaysLoad only where the registry says so', () => {
    const bad = declared.filter((t) => {
      const meta = (t._meta ?? {}) as Record<string, unknown>;
      return meta['anthropic/searchHint'] !== getToolSearchHint(t.name)
        || (meta['anthropic/alwaysLoad'] === true) !== getToolAlwaysLoad(t.name);
    }).map((t) => t.name);
    expect(bad, 'declarations whose _meta disagrees with the registry').toEqual([]);
  });

  it('keeps name, description, schema and handler intact when attaching meta', () => {
    const byName = new Map(declared.map((t) => [t.name, t]));
    for (const t of raw) {
      const wrapped = byName.get(t.name)!;
      expect(wrapped.description).toBe(t.description);
      expect(Object.keys(wrapped.inputSchema)).toEqual(Object.keys(t.inputSchema));
      expect(wrapped.handler).toBe(t.handler);
    }
  });
});

import { checkGuardrails, requiredPermissionsForTool } from './aiGuardrails';
import { validateToolInput, toolInputSchemas } from './aiToolSchemas';
import { TOOL_SDK_INPUT_SHAPES } from './aiToolSchemasBackup';

describe('manage_delivery has every registration', () => {
  it('does not add a frozen-gap exception', () => {
    expect(getAllRegisteredToolNames()).toContain('manage_delivery');
    expect(TOOL_TIERS.manage_delivery).toBe(1);
  });
  it.each(['resolve', 'list_routing', 'list_escalation'])('%s is read-only', action => {
    expect(checkGuardrails('manage_delivery', { action }).tier).toBe(1);
    expect(requiredPermissionsForTool('manage_delivery', { action })).toEqual([{ resource: 'alerts', action: 'read' }]);
  });
  it.each(['create_routing','update_routing','delete_routing','set_default','create_escalation','update_escalation','delete_escalation'])('%s uses mutation tier and write permission', action => {
    expect(checkGuardrails('manage_delivery', { action })).toMatchObject({ tier: 3, requiresApproval: true, approvalScope: 'supervised' });
    expect(requiredPermissionsForTool('manage_delivery', { action })).toEqual([{ resource: 'alerts', action: 'write' }]);
  });
  it('fails closed on unknown actions', () => {
    expect(requiredPermissionsForTool('manage_delivery', { action: 'unknown' })).toBeNull();
    expect(validateToolInput('manage_delivery', { action: 'unknown' }).success).toBe(false);
  });
});

/** Spec 2026-09-23 W01: the read-only L1 tools wired this wave.
 * Pinned so a later wave cannot silently un-wire one. */
const W01_READ_TOOLS = [
  'browse_snapshots', 'get_backup_status', 'get_elevation_history', 'get_hyperv_vm_details', 'get_ip_history',
  'get_monitor', 'get_mssql_backup_status', 'get_network_changes', 'get_peripheral_activity', 'get_sla_breaches',
  'get_sla_compliance_report', 'get_software_compliance', 'get_user_risk_detail', 'get_user_risk_scores',
  'get_vault_status', 'get_vm_restore_estimate', 'list_monitors', 'list_remote_sessions', 'query_agent_versions',
  'query_analytics', 'query_backup_sla', 'query_c2c_jobs', 'query_compliance_policies', 'query_hyperv_vms',
  'query_mssql_instances', 'query_webhooks', 'search_c2c_items', 'search_script_library',
  // Held until their route-permission parity fixes landed.
  'generate_incident_report', 'get_browser_security', 'get_compliance_status', 'get_dr_execution_status',
  'get_dr_plan_details', 'get_executive_summary', 'get_incident_timeline', 'get_sensitive_data_overview',
  'query_backups', 'query_c2c_connections', 'query_custom_fields', 'query_dr_plans', 'query_psa_status',
  'query_vaults',
] as const;

describe('W01 read-only wiring (#6755)', () => {
  it('has 42 entries', () => expect(new Set(W01_READ_TOOLS).size).toBe(42));

  it.each(W01_READ_TOOLS)('%s is tier 1 in both maps, declared, and its SDK shape keys equal toolInputSchemas', (name) => {
    expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(1);
    expect(getToolTier(name)).toBe(1);
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    expect(Object.keys(decl!.inputSchema).sort()).toEqual(
      Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort(),
    );
  });
});


/** Spec 2026-09-23 W04 (#6758): security, incident and device-operation writes.
 * Pinned so a later wave cannot silently un-wire one. */
const W04_WRITE_TOOLS = [
  'execute_containment', 'create_incident', 'collect_evidence', 'request_elevation', 'revoke_elevation',
  'create_remote_session', 'manage_processes', 'manage_scheduled_tasks', 'registry_operations',
  'trigger_agent_restart', 'trigger_agent_upgrade', 'manage_software_policy', 'manage_browser_policy',
  'manage_peripheral_policy', 'remediate_sensitive_data', 'remediate_software_violation',
  'assign_security_training', 'configure_network_baseline', 'acknowledge_network_device',
] as const;

describe('W04 write wiring (#6758)', () => {
  it.each(W04_WRITE_TOOLS)('%s: TOOL_TIERS === registry tier, declared, SDK shape keys === Zod keys === registry keys', (name) => {
    expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(getToolTier(name));
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    const sdkKeys = Object.keys(decl!.inputSchema).sort();
    expect(sdkKeys).toEqual(
      Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort(),
    );
    // The SDK strips keys absent from its shape, so a registry-advertised key
    // missing here would vanish before validateToolInput ever saw it (the
    // manage_peripheral_policy `priority` drift, W04-D16).
    const registryKeys = Object.keys(
      (aiTools.get(name)!.definition.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    expect(sdkKeys).toEqual(registryKeys);
  });

  it('configure_network_baseline is registry tier 3 (W04-D7: arms recurring scans)', () => {
    expect(TOOL_TIERS.configure_network_baseline).toBe(3);
  });

  it('none of the W04 tools is alwaysLoad (they stay behind tool search)', () => {
    for (const name of W04_WRITE_TOOLS) expect(aiTools.get(name)!.alwaysLoad ?? false, name).toBe(false);
  });
});

/** Spec 2026-09-23 W02 (#6756): PSA and billing writes. Pinned so a later
 * wave cannot silently un-wire one. */
const W02_WRITE_TOOLS = [
  'manage_tickets', 'manage_quotes', 'manage_billing_catalog', 'manage_saved_filters',
  'manage_tags', 'manage_notification_channels', 'test_webhook',
] as const;

describe('W02 write wiring (#6756)', () => {
  it.each(W02_WRITE_TOOLS)('%s: TOOL_TIERS === registry tier, declared, SDK shape keys === toolInputSchemas', (name) => {
    expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(getToolTier(name));
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    expect(Object.keys(decl!.inputSchema).sort()).toEqual(
      Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort(),
    );
  });

  it('test_webhook is registry tier 3 (a real outbound POST)', () => {
    expect(TOOL_TIERS.test_webhook).toBe(3);
  });
});

/** Spec 2026-09-23 W03 (#6757): backup, DR and virtualization writes. Pinned
 * so a later wave cannot silently un-wire one. */
const W03_WRITE_TOOLS = [
  'trigger_backup', 'trigger_hyperv_backup', 'trigger_mssql_backup', 'trigger_vault_sync', 'trigger_c2c_sync',
  'verify_mssql_backup', 'restore_snapshot', 'restore_as_vm', 'restore_hyperv_vm', 'restore_mssql_database',
  'restore_c2c_items', 'instant_boot_vm', 'manage_hyperv_vm', 'manage_hyperv_checkpoints', 'manage_dr_plan',
  'execute_dr_plan', 'manage_backup_profiles', 'configure_backup_sla', 'configure_vault',
] as const;

/** The SDK shape a tool must declare: its plain z.object's shape, or its W03-D4 envelope. */
function expectedSdkShapeKeys(name: string): string[] {
  const envelope = TOOL_SDK_INPUT_SHAPES[name];
  if (envelope) return Object.keys(envelope).sort();
  return Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort();
}

describe('W03 write wiring (#6757)', () => {
  it.each(W03_WRITE_TOOLS)('%s: TOOL_TIERS === registry tier, declared, SDK shape keys === Zod keys === registry keys', (name) => {
    expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(getToolTier(name));
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    const sdkKeys = Object.keys(decl!.inputSchema).sort();
    expect(sdkKeys).toEqual(expectedSdkShapeKeys(name));
    // The SDK strips keys absent from its shape, so a registry-advertised key
    // missing here would vanish before validateToolInput ever saw it.
    const registryKeys = Object.keys(
      (aiTools.get(name)!.definition.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    expect(sdkKeys).toEqual(registryKeys);
  });

  it('the three tools escalated to supervised are registry tier 3 (W03 class review)', () => {
    for (const name of ['trigger_vault_sync', 'trigger_c2c_sync', 'verify_mssql_backup'] as const) {
      expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS], name).toBe(3);
    }
  });
});

/** Spec 2026-09-23 W11 (#6781): security policy tools. Pinned so a later wave cannot silently un-wire one. */
const W11_TOOLS = [
  'get_security_compliance', 'manage_security_recommendations', 'manage_access_reviews', 'manage_audit_baselines',
  'manage_compliance_policies', 'manage_security_policies', 'manage_recovery_keys', 'manage_pam_rules',
] as const;

describe('W11 security policy wiring (#6781)', () => {
  it.each(W11_TOOLS)('%s: TOOL_TIERS === registry tier, declared, SDK shape keys === Zod keys === registry keys', (name) => {
    expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(getToolTier(name));
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    const sdkKeys = Object.keys(decl!.inputSchema).sort();
    expect(sdkKeys).toEqual(
      Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort(),
    );
    const registryKeys = Object.keys(
      (aiTools.get(name)!.definition.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    expect(sdkKeys).toEqual(registryKeys);
  });

  it('manage_compliance_policies is registry tier 3 (W11-D4: deactivation is permanent)', () => {
    expect(TOOL_TIERS.manage_compliance_policies).toBe(3);
  });

  it('none of the W11 tools is alwaysLoad (they stay behind tool search)', () => {
    for (const name of W11_TOOLS) expect(aiTools.get(name)!.alwaysLoad ?? false, name).toBe(false);
  });
});

/** Spec 2026-09-23 W12 (#6782): software, fleet-finding and custom-field tools. Pinned so a later wave cannot silently un-wire one. */
const W12_TOOLS = [
  'manage_software_catalog', 'search_packages', 'manage_software_deployments', 'get_device_software', 'manage_device_software',
  'manage_software_inventory', 'bootstrap_homebrew', 'manage_fleet_findings', 'manage_custom_fields',
] as const;

describe('W12 software tool wiring (#6782)', () => {
  it.each(W12_TOOLS)('%s: TOOL_TIERS === registry tier, declared, SDK shape keys === Zod keys === registry keys', (name) => {
    expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(getToolTier(name));
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    const sdkKeys = Object.keys(decl!.inputSchema).sort();
    expect(sdkKeys).toEqual(
      Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort(),
    );
    const registryKeys = Object.keys(
      (aiTools.get(name)!.definition.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    expect(sdkKeys).toEqual(registryKeys);
  });

  it('the device-reaching single-purpose tools are registry tier 3', () => {
    expect(TOOL_TIERS.manage_device_software).toBe(3);
    expect(TOOL_TIERS.bootstrap_homebrew).toBe(3);
  });

  it('none of the W12 tools is alwaysLoad (they stay behind tool search)', () => {
    for (const name of W12_TOOLS) expect(aiTools.get(name)!.alwaysLoad ?? false, name).toBe(false);
  });
});

/** Spec 2026-09-23 W13 (#6783, PR A): device inventory and record tools. Pinned so a later wave cannot silently un-wire one. */
const W13_TOOLS = [
  'get_device_events', 'get_device_health', 'get_process_samples', 'get_management_posture',
  'manage_device_function', 'manage_device_links', 'manage_manual_assets', 'manage_device_warranty',
  // PR B.
  'browse_device_event_log', 'manage_tenant_variables', 'manage_support_sessions',
] as const;

const W14_TOOLS = [
  'manage_billing_profiles', 'manage_billing_settings', 'manage_contract_templates', 'manage_contract_documents',
  'get_device_billing',
] as const;

describe('W14 billing lifecycle wiring (#6784, PR A)', () => {
  it.each(W14_TOOLS)('%s: TOOL_TIERS === registry tier 1, declared, SDK shape keys === Zod keys === registry keys', (name) => {
    expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(getToolTier(name));
    expect(getToolTier(name)).toBe(1);
    expect(aiTools.get(name)!.alwaysLoad ?? false, name).toBe(false);
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    const sdkKeys = Object.keys(decl!.inputSchema).sort();
    expect(sdkKeys).toEqual(
      Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort(),
    );
    const registryKeys = Object.keys(
      (aiTools.get(name)!.definition.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    expect(sdkKeys).toEqual(registryKeys);
  });

  it.each([
    ['get_contract', 'periodId'], ['list_contracts', 'view'], ['list_contracts', 'cursor'],
    ['get_invoice', 'lineId'], ['get_invoice', 'limit'], ['get_invoice', 'cursor'],
  ])('%s carries the additive %s selector on all three input surfaces', (name, key) => {
    const props = (aiTools.get(name)!.definition.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toContain(key);
    expect(Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape)).toContain(key);
    expect(Object.keys(declaredToolsByName().get(name)!.inputSchema)).toContain(key);
  });
});

describe('W14 PR B wiring (#6784)', () => {
  it.each(['manage_accounting_sync', 'manage_contracts'])('%s: declared, SDK shape keys === Zod keys === registry keys', (name) => {
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    const sdkKeys = Object.keys(decl!.inputSchema).sort();
    expect(sdkKeys).toEqual(
      Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort(),
    );
    const registryKeys = Object.keys(
      (aiTools.get(name)!.definition.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    expect(sdkKeys).toEqual(registryKeys);
  });

  it('manage_accounting_sync is tier 1 at the registry and TOOL_TIERS, not alwaysLoad, self-managed', () => {
    expect(TOOL_TIERS.manage_accounting_sync).toBe(getToolTier('manage_accounting_sync'));
    expect(getToolTier('manage_accounting_sync')).toBe(1);
    expect(aiTools.get('manage_accounting_sync')!.alwaysLoad ?? false).toBe(false);
    expect(aiTools.get('manage_accounting_sync')!.selfManagedDbContext).toBe(true);
  });

  it('manage_contracts opts only generate_invoice out of the per-call transaction', () => {
    expect(aiTools.get('manage_contracts')!.selfManagedDbContext).toEqual(['generate_invoice']);
  });
});

describe('W13 device inventory and ops wiring (#6783)', () => {
  it.each(W13_TOOLS)('%s: TOOL_TIERS === registry tier, declared, SDK shape keys === Zod keys === registry keys', (name) => {
    expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS]).toBe(getToolTier(name));
    const decl = declaredToolsByName().get(name);
    expect(decl, `${name} not declared`).toBeDefined();
    const sdkKeys = Object.keys(decl!.inputSchema).sort();
    expect(sdkKeys).toEqual(
      Object.keys((toolInputSchemas[name as keyof typeof toolInputSchemas] as unknown as { shape: Record<string, unknown> }).shape).sort(),
    );
    const registryKeys = Object.keys(
      (aiTools.get(name)!.definition.input_schema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    expect(sdkKeys).toEqual(registryKeys);
  });

  it('every W13 tool is registry tier 1 (writes are classed per action)', () => {
    for (const name of W13_TOOLS) expect(TOOL_TIERS[name as keyof typeof TOOL_TIERS], name).toBe(1);
  });

  it('none of the W13 tools is alwaysLoad (they stay behind tool search)', () => {
    for (const name of W13_TOOLS) expect(aiTools.get(name)!.alwaysLoad ?? false, name).toBe(false);
  });

  it('search_agent_logs carries the additive source filter on all three input surfaces', () => {
    const props = (aiTools.get('search_agent_logs')!.definition.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.source?.enum).toEqual(['agent', 'watchdog']);
    expect(Object.keys((toolInputSchemas.search_agent_logs as unknown as { shape: Record<string, unknown> }).shape)).toContain('source');
    expect(Object.keys(declaredToolsByName().get('search_agent_logs')!.inputSchema)).toContain('source');
  });
});

describe('SDK declarations use the registry description (A-W03, one description surface)', () => {
  const configurations = [
    { M365_ENABLED: 'false', GOOGLE_WORKSPACE_ENABLED: 'false', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'false', DELEGANT_BASE_URL: '' },
    { M365_ENABLED: 'true', GOOGLE_WORKSPACE_ENABLED: 'true', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'true', DELEGANT_BASE_URL: '' },
    { M365_ENABLED: 'false', GOOGLE_WORKSPACE_ENABLED: 'false', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'false', DELEGANT_BASE_URL: 'https://delegant.example.com' },
  ];

  it.each(configurations)('every emitted tool uses its canonical description (%j)', config => {
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    try {
      const declared = buildBreezeSdkTools(() => { throw new Error('no handlers'); });
      const drift = declared
        .filter(t => t.description !== (aiTools.get(t.name)?.definition.description
          ?? SESSION_TOOL_DESCRIPTIONS[t.name as keyof typeof SESSION_TOOL_DESCRIPTIONS]))
        .map(t => t.name);
      expect(drift, 'declarations with their own description literal').toEqual([]);
      if (config.M365_ENABLED === 'true') {
        expect(declared.filter(t => !aiTools.has(t.name)).map(t => t.name).sort())
          .toEqual(Object.keys(SESSION_TOOL_DESCRIPTIONS).sort());
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('registry description reconciliation', () => {
  it.each(['s1_isolate_device', 's1_threat_action', 'execute_playbook'])('preserves approval guidance for %s', name => {
    expect(aiTools.get(name)!.definition.description).toMatch(/Requires user approval/);
  });

  it('fails server construction for an unknown registry name', () => {
    const original = aiTools.get('query_devices')!;
    aiTools.delete('query_devices');
    try {
      expect(() => buildBreezeSdkTools(() => { throw new Error('no handlers'); }))
        .toThrow('No aiTools registry description for tool "query_devices"');
    } finally { aiTools.set('query_devices', original); }
  });

  it('keeps session descriptors on budget', () => {
    for (const description of Object.values(SESSION_TOOL_DESCRIPTIONS)) {
      expect(description.length).toBeLessThanOrEqual(300);
    }
  });
});

/**
 * #10161: the chat SDK validates against its DECLARED shape, not the registry JSON schema MCP advertises. An
 * action the registry lists but the SDK enum lacks is rejected in chat while MCP accepts it (manage_tickets
 * merge_preview/merge; system_cleanup's hand-written enum). Every declared action enum must equal the registry's.
 */
/**
 * Pre-existing drift found when this check landed (#10161), out of that issue's scope and tracked for a
 * follow-up. FROZEN, shrink-only: fix the drift and delete the entry; never add one.
 *   manage_alerts      registry `suppress`, SDK lacks it (chat cannot suppress)
 *   generate_report    registry `download`, SDK lacks it
 *   manage_automations / manage_maintenance_windows  SDK allows create/update/delete the registry does not list
 */
const KNOWN_SDK_ACTION_ENUM_DRIFT: ReadonlySet<string> = new Set([
  'manage_alerts', 'generate_report', 'manage_automations', 'manage_maintenance_windows',
]);

describe('SDK action enum === registry action enum (#10161)', () => {
  function actionEnumDrift(): string[] {
    const drift: string[] = [];
    for (const [name, decl] of declaredToolsByName()) {
      const sdkAction = (decl.inputSchema as Record<string, { options?: unknown[] } | undefined>).action;
      const registryEnum = (aiTools.get(name)?.definition.input_schema as { properties?: { action?: { enum?: string[] } } } | undefined)
        ?.properties?.action?.enum;
      if (!Array.isArray(sdkAction?.options) || !registryEnum) continue;
      const sdk = (sdkAction.options as string[]).slice().sort();
      const registry = [...registryEnum].sort();
      if (JSON.stringify(sdk) !== JSON.stringify(registry)) drift.push(name);
    }
    return drift.sort();
  }

  it('every declared tool with an action enum matches its registry definition', () => {
    expect(actionEnumDrift().filter((n) => !KNOWN_SDK_ACTION_ENUM_DRIFT.has(n))).toEqual([]);
  });

  it('pins the two tools #10161 fixed: the declared chat shapes parse merge and cancel payloads', () => {
    const drift = actionEnumDrift();
    expect(drift).not.toContain('manage_tickets');
    expect(drift).not.toContain('system_cleanup');
    const declared = declaredToolsByName();
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const tickets = z.object(declared.get('manage_tickets')!.inputSchema as z.ZodRawShape)
      .safeParse({ action: 'merge', ticketId: A, intoTicketId: B, notifyRequester: false });
    expect(tickets.success).toBe(true);
    expect((tickets.data as Record<string, unknown>).intoTicketId).toBe(B); // not stripped
    expect(z.object(declared.get('system_cleanup')!.inputSchema as z.ZodRawShape)
      .safeParse({ deviceId: A, action: 'cancel', cleanupRunId: B }).success).toBe(true);
  });

  it('KNOWN_SDK_ACTION_ENUM_DRIFT has no stale entries — the list may only shrink', () => {
    expect([...KNOWN_SDK_ACTION_ENUM_DRIFT].sort()).toEqual(actionEnumDrift().filter((n) => KNOWN_SDK_ACTION_ENUM_DRIFT.has(n)));
  });
});
