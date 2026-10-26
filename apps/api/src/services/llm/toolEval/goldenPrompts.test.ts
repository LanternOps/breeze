import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from '../../aiAgentSdkTools';
import { aiTools } from '../../aiToolNames';
import '../../aiTools';
import { GOLDEN_CASES } from './goldenPrompts';

// A-W02 Task 5 declares the currently mute documentation tool; remove this set then.
const PENDING_DECLARATION = new Set<string>([]); // search_documentation was declared by A-W02 (#6341)

// The plan's fixed prompts also referenced pre-existing #3300 gaps (the
// KNOWN_MISSING_TOOL_TIERS list, emptied and deleted in full-control W04 #6758).
// Preserve them in the eval: unavailable tools must still count as misses, not
// disappear from the baseline. A-W01 must not change product tool exposure.
// Frozen at A-W01; only shrink this set as declarations land. Unlike the g57
// exception above, these tools are not promised declarations by A-W02.
//
// Spec 2026-09-23 W01 (#6755) declared 11 of these (the L1 reads it wired);
// removed here rather than left stale, per this test's own "now declared;
// remove the exception" assertion below. W02 (#6756) declared manage_quotes,
// manage_tags and manage_tickets. W03 (#6757) declared restore_snapshot,
// trigger_backup and trigger_mssql_backup, which empties the set.
const BASELINE_UNDECLARED_TOOLS = new Set<string>([]);

describe('GOLDEN_CASES', () => {
  it('has 99 unique ids', () => {
    // g68 (#8167 W03): EDR-framework containment. g69 (#8167 W03 PR-B): EDR "sync now".
    // g70-g75 (full-control W02, #6756; the plan's g73-g78): PSA/billing writes.
    // g76-g78 (full-control W03, #6757): backup restore, DR rehearsal, Hyper-V power.
    // g79-g81 (full-control W04, #6758): process kill, containment, agent restart.
    // g82-g84 (full-control W06, #6776): ticket config, checklist templates, time suggestions.
    // g85-g87 (full-control W07, #6777): correlation explain, device anomalies, reliability offenders.
    // g88-g90 (full-control W08, #6778): topology node relationships, diagnostic start, template preview.
    // g91-g93 (full-control W09, #6779): asset probe, SNMP metric history, UniFi sync + status.
    // g94-g96 (full-control W10, #6780): device AI activity, operator task list, fleet design list.
    // g97-g99 (full-control W11, #6781): security score trend, dismiss a recommendation, rotate a recovery key (supervised).
    expect(GOLDEN_CASES).toHaveLength(99);
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(99);
    expect(GOLDEN_CASES.find((c) => c.id === 'g97')?.expect[0]).toEqual({ tool: 'get_security_compliance' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g98')?.expect[0]).toEqual({ tool: 'manage_security_recommendations', action: 'dismiss' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g99')?.expect[0]).toEqual({ tool: 'manage_recovery_keys', action: 'rotate' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g94')?.expect[0]).toEqual({ tool: 'get_device_ai_activity' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g95')?.expect[0]).toEqual({ tool: 'list_operator_tasks' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g96')?.expect[0]).toEqual({ tool: 'list_fleet_designs' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g91')?.expect[0]).toEqual({ tool: 'probe_network_asset' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g92')?.expect[0]).toEqual({ tool: 'get_snmp_metrics', action: 'history' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g93')?.expect[0]).toEqual({ tool: 'trigger_unifi_sync' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g88')?.expect[0]).toEqual({ tool: 'get_topology_graph', action: 'node' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g89')?.expect[0]).toEqual({ tool: 'run_topology_diagnostic', action: 'start' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g90')?.expect[0]).toEqual({ tool: 'apply_topology_template', action: 'preview' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g85')?.expect[0]).toEqual({ tool: 'get_alert_correlations', action: 'explain' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g86')?.expect[0]).toEqual({ tool: 'manage_device_anomalies', action: 'list' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g87')?.expect[0]).toEqual({ tool: 'get_fleet_health', action: 'offenders' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g82')?.expect[0]).toEqual({ tool: 'manage_ticket_config', action: 'create_category' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g83')?.expect[0]).toEqual({ tool: 'manage_ticket_checklist_templates', action: 'create' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g84')?.expect[0]).toEqual({ tool: 'manage_time_suggestions', action: 'confirm' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g79')?.expect[0]).toEqual({ tool: 'manage_processes', action: 'kill' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g80')?.expect[0]).toEqual({ tool: 'execute_containment' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g81')?.expect[0]).toEqual({ tool: 'trigger_agent_restart' });
    expect(GOLDEN_CASES.find((c) => c.id === 'g69')?.expect[0]).toEqual({ tool: 'sync_edr_data' });
  });
  it('expects registered tools and declared actions, with only known chat-visibility gaps', () => {
    for (const c of GOLDEN_CASES) for (const e of c.expect) {
      expect.soft(aiTools.has(e.tool), `${c.id}: ${e.tool} not registered`).toBe(true);
      if (!PENDING_DECLARATION.has(e.tool) && !BASELINE_UNDECLARED_TOOLS.has(e.tool)) {
        expect.soft(e.tool in TOOL_TIERS, `${c.id}: ${e.tool} not in TOOL_TIERS`).toBe(true);
      }
      if (e.action) {
        const schema = aiTools.get(e.tool)?.definition.input_schema as { properties?: { action?: { enum?: string[] } } };
        expect.soft(schema?.properties?.action?.enum ?? [], `${c.id}: ${e.tool}.${e.action}`).toContain(e.action);
      }
    }
  });
  it('keeps declaration exceptions limited to unresolved tools used by the golden set', () => {
    const expectedTools = new Set(GOLDEN_CASES.flatMap((c) => c.expect.map((e) => e.tool)));
    for (const name of [...PENDING_DECLARATION, ...BASELINE_UNDECLARED_TOOLS]) {
      expect.soft(expectedTools.has(name), `${name}: unused exception`).toBe(true);
      expect.soft(name in TOOL_TIERS, `${name}: now declared; remove the exception`).toBe(false);
    }
  });
  it('covers at least 10 distinct domains worth of tools (no single-tool eval)', () => {
    expect(new Set(GOLDEN_CASES.flatMap((c) => c.expect.map((e) => e.tool))).size).toBeGreaterThanOrEqual(35);
  });
  it('freezes the structurally-unwinnable-on-chat case set (every acceptable answer is undeclared)', () => {
    // A case is structurally unwinnable when EVERY tool in its expect[] is
    // undeclared (absent from TOOL_TIERS) — the model has no declared
    // alternate to reach for. This is a stricter bar than "has at least one
    // undeclared expected tool"; it is what actually caps chat accuracy.
    const undeclared = new Set([...PENDING_DECLARATION, ...BASELINE_UNDECLARED_TOOLS]);
    const structuralMisses = GOLDEN_CASES
      .filter((c) => c.expect.every((e) => undeclared.has(e.tool)))
      .map((c) => c.id);
    // W02 (#6756) declared manage_tickets, so g34/g35/g36 are winnable now.
    expect(structuralMisses).toEqual([]);
  });
});
