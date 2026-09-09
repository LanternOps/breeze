import { describe, it, expect } from 'vitest';

import {
  DEPRECATED_TOOL_ALIASES,
  isDeprecatedToolAlias,
  resolveDeprecatedToolAlias,
} from './aiToolAliases';
import { aiTools, getToolDefinitions } from './aiTools';

describe('deprecated AI tool aliases', () => {
  it('resolves every alias to a tool that actually exists in the registry', () => {
    const registered = new Set(aiTools.keys());
    const dangling = [...DEPRECATED_TOOL_ALIASES.entries()]
      .filter(([, canonical]) => !registered.has(canonical))
      .map(([alias, canonical]) => `${alias} -> ${canonical}`);
    expect(
      dangling,
      `Alias targets missing from the aiTools registry: ${dangling.join(', ')}`,
    ).toEqual([]);
  });

  it('never shadows a live tool with an alias of the same name', () => {
    const registered = new Set(aiTools.keys());
    const shadowed = [...DEPRECATED_TOOL_ALIASES.keys()].filter((alias) => registered.has(alias));
    expect(shadowed, `Alias names collide with live tools: ${shadowed.join(', ')}`).toEqual([]);
  });

  it('never advertises a deprecated alias in the tool definitions (#5362)', () => {
    // tools/list is what the model chooses from, and the NAME wins that choice.
    // Re-advertising `get_fleet_status` would reintroduce the bug the rename
    // fixes, so aliases must stay dispatch-only.
    const advertised = new Set(getToolDefinitions().map((d) => d.name));
    for (const alias of DEPRECATED_TOOL_ALIASES.keys()) {
      expect(advertised.has(alias), `${alias} must not appear in tools/list`).toBe(false);
    }
  });

  it('maps the #5362 rename', () => {
    expect(resolveDeprecatedToolAlias('get_fleet_status')).toBe('get_invite_funnel');
    expect(isDeprecatedToolAlias('get_fleet_status')).toBe(true);
  });

  it('passes unknown names through so the caller still reports "Unknown tool"', () => {
    expect(resolveDeprecatedToolAlias('query_devices')).toBe('query_devices');
    expect(resolveDeprecatedToolAlias('not_a_tool')).toBe('not_a_tool');
    expect(isDeprecatedToolAlias('query_devices')).toBe(false);
  });

  it('does not resolve inherited object keys to a non-string (name is off the wire)', () => {
    for (const hostile of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(resolveDeprecatedToolAlias(hostile)).toBe(hostile);
      expect(isDeprecatedToolAlias(hostile)).toBe(false);
    }
  });
});
