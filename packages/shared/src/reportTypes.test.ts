import { describe, expect, it } from 'vitest';
import { BUSINESS_REPORT_REQUIRED_PERMISSIONS, BUSINESS_REPORT_TYPES, REPORT_TYPES, isReportType } from './reportTypes';

describe('REPORT_TYPES', () => {
  it('lists the 14 shipped types first, in report_type enum order, then the three business types', () => {
    expect([...REPORT_TYPES]).toEqual([
      'device_inventory', 'software_inventory', 'alert_summary', 'compliance',
      'performance', 'executive_summary', 'security_compliance_posture',
      'ai_org_narrative', 'ai_fleet_design', 'hardware_lifecycle',
      'threat_detection_review', 'endpoint_management_review',
      'vulnerability_management', 'identity_access_review',
      'ticket_sla_attainment', 'technician_time_billability', 'ar_aging',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(REPORT_TYPES).size).toBe(REPORT_TYPES.length);
  });

  it('BUSINESS_REPORT_TYPES is exactly the three #3198 types and all are in REPORT_TYPES', () => {
    expect([...BUSINESS_REPORT_TYPES]).toEqual([
      'ticket_sla_attainment', 'technician_time_billability', 'ar_aging',
    ]);
    for (const t of BUSINESS_REPORT_TYPES) expect(REPORT_TYPES).toContain(t);
  });

  it('isReportType narrows only known values', () => {
    expect(isReportType('ar_aging')).toBe(true);
    expect(isReportType('ar_ageing')).toBe(false);
  });
});

describe('BUSINESS_REPORT_REQUIRED_PERMISSIONS (#3198)', () => {
  // The one source for both the API registry's `requiredPermissions` and the
  // web gallery's card gate (they used to be hand-synced copies).
  it('names exactly the underlying read grants of each business type', () => {
    expect(BUSINESS_REPORT_REQUIRED_PERMISSIONS).toEqual({
      ticket_sla_attainment: [{ resource: 'tickets', action: 'read' }],
      technician_time_billability: [
        { resource: 'time_entries', action: 'read' },
        { resource: 'tickets', action: 'read' },
      ],
      ar_aging: [{ resource: 'invoices', action: 'read' }],
    });
    expect(Object.keys(BUSINESS_REPORT_REQUIRED_PERMISSIONS).sort()).toEqual([...BUSINESS_REPORT_TYPES].sort());
  });
});
