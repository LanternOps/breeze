// apps/api/src/services/aiTools.outputBudget.contract.test.ts
/**
 * A-W05 contract: every `limit` states its default and max; every paged tool
 * carries its page parameters on all FOUR input-schema surfaces (Q7 adds
 * scriptBuilderTools.ts as a fourth surface — it declares its own Zod shapes
 * for `query_devices`, `manage_alerts`, `get_script_execution`, independent
 * of aiAgentSdkTools.ts); the set of read tools returning arrays without a
 * `limit` only shrinks.
 * No vi.mock — this suite needs the real registry (same rule as
 * aiTools.domainMetadata.contract.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import { getAllRegisteredToolNames } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { buildBreezeSdkTools } from './aiAgentSdkTools';
import { buildScriptBuilderTools } from './scriptBuilderTools';
import { UNBOUNDED_LIST_READS } from './aiToolOutputBudget.testkit';

type Props = Record<string, { description?: string }>;
const propsOf = (name: string): Props =>
  ((aiTools.get(name)?.definition.input_schema as { properties?: Props } | undefined)?.properties ?? {});

// Q9: widened past the original results/rows/entries/items/records noun list
// so a tool-specific noun ("devices", "tickets", "agents", …) still reads as
// a plain "Max <noun> (default N, max M)" sentence rather than forcing every
// tool onto one generic word.
const LIMIT_TEXT = /^Max(imum)? [a-z][a-z /-]*[^()]*\(default \d+, max \d+\)$/;

describe('AI tool output budget (A-W05)', () => {
  const names = getAllRegisteredToolNames();

  it('registers enough tools for these assertions to mean something', () => {
    expect(names.length).toBeGreaterThan(150);
  });

  it('every limit property states its default and max', () => {
    const bad = names
      .filter((n) => 'limit' in propsOf(n))
      .filter((n) => !LIMIT_TEXT.test(propsOf(n).limit?.description ?? ''))
      .map((n) => `${n}: ${JSON.stringify(propsOf(n).limit?.description)}`);
    expect(bad, `limit descriptions without "(default N, max M)": ${bad.join('; ')}`).toEqual([]);
  });

  it('page parameters exist on all four surfaces (registry, toolInputSchemas, SDK tool(), scriptBuilderTools)', () => {
    // Same construction as aiTools.domainMetadata.contract.test.ts: handlers must never run here.
    const fakeAuth = () => { throw new Error('must not invoke tool handlers'); };
    const sdk = new Map(buildBreezeSdkTools(fakeAuth as never).map((t) => [t.name, t] as const));
    // Q7: scriptBuilderTools.ts declares its own Zod shapes for a subset of
    // core tools (query_devices, manage_alerts, get_script_execution) — a
    // paging param added only to aiAgentSdkTools.ts would leave this surface
    // stripping `cursor`/`offset` and sending the model back to page 1.
    const scriptBuilder = new Map(buildScriptBuilderTools(fakeAuth as never).map((t) => [t.name, t] as const));
    const drift: string[] = [];
    for (const n of names) {
      const registry = propsOf(n);
      const zod = (toolInputSchemas[n] as { shape?: Record<string, unknown> } | undefined)?.shape;
      // `inputSchema` on an SDK tool is the raw Zod shape record that was passed to tool().
      const sdkShape = (sdk.get(n) as { inputSchema?: Record<string, unknown> } | undefined)?.inputSchema;
      const scriptBuilderShape = (scriptBuilder.get(n) as { inputSchema?: Record<string, unknown> } | undefined)?.inputSchema;
      for (const key of ['limit', 'offset', 'cursor'] as const) {
        if (!(key in registry)) continue;
        if (zod && !(key in zod)) drift.push(`${n}.${key} missing in toolInputSchemas`);
        if (sdkShape && !(key in sdkShape)) drift.push(`${n}.${key} missing in the SDK tool() shape`);
        if (scriptBuilderShape && !(key in scriptBuilderShape)) drift.push(`${n}.${key} missing in scriptBuilderTools' tool() shape`);
      }
    }
    expect(drift, drift.join('\n')).toEqual([]);
  });

  // KNOWN RED as of Task 4 (A-W05 D12b), per the plan's own reconciliation
  // rule: "if the red names a tool from the 20-tool table, leave it red
  // until its Task 5 group lands (note it in the PR)". `list_ai_agents`
  // (#7, Task 5a) and `list_playbooks` (#18, Task 5c) are both in the
  // 20-tool table and get their `limit` there. `query_psa_status` is the one
  // survey miss — NOT in the 20-tool table — and per the same rule gets its
  // `limit` (with `pageParamSchema`) in Task 5c's last step, not here.
  // UNBOUNDED_LIST_READS is deliberately NOT widened to hide these three:
  // "add nothing to the set" is explicit in the plan, and the frozen
  // baseline is shrink-only.
  it('UNBOUNDED_LIST_READS only shrinks: every entry is still a registered read with no limit, and no other read tool lacks one', () => {
    const stale = [...UNBOUNDED_LIST_READS].filter((n) => !aiTools.has(n) || 'limit' in propsOf(n));
    expect(stale, `remove from UNBOUNDED_LIST_READS (fixed or gone): ${stale.join(', ')}`).toEqual([]);
    const listReads = names.filter((n) => /^(list|search|query)_/.test(n) && aiTools.get(n)?.tier === 1);
    const unbudgeted = listReads.filter((n) => !('limit' in propsOf(n)) && !UNBOUNDED_LIST_READS.has(n));
    expect(unbudgeted, `read tools returning lists with no limit and not in the frozen baseline: ${unbudgeted.join(', ')}`).toEqual([]);
  });
});
