import { describe, expect, it } from 'vitest';
import {
  getHelperAllowedMcpToolNames,
  getHelperAllowedTools,
  validateHelperToolAccess,
} from './helperToolFilter';
import { HELPER_TOOL_SCOPING } from './aiTools';

describe('helperToolFilter', () => {
  it('excludes Tier 3 computer control from standard helper access', () => {
    expect(getHelperAllowedTools('standard')).not.toContain('computer_control');
    expect(getHelperAllowedMcpToolNames('standard')).not.toContain('mcp__breeze__computer_control');
    expect(validateHelperToolAccess('computer_control', 'standard')).toContain('not available');
  });

  it('keeps computer control limited to extended helper access', () => {
    expect(getHelperAllowedTools('extended')).toContain('computer_control');
    expect(validateHelperToolAccess('mcp__breeze__computer_control', 'extended')).toBeNull();
  });
});

const MUTATING = [
  'manage_alerts', 'manage_services', 'disk_cleanup', 'file_operations',
  'execute_command', 'computer_control', 's1_isolate_device',
];
const ORG_WIDE = [
  'query_devices', 'get_fleet_health', 'get_s1_threats', 'get_log_trends',
  'detect_log_correlations', 'query_audit_log', 'query_change_log',
];

describe('helper basic tool set (finding A, Phase 0)', () => {
  it('basic set is exactly the device-scoped allowlist keys', () => {
    expect([...getHelperAllowedTools('basic')].sort())
      .toEqual(Object.keys(HELPER_TOOL_SCOPING).sort());
  });

  it('basic set contains no mutating tools', () => {
    const basic = getHelperAllowedTools('basic');
    for (const t of MUTATING) expect(basic).not.toContain(t);
  });

  it('basic set contains no org-wide enumeration tools', () => {
    const basic = getHelperAllowedTools('basic');
    for (const t of ORG_WIDE) expect(basic).not.toContain(t);
  });
});
