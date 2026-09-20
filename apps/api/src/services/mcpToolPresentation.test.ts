import { describe, expect, it } from 'vitest';
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
  const schema = (actions: string[]) => ({ type: 'object', properties: { action: { type: 'string', enum: actions } } });
  it('a pure read tool: readOnly + idempotent, not destructive, closed world', () => {
    expect(buildMcpToolPresentation({ name: 'query_devices' }, 1, 'core')).toEqual({
      title: 'Query devices',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'app.breeze/domain': 'core' },
    });
  });
  it('a mixed multiplexer: not read-only, destructive when any action is tier 3', () => {
    const p = buildMcpToolPresentation({ name: 'manage_services', input_schema: schema(['list', 'start', 'stop', 'restart']) }, 2, 'devices');
    expect(p.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  });
  it('a tier-2 write multiplexer with no tier-3 action: not read-only, not destructive', () => {
    const p = buildMcpToolPresentation({ name: 'manage_groups', input_schema: schema(['list', 'get', 'add_devices', 'remove_devices']) }, 2, 'devices');
    expect(p.annotations.readOnlyHint).toBe(false);
    expect(p.annotations.destructiveHint).toBe(false);
  });
  it('integrations are open-world; unknown tier is treated as destructive (fail closed) and unknown domain as "unknown"', () => {
    expect(buildMcpToolPresentation({ name: 'get_s1_threats' }, 1, 'integrations').annotations.openWorldHint).toBe(true);
    const p = buildMcpToolPresentation({ name: 'mystery' }, undefined, undefined);
    expect(p.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(p._meta['app.breeze/domain']).toBe('unknown');
  });
});
