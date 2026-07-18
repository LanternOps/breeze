import { describe, it, expect } from 'vitest';
import { generateReportSchema, securityCompliancePostureConfigSchema } from './schemas';

describe('security_compliance_posture validation', () => {
  it('accepts the new report type in generateReportSchema', () => {
    const parsed = generateReportSchema.safeParse({
      type: 'security_compliance_posture',
      format: 'pdf',
      config: { sites: [], minPasswordLength: 8, maxLocalAdmins: 2 }
    });
    expect(parsed.success).toBe(true);
  });

  it('applies threshold defaults', () => {
    const cfg = securityCompliancePostureConfigSchema.parse({});
    expect(cfg.minPasswordLength).toBe(8);
    expect(cfg.maxLocalAdmins).toBe(2);
  });

  it('defaults omitted backupRequired to required for legacy reports', () => {
    expect(securityCompliancePostureConfigSchema.parse({}).backupRequired).toBe(true);
  });

  it.each([true, false])('accepts backupRequired=%s', (backupRequired) => {
    expect(securityCompliancePostureConfigSchema.parse({ backupRequired }).backupRequired)
      .toBe(backupRequired);
  });

  it('rejects non-boolean backupRequired', () => {
    expect(securityCompliancePostureConfigSchema.safeParse({ backupRequired: 'false' }).success)
      .toBe(false);
  });
});
