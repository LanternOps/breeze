import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type UserPermissions } from '../../permissions';
import { TOOL_PERMISSIONS } from '../../aiGuardrails';
import { builtinPermissionMisses, corePermissionMisses, FLOW_BUILTIN_PERMISSIONS } from './permissions';

function perms(grants: Array<[string, string]>): UserPermissions {
  return {
    permissions: grants.map(([resource, action]) => ({ resource, action })),
    partnerId: null, orgId: '11111111-1111-4111-8111-111111111111', roleId: 'r', scope: 'organization',
  };
}
const step = (tool: string, input: Record<string, unknown> = {}) => ({ tool, input });

describe('FLOW_BUILTIN_PERMISSIONS', () => {
  it('wait and set need nothing; notify alerts.write; http_request external_tools.write; ai ai_sessions.use', () => {
    expect(FLOW_BUILTIN_PERMISSIONS.wait).toEqual([]);
    expect(FLOW_BUILTIN_PERMISSIONS.set).toEqual([]);
    expect(FLOW_BUILTIN_PERMISSIONS.notify).toEqual([{ resource: 'alerts', action: 'write' }]);
    expect(FLOW_BUILTIN_PERMISSIONS.http_request).toEqual([{ resource: 'external_tools', action: 'write' }]);
    expect(FLOW_BUILTIN_PERMISSIONS.ai).toEqual([{ resource: 'ai_sessions', action: 'use' }]);
  });

  it('the literals are the registered PERMISSIONS (a renamed permission breaks here, not in production)', () => {
    const pick = (p: { resource: string; action: string }) => ({ resource: p.resource, action: p.action });
    expect(FLOW_BUILTIN_PERMISSIONS.notify).toEqual([pick(PERMISSIONS.ALERTS_WRITE)]);
    expect(FLOW_BUILTIN_PERMISSIONS.http_request).toEqual([pick(PERMISSIONS.EXTERNAL_TOOLS_WRITE)]);
    expect(FLOW_BUILTIN_PERMISSIONS.ai).toEqual([pick(PERMISSIONS.AI_SESSIONS_USE)]);
  });

  // W6 (#5221, plan A3): resolve_targets reads devices; create_alert writes an
  // alert; run_script_on_targets needs exactly what core run_script needs.
  it('resolve_targets devices.read; create_alert alerts.write; run_script_on_targets = TOOL_PERMISSIONS.run_script', () => {
    const pick = (p: { resource: string; action: string }) => ({ resource: p.resource, action: p.action });
    expect(FLOW_BUILTIN_PERMISSIONS.resolve_targets).toEqual([pick(PERMISSIONS.DEVICES_READ)]);
    expect(FLOW_BUILTIN_PERMISSIONS.create_alert).toEqual([pick(PERMISSIONS.ALERTS_WRITE)]);
    const core = TOOL_PERMISSIONS.run_script as { resource: string; action: string };
    expect(FLOW_BUILTIN_PERMISSIONS.run_script_on_targets).toEqual([{ resource: core.resource, action: core.action }]);
  });
});

describe('builtinPermissionMisses', () => {
  it('enable without external_tools.write is permission_missing for an http_request step', () => {
    expect(builtinPermissionMisses(step('http_request', { method: 'GET', url: 'https://api.example.com' }), perms([['external_tools', 'use']])))
      .toEqual(['external_tools.write']);
    expect(builtinPermissionMisses(step('http_request', { method: 'GET', url: 'https://api.example.com' }), perms([['external_tools', 'write']])))
      .toEqual([]);
  });

  it('enable without alerts.write is permission_missing for notify', () => {
    expect(builtinPermissionMisses(step('notify'), perms([['alerts', 'read']]))).toEqual(['alerts.write']);
    expect(builtinPermissionMisses(step('notify'), perms([['alerts', 'write']]))).toEqual([]);
  });

  it('wait and set need no permission at all', () => {
    expect(builtinPermissionMisses(step('wait', { minutes: 1 }), perms([]))).toEqual([]);
    expect(builtinPermissionMisses(step('set', { values: { a: 1 } }), perms([]))).toEqual([]);
  });

  it('ai step requires the permissions of its tools', () => {
    const input = { prompt: 'x', tools: ['get_active_users', 'halo__lookup'], output: { type: 'object' } };
    // Nothing granted: the session permission, the core tool's own requirement and the tenant Tier-1 grant.
    const none = builtinPermissionMisses(step('ai', input), perms([]));
    expect(none).toContain('ai_sessions.use');
    expect(none).toContain('external_tools.use');
    expect(none.length).toBeGreaterThanOrEqual(3);
    const coreOnly = corePermissionMisses('get_active_users', {}, perms([]));
    expect(coreOnly.length).toBeGreaterThan(0);
    for (const p of coreOnly) expect(none).toContain(p);
    // Everything granted.
    expect(builtinPermissionMisses(step('ai', input), perms([['*', '*']]))).toEqual([]);
    // No tools: only the session permission.
    expect(builtinPermissionMisses(step('ai', { prompt: 'x', output: { type: 'object' } }), perms([]))).toEqual(['ai_sessions.use']);
  });
});
