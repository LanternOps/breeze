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
});
