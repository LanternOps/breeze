import * as toolActions from './aiToolActions';
import { describe, expect, it, vi } from 'vitest';
import { buildMcpToolPresentation, isActionReadOnly, mcpToolTitle, resolveActionTier } from './mcpToolPresentation';

describe('mcpToolTitle', () => {
  it('humanizes snake_case and upper-cases known acronyms', () => {
    expect(mcpToolTitle('manage_alert_rules')).toBe('Manage alert rules');
    expect(mcpToolTitle('m365_query_users')).toBe('M365 query users');
    expect(mcpToolTitle('get_s1_threats')).toBe('Get S1 threats');
    expect(mcpToolTitle('query_c2c_connections')).toBe('Query C2C connections');
    expect(mcpToolTitle('get_dns_security')).toBe('Get DNS security');
  });
});

describe('per-action tier + read-only resolution (mirrors aiGuardrails tables)', () => {
  it('escalates by TIER3_ACTIONS, downgrades by TIER1_ACTIONS, falls back to base', () => {
    expect(resolveActionTier('manage_services', 'restart', 2)).toBe(3);      // TIER3_ACTIONS.manage_services
    expect(resolveActionTier('manage_services', 'list', 2)).toBe(2);
    expect(resolveActionTier('query_devices', undefined, 1)).toBe(1);
  });
  it('read-only follows isReadOnlyResolution semantics', () => {
    expect(isActionReadOnly('query_devices', undefined, 1)).toBe(true);
    expect(isActionReadOnly('manage_services', 'list', 2)).toBe(true);        // TIER2_READONLY_ACTIONS
    expect(isActionReadOnly('manage_services', 'restart', 2)).toBe(false);
    expect(isActionReadOnly('list_contracts', undefined, 2)).toBe(true);       // TIER2_READONLY_TOOLS
    expect(isActionReadOnly('workspace_stage', undefined, 1)).toBe(false);      // TIER1_NON_READONLY_TOOLS
  });
});

describe('buildMcpToolPresentation', () => {
  // Actions are resolved from the registry by name.
  const schema = { type: 'object', properties: {} };
  it('a pure read tool: readOnly + idempotent, not destructive, closed world', () => {
    expect(buildMcpToolPresentation({ name: 'query_devices' }, 1, 'core')).toEqual({
      title: 'Query devices',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'app.breeze/domain': 'core' },
    });
  });
  it('a mixed multiplexer: not read-only, destructive and open-world for any mutation', () => {
    const p = buildMcpToolPresentation({ name: 'manage_services', input_schema: schema }, 2, 'devices');
    expect(p.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
  it('manage_groups remains destructive and open-world across its canonical actions', () => {
    const p = buildMcpToolPresentation({ name: 'manage_groups', input_schema: schema }, 2, 'devices');
    expect(p.annotations.readOnlyHint).toBe(false);
    expect(p.annotations.destructiveHint).toBe(true);
    expect(p.annotations.openWorldHint).toBe(true);
  });
  it('manage_saved_filters deletion is destructive even at tier 2', () => {
    const p = buildMcpToolPresentation({ name: 'manage_saved_filters', input_schema: schema }, 2, 'core');
    expect(p.annotations.destructiveHint).toBe(true);
    expect(p.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
  it('enumerates commandType actions from the canonical tool schema', () => {
    const p = buildMcpToolPresentation({ name: 'execute_command' }, 3, 'devices');
    expect(p.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
  it.each([undefined, 'unknown', 'unregistered'])('read-only tools with unknown domain %s are open-world', (domain) => {
    expect(buildMcpToolPresentation({ name: 'extension_read' }, 1, domain).annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
  it('external tools remain open-world regardless of domain or tier', () => {
    for (const tier of [1, 2, 3]) {
      expect(buildMcpToolPresentation({ name: 'external_read' }, tier, 'core', { external: true }).annotations)
        .toMatchObject({ readOnlyHint: tier === 1, openWorldHint: true });
    }
  });
  it.each(['manage_services', 'manage_groups'])('includes gated actions absent from the schema enum for %s', (name) => {
    const enumerate = vi.spyOn(toolActions, 'toolActionEnum').mockReturnValue(['list']);
    try {
      expect(buildMcpToolPresentation({ name }, 1, 'devices').annotations.readOnlyHint).toBe(false);
    } finally { enumerate.mockRestore(); }
  });
  it('integrations are open-world; unknown tier is treated as destructive (fail closed) and unknown domain as "unknown"', () => {
    expect(buildMcpToolPresentation({ name: 'get_s1_threats' }, 1, 'integrations').annotations.openWorldHint).toBe(true);
    const p = buildMcpToolPresentation({ name: 'mystery' }, undefined, undefined);
    expect(p.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(p._meta['app.breeze/domain']).toBe('unknown');
  });
});
