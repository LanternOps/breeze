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
  missing: ReadonlySet<string>,
): string[] {
  return [...map].flatMap(([name, reason]) => [
    ...(!registered.has(name) ? [`${name}: not registered`] : []),
    ...(name in tiers ? [`${name}: also in TOOL_TIERS — human-only means never tiered`] : []),
    ...(missing.has(name) ? [`${name}: also in KNOWN_MISSING_TOOL_TIERS`] : []),
    ...(reason.trim().length < 20 ? [`${name}: reason must say why (>= 20 chars)`] : []),
  ]);
}

/**
 * Registered tools with no `TOOL_TIERS` entry, and therefore invisible to
 * chat. Frozen as of #3300 (measured against f400fc315: 215 registered, 133
 * tiered, 86 missing); re-frozen at 88 on d1cbf4fe27 for the spec
 * 2026-09-23 W01-W04 rollout. W01 (#6755) wired 26 read-only tools,
 * leaving 62 (16 further read-only tools are held for a follow-up PR).
 * Deleted entirely at the end of W04, not W01.
 *
 * **This list may only shrink.** Removing a name means the tool was given a
 * tier and is now reachable. Adding one means a new tool shipped mute, which
 * is exactly what this file exists to prevent — fix the tool, don't widen the
 * list.
 */
const KNOWN_MISSING_TOOL_TIERS: ReadonlySet<string> = new Set([
  'acknowledge_network_device',
  'assign_security_training',
  'collect_evidence',
  'configure_backup_sla',
  'configure_network_baseline',
  'configure_vault',
  'create_incident',
  'create_remote_session',
  'execute_containment',
  'execute_dr_plan',
  'generate_incident_report',
  'get_browser_security',
  'get_compliance_status',
  'get_dr_execution_status',
  'get_dr_plan_details',
  'get_executive_summary',
  'get_incident_timeline',
  'get_monitor',
  'get_sensitive_data_overview',
  'instant_boot_vm',
  'list_monitors',
  'manage_backup_profiles',
  'manage_browser_policy',
  'manage_catalog',
  'manage_dr_plan',
  'manage_hyperv_checkpoints',
  'manage_hyperv_vm',
  'manage_monitor_definitions',
  'manage_notification_channels',
  'manage_peripheral_policy',
  'manage_processes',
  'manage_quotes',
  'manage_saved_filters',
  'manage_scheduled_tasks',
  'manage_software_policy',
  'manage_tags',
  'manage_tickets',
  'query_backups',
  'query_c2c_connections',
  'query_custom_fields',
  'query_dr_plans',
  'query_psa_status',
  'query_vaults',
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
  'propose_action_plan',
]);

describe('aiTools registry ⊆ TOOL_TIERS — a registered tool must be reachable from chat (#3300)', () => {
  it('every registered tool is tiered, human-only with a reason, or a known pre-existing gap', () => {
    const uncovered = getAllRegisteredToolNames()
      .filter((n) => !(n in TOOL_TIERS) && !HUMAN_ONLY_TOOLS.has(n) && !KNOWN_MISSING_TOOL_TIERS.has(n))
      .sort();
    expect(
      uncovered,
      'Give the tool a TOOL_TIERS entry, or list it in HUMAN_ONLY_TOOLS (aiToolExposure.ts) with a written reason. Never widen KNOWN_MISSING_TOOL_TIERS.',
    ).toEqual([]);
  });

  it('HUMAN_ONLY_TOOLS entries are registered, untiered, not also KNOWN_MISSING, and carry a reason', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const bad = humanOnlyProblems(HUMAN_ONLY_TOOLS, registered, TOOL_TIERS, KNOWN_MISSING_TOOL_TIERS);
    expect(bad).toEqual([]);
  });

  it('humanOnlyProblems is not vacuous — it flags a tiered entry and a too-short reason', () => {
    const bad = humanOnlyProblems(
      new Map([['query_devices', 'x']]),
      new Set(['query_devices']),
      TOOL_TIERS,
      new Set(),
    );
    expect(bad).toEqual([
      'query_devices: also in TOOL_TIERS — human-only means never tiered',
      'query_devices: reason must say why (>= 20 chars)',
    ]);
  });

  it('KNOWN_MISSING_TOOL_TIERS contains no stale entries — the list may only shrink', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const resolved = [...KNOWN_MISSING_TOOL_TIERS]
      .filter((name) => name in TOOL_TIERS || HUMAN_ONLY_TOOLS.has(name) || !registered.has(name))
      .sort();

    expect(
      resolved,
      'These names are in KNOWN_MISSING_TOOL_TIERS but are no longer missing ' +
        '(they now have a tier, are human-only, or are no longer registered). Delete them from ' +
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
  DELEGANT_BASE_URL: 'https://delegant.example.com',
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

describe('manage_delivery has every registration', () => {
  it('does not add a frozen-gap exception', () => {
    expect(getAllRegisteredToolNames()).toContain('manage_delivery');
    expect(TOOL_TIERS.manage_delivery).toBe(1);
    expect(KNOWN_MISSING_TOOL_TIERS.has('manage_delivery')).toBe(false);
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
  'get_mssql_backup_status', 'get_network_changes', 'get_peripheral_activity', 'get_sla_breaches',
  'get_sla_compliance_report', 'get_software_compliance', 'get_user_risk_detail', 'get_user_risk_scores',
  'get_vault_status', 'get_vm_restore_estimate', 'list_remote_sessions', 'query_agent_versions',
  'query_analytics', 'query_backup_sla', 'query_c2c_jobs', 'query_compliance_policies', 'query_hyperv_vms',
  'query_mssql_instances', 'query_webhooks', 'search_c2c_items', 'search_script_library',
] as const;

describe('W01 read-only wiring (#6755)', () => {
  it('has 26 entries', () => expect(new Set(W01_READ_TOOLS).size).toBe(26));

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
