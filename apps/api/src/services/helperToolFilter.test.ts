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

  it('run_backup_verification stays excluded (no executeTool registration exists)', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      expect(getHelperAllowedTools(level)).not.toContain('run_backup_verification');
    }
  });

  it('no level contains org-wide tools (the device-scope gate would deny them)', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      const tools = getHelperAllowedTools(level);
      for (const t of [
        ...ORG_WIDE,
        'get_backup_health',
        'get_recovery_readiness',
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
});
