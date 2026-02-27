import { describe, expect, it } from 'vitest';
import { compareAuditPolicySettings, getTemplateSettings } from './auditBaselineService';

describe('auditBaselineService.compareAuditPolicySettings', () => {
  it('returns compliant when all expected settings match', () => {
    const result = compareAuditPolicySettings(
      {
        'auditpol:logon': 'success_and_failure',
        'auditpol:account lockout': 'success_and_failure',
      },
      {
        'auditpol:logon': 'success_and_failure',
        'auditpol:account lockout': 'success_and_failure',
      }
    );

    expect(result.compliant).toBe(true);
    expect(result.score).toBe(100);
    expect(result.deviations).toHaveLength(0);
  });

  it('marks missing settings as deviations', () => {
    const result = compareAuditPolicySettings(
      {
        'auditpol:logon': 'success_and_failure',
      },
      {
        'auditpol:logon': 'success_and_failure',
        'auditpol:system integrity': 'success',
      }
    );

    expect(result.compliant).toBe(false);
    expect(result.deviations).toEqual([
      expect.objectContaining({
        setting: 'auditpol:system integrity',
        reason: 'missing',
      }),
    ]);
    expect(result.score).toBe(50);
  });

  it('supports rule-based comparisons', () => {
    const result = compareAuditPolicySettings(
      {
        'audit_control.flags': 'lo,aa,ad',
        'audit_control.filesz': '12',
        'auditd.max_log_file_action': 'keep_logs',
      },
      {
        'audit_control.flags': { op: 'includes', value: 'aa' },
        'audit_control.filesz': { op: 'gte', value: 10 },
        'auditd.max_log_file_action': { op: 'in', values: ['keep_logs', 'rotate'] },
      }
    );

    expect(result.compliant).toBe(true);
    expect(result.score).toBe(100);
  });
});

describe('auditBaselineService.getTemplateSettings', () => {
  it('returns CIS template settings for known OS/profile pairs', () => {
    const settings = getTemplateSettings('windows', 'cis_l1');

    expect(settings).toHaveProperty('auditpol:logon');
    expect(settings).toHaveProperty('auditpol:security state change');
  });
});
