import { describe, expect, it } from 'vitest';
import { FLOW_BUILTIN_STEPS, FLOW_LATER_BUILTINS } from '@breeze/shared';
import { aiTools } from '../aiTools';

/**
 * Tool Catalog W03 (#5218), Decision 2. Built-in flow steps live in the shared
 * FLOW_BUILTIN_STEPS registry, never in `aiTools` — so a step named `wait`
 * must never be ambiguous with a core tool, today or after a later wave adds
 * `notify` / `ai` / `http_request`.
 */
describe('flow built-in step names', () => {
  const names = [...Object.keys(FLOW_BUILTIN_STEPS), ...FLOW_LATER_BUILTINS];

  it('are disjoint from every registered core tool name', () => {
    expect(names.filter((n) => aiTools.has(n))).toEqual([]);
  });

  it('never contain the tenant-tool separator', () => {
    expect(names.filter((n) => n.includes('__'))).toEqual([]);
  });

  // W5 PR B (#5220): the five built-ins, every one executable (no announced-but-gated names left).
  // W6 (#5221) adds the three legacy-conversion built-ins.
  it('are exactly the W5 and W6 built-ins, all shipped', () => {
    expect(Object.keys(FLOW_BUILTIN_STEPS).sort()).toEqual([
      'ai', 'create_alert', 'http_request', 'notify', 'resolve_targets', 'run_script_on_targets', 'set', 'wait',
    ]);
    expect(FLOW_LATER_BUILTINS).toEqual([]);
  });

  it('are all in every owner\'s flow catalog (no FLOW_EXECUTABLE_BUILTINS gate)', async () => {
    const catalog = await import('./catalog');
    expect('FLOW_EXECUTABLE_BUILTINS' in catalog).toBe(false);
  });
});
