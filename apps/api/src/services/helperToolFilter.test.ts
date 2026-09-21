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
  it('basic set is unchanged: the 8 read-only device-scoped tools', () => {
    expect([...getHelperAllowedTools('basic')].sort()).toEqual(
      [
        'get_device_details',
        'analyze_metrics',
        'analyze_disk_usage',
        'get_cis_device_report',
        'get_security_posture',
        'take_screenshot',
        'analyze_screen',
        'search_logs',
      ].sort(),
    );
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

describe('helper governed tool sets (finding A, Phase 1)', () => {
  it('standard adds device-pinned safe-action tools to basic', () => {
    const standard = getHelperAllowedTools('standard');
    for (const t of getHelperAllowedTools('basic')) expect(standard).toContain(t);
    for (const t of [
      'get_active_users',
      'get_user_experience_metrics',
      'manage_alerts',
      'manage_services',
      'disk_cleanup',
      'file_operations',
    ]) {
      expect(standard).toContain(t);
    }
  });

  it('extended adds device-pinned destructive tools to standard', () => {
    const extended = getHelperAllowedTools('extended');
    for (const t of getHelperAllowedTools('standard')) expect(extended).toContain(t);
    for (const t of [
      'computer_control',
      'execute_command',
      'security_scan',
      's1_isolate_device',
      'network_discovery',
      'apply_cis_remediation',
    ]) {
      expect(extended).toContain(t);
    }
  });

  it('no level contains a tool that is not registered for execution', () => {
    // The three orphan backup tools used to be the example here; they were
    // removed (execution-plane W01, registry guard). Keep the invariant with a
    // real org-wide tool instead.
    for (const level of ['basic', 'standard', 'extended'] as const) {
      expect(getHelperAllowedTools(level)).not.toContain('get_backup_status');
    }
  });

  it('no level contains org-wide tools (the device-scope gate would deny them)', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      const tools = getHelperAllowedTools(level);
      for (const t of [
        ...ORG_WIDE,
        'get_backup_status',
        'get_cis_compliance',
      ]) {
        expect(tools, `${level} must not contain org-wide tool ${t}`).not.toContain(t);
      }
    }
  });

  it('s1_threat_action stays excluded (threat-keyed, not device-pinnable)', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      expect(getHelperAllowedTools(level)).not.toContain('s1_threat_action');
    }
  });

  it('every helper-whitelisted tool is device-scopable by the executeTool gate', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      for (const tool of getHelperAllowedTools(level)) {
        expect(
          HELPER_TOOL_SCOPING[tool],
          `${level}:${tool} has no HELPER_TOOL_SCOPING entry — the gate would deny it`,
        ).toBeDefined();
      }
    }
  });

  // Disk Cleanup v2 W05, spec §9.3 item 10. The Helper runs in front of an END
  // USER, not a technician. `system_cleanup run` executes vetted maintenance
  // binaries as LocalSystem for up to 90 minutes and some handlers are
  // irreversible — that is not an end-user self-service action at any
  // permission level, and it has no HELPER_TOOL_SCOPING entry, so the
  // executeTool gate denies it even if a whitelist later named it.
  it('system_cleanup is denied to the Helper at every level', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      expect(getHelperAllowedTools(level)).not.toContain('system_cleanup');
      expect(validateHelperToolAccess('system_cleanup', level)).toContain('not available');
    }
    expect(HELPER_TOOL_SCOPING.system_cleanup).toBeUndefined();
  });
});
