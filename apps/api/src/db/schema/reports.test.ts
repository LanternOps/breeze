import { describe, it, expect } from 'vitest';
import { reportTypeEnum } from './reports';

describe('reportTypeEnum', () => {
  it('includes the security & compliance posture type', () => {
    expect(reportTypeEnum.enumValues).toContain('security_compliance_posture');
  });

  it('keeps the original six types', () => {
    for (const t of [
      'device_inventory',
      'software_inventory',
      'alert_summary',
      'compliance',
      'performance',
      'executive_summary'
    ]) {
      expect(reportTypeEnum.enumValues).toContain(t);
    }
  });
});
