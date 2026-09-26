import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from '../../aiAgentSdkTools';
import { aiTools } from '../../aiToolNames';
import '../../aiTools';
import { GOLDEN_CASES } from './goldenPrompts';

// A-W02 Task 5 declares the currently mute documentation tool; remove this set then.
const PENDING_DECLARATION = new Set<string>([]); // search_documentation was declared by A-W02 (#6341)

// The plan's fixed prompts also reference these pre-existing #3300 gaps from
// aiAgentSdkTools.registryParity.contract.test.ts (KNOWN_MISSING_TOOL_TIERS).
// Preserve them in the eval: unavailable tools must still count as misses, not
// disappear from the baseline. A-W01 must not change product tool exposure.
// Frozen at A-W01; only shrink this set as declarations land. Unlike the g57
// exception above, these tools are not promised declarations by A-W02.
//
// Spec 2026-09-23 W01 (#6755) declared 11 of these (the L1 reads it wired);
// removed here rather than left stale, per this test's own "now declared;
// remove the exception" assertion below.
const BASELINE_UNDECLARED_TOOLS = new Set([
  'get_compliance_status',
  'get_executive_summary',
  'get_sensitive_data_overview',
  'manage_quotes',
  'manage_tags',
  'manage_tickets',
  'query_backups',
  'restore_snapshot',
  'trigger_backup',
  'trigger_mssql_backup',
]);

describe('GOLDEN_CASES', () => {
  it('has 67 unique ids', () => {
    expect(GOLDEN_CASES).toHaveLength(67);
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(67);
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
    expect(structuralMisses).toEqual(['g34', 'g35', 'g36', 'g60']);
  });
});
