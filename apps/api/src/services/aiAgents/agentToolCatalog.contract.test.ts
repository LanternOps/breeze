import { describe, it, expect } from 'vitest';
import { aiTools } from '../aiToolNames';
import '../aiTools'; // populates the registry
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { m365ToolTiers } from '../aiToolsM365';
import { googleToolTiers } from '../aiToolsGoogle';
import { AGENT_DENIED_READ_TOOLS, AGENT_HUMAN_ONLY_TOOLS, BLOCKED_TOOLS, isNeverAgentTool } from '../aiGuardrails';
import { isSecretBearingTool } from '../actionIntents/secretBearingTools';
import { isPolicyDecidableKey, POLICY_DECIDABLE_TIER3 } from '../actionIntents/policyDecidable';
import {
  AGENT_CAPABILITIES, TOOL_CAPABILITY, AGENT_KIND_PRESETS,
  listAgentReachableTools, listUnreachableRegisteredTools, buildAgentToolCatalog,
} from './agentToolCatalog';

const capabilityIds = new Set(AGENT_CAPABILITIES.map((c) => c.id));

describe('agentToolCatalog contract', () => {
  it('maps EVERY registered headless tool to a capability, and nothing else', () => {
    const registered = [...aiTools.keys()].sort();
    const mapped = Object.keys(TOOL_CAPABILITY).sort();
    expect(mapped).toEqual(registered);
    for (const id of Object.values(TOOL_CAPABILITY)) expect(capabilityIds.has(id)).toBe(true);
  });

  it('reachable = registry ∩ TOOL_TIERS − session-only − human-only − blocked − secret-bearing', () => {
    const reachable = new Set(listAgentReachableTools());
    for (const name of reachable) {
      expect(aiTools.has(name)).toBe(true);
      expect(name in TOOL_TIERS).toBe(true);
      expect(name in m365ToolTiers).toBe(false);
      expect(name in googleToolTiers).toBe(false);
      expect(AGENT_HUMAN_ONLY_TOOLS.has(name)).toBe(false);
      // AGENT_DENIED_READ_TOOLS (W01-D5, quorum amendment WQ1/WQ2, #6755): a
      // sensitive tier-1 read denied to headless agents must never be
      // reachable either.
      expect(AGENT_DENIED_READ_TOOLS.has(name)).toBe(false);
      // Same runtime deny set `checkAgentGuardrails` enforces unconditionally
      // (aiGuardrails.ts ~1692-1697): a blocked or secret-bearing tool must
      // never be reachable, even though nothing in the current headless
      // registry actually trips either check today (BLOCKED_TOOLS is empty;
      // the two SECRET_BEARING_TOOLS are session-only and excluded above
      // already) — this pins the exclusion so it still holds the day either
      // set gains a headless member.
      expect(BLOCKED_TOOLS.has(name)).toBe(false);
      expect(isSecretBearingTool(name)).toBe(false);
      // isNeverAgentTool (WQ4) is the single predicate both this function and
      // checkAgentGuardrails now share — a reachable name must never trip it.
      expect(isNeverAgentTool(name)).toBe(false);
    }
    for (const name of aiTools.keys()) {
      if (name in TOOL_TIERS && !AGENT_HUMAN_ONLY_TOOLS.has(name) && !AGENT_DENIED_READ_TOOLS.has(name)) {
        expect(reachable.has(name)).toBe(true);
      }
    }
  });

  it('pins the unreachable set so a reachability change is a deliberate edit (#3300)', () => {
    // Every registered tool NOT in the reachable set: absent from TOOL_TIERS,
    // OR excluded by the same runtime-deny filters as `listAgentReachableTools`
    // (session-only, human-only, blocked, secret-bearing). Widening
    // reachability is a product decision; update this snapshot WITH the
    // registry/guardrail change that makes it true, never on its own.
    expect(listUnreachableRegisteredTools()).toMatchSnapshot();
  });

  it('W01 (#6755): every AGENT_DENIED_READ_TOOLS entry stays unreachable, and the newly-wired reads are reachable', () => {
    const unreachable = new Set(listUnreachableRegisteredTools());
    for (const name of AGENT_DENIED_READ_TOOLS.keys()) {
      expect(unreachable.has(name), `${name} is in AGENT_DENIED_READ_TOOLS but reachable`).toBe(true);
    }
    const reachable = new Set(listAgentReachableTools());
    for (const name of ['browse_snapshots', 'list_scripts', 'query_backup_sla']) {
      expect(reachable.has(name), `${name} should be agent-reachable after W01 wiring`).toBe(true);
    }
  });

  it('unreachableTools ∪ reachable = every registered tool name, and the two sets are disjoint (Task 7, #5049)', () => {
    const reachable = new Set(listAgentReachableTools());
    const unreachable = new Set(listUnreachableRegisteredTools());
    const registered = new Set(aiTools.keys());
    for (const name of reachable) expect(unreachable.has(name)).toBe(false);
    for (const name of unreachable) expect(reachable.has(name)).toBe(false);
    expect(new Set([...reachable, ...unreachable])).toEqual(registered);
    // A concrete, non-vacuous member: registered + in TOOL_TIERS, but
    // AGENT_HUMAN_ONLY_TOOLS — so `listUnreachableRegisteredTools` must widen
    // beyond a bare `!(name in TOOL_TIERS)` filter to catch it.
    expect(unreachable.has('manage_ai_agents')).toBe(true);
  });

  it("buildAgentToolCatalog's DTO carries unreachableTools matching listUnreachableRegisteredTools() (Task 7, #5049)", () => {
    const catalog = buildAgentToolCatalog();
    expect(catalog.unreachableTools).toEqual(listUnreachableRegisteredTools());
  });

  it('every preset entry names a reachable, mutating operation', () => {
    const catalog = buildAgentToolCatalog();
    const opsByKey = new Map(catalog.tools.flatMap((t) => t.operations.map((op) => [op.key, op] as const)));
    for (const entries of Object.values(AGENT_KIND_PRESETS)) {
      for (const entry of entries) {
        const op = opsByKey.get(entry);
        expect(op, `${entry} is not a catalog operation`).toBeDefined();
        expect(op!.readOnly, `${entry} is read-only; read tools are always on`).toBe(false);
      }
    }
  });

  it('the designer preset is empty: it reaches reads by the guardrail rule and one outcome tool', () => {
    expect(AGENT_KIND_PRESETS.designer).toEqual([]);
    expect(buildAgentToolCatalog().presets.designer).toEqual([]);
  });

  it('operations carry tiers from checkGuardrails and flags from the registries', () => {
    const catalog = buildAgentToolCatalog();
    const services = catalog.tools.find((t) => t.name === 'manage_services')!;
    const byAction = Object.fromEntries(services.operations.map((op) => [op.action, op]));
    expect(byAction.list).toMatchObject({ readOnly: true });
    expect(byAction.restart).toMatchObject({ tier: 3, readOnly: false, policyDecidable: true, actEligible: true });
    expect(byAction.start).toMatchObject({ tier: 3, policyDecidable: true, actEligible: false });
    for (const tool of catalog.tools) for (const op of tool.operations) {
      expect(op.policyDecidable).toBe(isPolicyDecidableKey(op.key));
    }
    const cmd = catalog.tools.find((t) => t.name === 'execute_command')!;
    expect(cmd.operations.some((op) => op.action === 'restart_service' && op.tier === 3)).toBe(true);
  });

  it('actEligible is derived from ACT_MANIFEST membership, not a synthetic-input matches() probe', () => {
    // run_script/execute_playbook match on scriptId / playbookId+deviceId — a
    // synthetic `{}` or `{ action }` input never carries those, so probing
    // `resolveActOperation` here always came back null for bare-tool
    // ACT_MANIFEST members even though they ARE act-eligible.
    const catalog = buildAgentToolCatalog();
    const runScript = catalog.tools.find((t) => t.name === 'run_script')!;
    expect(runScript.operations).toHaveLength(1);
    expect(runScript.operations[0]).toMatchObject({ key: 'run_script', actEligible: true });

    const executePlaybook = catalog.tools.find((t) => t.name === 'execute_playbook')!;
    expect(executePlaybook.operations).toHaveLength(1);
    expect(executePlaybook.operations[0]).toMatchObject({ key: 'execute_playbook', actEligible: true });

    const services = catalog.tools.find((t) => t.name === 'manage_services')!;
    const byAction = Object.fromEntries(services.operations.map((op) => [op.action, op]));
    expect(byAction.start).toMatchObject({ actEligible: false });

    const diskCleanup = catalog.tools.find((t) => t.name === 'disk_cleanup')!;
    const byDiskAction = Object.fromEntries(diskCleanup.operations.map((op) => [op.action, op]));
    expect(byDiskAction.execute).toMatchObject({ actEligible: true });
  });

  it('flags run_script — and only run_script — as needing an authorized script before it runs unattended (#5048 QA)', () => {
    // Mirrors agentService.ts's hasActEligibleSurface and
    // remediationActResolver.ts: run_script is in ACT_MANIFEST but is never
    // dispatched unattended for a script absent from actAssets.scriptIds.
    const catalog = buildAgentToolCatalog();
    const gated = catalog.tools.flatMap((t) => t.operations).filter((op) => op.actRequiresAuthorizedScripts);
    expect(gated.map((op) => op.key)).toEqual(['run_script']);
    expect(gated[0]).toMatchObject({ actEligible: true });
    for (const tool of catalog.tools) for (const op of tool.operations) {
      expect(typeof op.actRequiresAuthorizedScripts).toBe('boolean');
    }
  });

  it('every catalog tool has at least one operation and a single-operation tool uses the bare key', () => {
    for (const tool of buildAgentToolCatalog().tools) {
      expect(tool.operations.length).toBeGreaterThan(0);
      const [first] = tool.operations;
      if (tool.operations.length === 1 && first && first.action === null) expect(first.key).toBe(tool.name);
    }
  });
});

it('makes delivery reachable without changing prior frozen gaps', () => {
  expect(TOOL_CAPABILITY.manage_delivery).toBe('alerts_monitoring');
  expect(listAgentReachableTools()).toContain('manage_delivery');
  expect(listUnreachableRegisteredTools()).not.toContain('manage_delivery');
  // manage_notification_channels was a frozen gap until full-control W02
  // (#6756) wired it; see the W02 pins below.
});

/** Spec 2026-09-23 W04 (#6758): every W04 tool is agent-reachable; its writes
 * are allowlisted (t2) or proposals (supervised / four-eyes), never unattended. */
const W04_AGENT_CAPABILITY: Readonly<Record<string, string>> = {
  execute_containment: 'security_response', create_incident: 'security_response', collect_evidence: 'security_response',
  request_elevation: 'security_response', revoke_elevation: 'security_response', remediate_sensitive_data: 'security_response',
  assign_security_training: 'security_response', create_remote_session: 'remote_access',
  manage_processes: 'scripts_commands', manage_scheduled_tasks: 'scripts_commands', registry_operations: 'scripts_commands',
  trigger_agent_restart: 'endpoint_agent', trigger_agent_upgrade: 'endpoint_agent',
  manage_software_policy: 'patching_software', remediate_software_violation: 'patching_software',
  manage_browser_policy: 'config_policies', manage_peripheral_policy: 'config_policies',
  configure_network_baseline: 'network', acknowledge_network_device: 'network',
};

describe('W04 security/device-ops writes in the agent catalog (#6758)', () => {
  it('pins all 19 W04 tools', () => {
    expect(Object.keys(W04_AGENT_CAPABILITY)).toHaveLength(19);
  });

  it.each(Object.entries(W04_AGENT_CAPABILITY))('%s is agent-reachable under %s', (name, capability) => {
    expect(listAgentReachableTools()).toContain(name);
    expect(listUnreachableRegisteredTools()).not.toContain(name);
    expect(TOOL_CAPABILITY[name]).toBe(capability);
  });

  it('only the pre-existing scheduled-task keys are pre-authorisable; every other W04 tier-3 call is a proposal', () => {
    // manage_scheduled_tasks run/disable/enable were quorum-approved policy-
    // decidable keys before W04 (policyDecidableKeys.ts, the manage_services:
    // restart class: one device, one named task). Wiring the tool makes them
    // live for an agent an admin explicitly grants them to (W04 PR, Todd).
    const decidable = POLICY_DECIDABLE_TIER3.map((e) => e.key).filter((key) => key.split(':')[0]! in W04_AGENT_CAPABILITY);
    expect(decidable.sort()).toEqual(['manage_scheduled_tasks:disable', 'manage_scheduled_tasks:enable', 'manage_scheduled_tasks:run']);
  });

  it('W04-D8: the picker never offers manage_groups add_devices/remove_devices (agent human-only actions)', () => {
    const groups = buildAgentToolCatalog().tools.find((t) => t.name === 'manage_groups');
    expect(groups, 'manage_groups is agent-reachable').toBeDefined();
    const keys = groups!.operations.map((op) => op.key);
    expect(keys).not.toContain('manage_groups:add_devices');
    expect(keys).not.toContain('manage_groups:remove_devices');
    expect(keys).toContain('manage_groups:list');
  });
});

/** Spec 2026-09-23 W06 (#6776): the seven PSA configuration / ticket-ops tools are agent-reachable
 * under `tickets`. An agent reads; every write is a proposal (supervised / four-eyes) or an
 * allowlisted tier-2 call, and each write handler refuses an `ai_agent` principal (W06-D8). */
const W06_AGENT_CAPABILITY: Readonly<Record<string, string>> = {
  manage_ticket_config: 'tickets', manage_ticket_checklist_templates: 'tickets', manage_ticket_inbox: 'tickets',
  manage_ticket_attachments: 'tickets', manage_ticket_forms: 'tickets', manage_ticket_response_templates: 'tickets',
  manage_time_suggestions: 'tickets',
};

describe('W06 PSA configuration and ticket ops in the agent catalog (#6776)', () => {
  it('pins all seven W06 tools', () => {
    expect(Object.keys(W06_AGENT_CAPABILITY)).toHaveLength(7);
  });

  it.each(Object.entries(W06_AGENT_CAPABILITY))('%s is agent-reachable under %s', (name, capability) => {
    expect(listAgentReachableTools()).toContain(name);
    expect(listUnreachableRegisteredTools()).not.toContain(name);
    expect(TOOL_CAPABILITY[name]).toBe(capability);
  });

  it('no W06 tier-3 key is pre-authorisable for an agent (every such call is a proposal)', () => {
    const decidable = POLICY_DECIDABLE_TIER3.map((e) => e.key).filter((key) => key.split(':')[0]! in W06_AGENT_CAPABILITY);
    expect(decidable).toEqual([]);
  });

  it('the picker offers the tier-1 reads as read-only operations and the inbox list / attachment read as allowlisted tier 2', () => {
    const tools = buildAgentToolCatalog().tools;
    const op = (tool: string, action: string) => tools.find((t) => t.name === tool)!.operations.find((o) => o.key === `${tool}:${action}`)!;
    for (const [tool, action] of [
      ['manage_ticket_config', 'get_config'], ['manage_ticket_config', 'list_categories'], ['manage_ticket_checklist_templates', 'list'],
      ['manage_ticket_attachments', 'list'], ['manage_ticket_forms', 'list'], ['manage_ticket_response_templates', 'list'],
    ] as const) {
      expect(op(tool, action), `${tool}:${action}`).toMatchObject({ tier: 1, readOnly: true });
    }
    // Plain tier 2, not read-only: an agent needs an allowlist entry (quorum QW1).
    expect(op('manage_ticket_inbox', 'list')).toMatchObject({ tier: 2, readOnly: false });
    expect(op('manage_ticket_attachments', 'read_content')).toMatchObject({ tier: 2, readOnly: false });
    // Writes: supervised or four-eyes are tier 3.
    expect(op('manage_ticket_config', 'create_category').tier).toBe(3);
    expect(op('manage_ticket_config', 'delete_domain').tier).toBe(3);
    expect(op('manage_ticket_forms', 'delete').tier).toBe(3);
    expect(op('manage_ticket_attachments', 'delete').tier).toBe(3);
  });
});

// Spec 2026-09-23 W02 (#6756): PSA and billing write tools are agent-reachable.
// Their tier-3 actions still become proposals for a human (none is
// policy-decidable), and manage_tags add/remove stay human-only (QV2).
const W02_AGENT_REACHABLE = [
  'manage_tickets', 'manage_quotes', 'manage_billing_catalog', 'manage_saved_filters',
  'manage_tags', 'manage_notification_channels', 'test_webhook',
] as const;

describe('W02 PSA/billing writes in the agent catalog (#6756)', () => {
  it.each(W02_AGENT_REACHABLE)('%s is agent-reachable', (name) => {
    expect(listAgentReachableTools()).toContain(name);
    expect(listUnreachableRegisteredTools()).not.toContain(name);
  });

  it('places the billing catalog under business and tickets under tickets', () => {
    expect(TOOL_CAPABILITY.manage_billing_catalog).toBe('business');
    expect(TOOL_CAPABILITY.manage_tickets).toBe('tickets');
    expect('manage_catalog' in TOOL_CAPABILITY).toBe(false);
  });
});

/** Spec 2026-09-23 W03 (#6757): every W03 tool is agent-reachable; its writes
 * are allowlisted (t2) or proposals (supervised / four-eyes), never unattended. */
const W03_AGENT_REACHABLE = [
  'trigger_backup', 'trigger_hyperv_backup', 'trigger_mssql_backup', 'trigger_vault_sync', 'trigger_c2c_sync',
  'verify_mssql_backup', 'restore_snapshot', 'restore_as_vm', 'restore_hyperv_vm', 'restore_mssql_database',
  'restore_c2c_items', 'instant_boot_vm', 'manage_hyperv_vm', 'manage_hyperv_checkpoints', 'manage_dr_plan',
  'execute_dr_plan', 'manage_backup_profiles', 'configure_backup_sla', 'configure_vault',
] as const;

describe('W03 backup/DR writes in the agent catalog (#6757)', () => {
  it.each(W03_AGENT_REACHABLE)('%s is agent-reachable under backup_recovery', (name) => {
    expect(listAgentReachableTools()).toContain(name);
    expect(listUnreachableRegisteredTools()).not.toContain(name);
    expect(TOOL_CAPABILITY[name]).toBe('backup_recovery');
  });

  it('no W03 tier-3 key is pre-authorisable for an agent (every such call is a proposal)', () => {
    const w03 = new Set<string>(W03_AGENT_REACHABLE);
    const decidable = POLICY_DECIDABLE_TIER3.map((e) => e.key).filter((key) => w03.has(key.split(':')[0]!));
    expect(decidable).toEqual([]);
  });
});
