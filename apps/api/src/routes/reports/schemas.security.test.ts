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
});
