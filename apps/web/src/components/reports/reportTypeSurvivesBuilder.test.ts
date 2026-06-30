import { describe, it, expect } from 'vitest';
import { reportTypeSurvivesBuilder } from './ReportBuilder';

// Guards the drift the type-design review flagged: the predicate is the single
// source of truth for "can the freeform builder represent this type without
// downgrading it". If the builder's type maps change, these expectations
// should change with them — deliberately, not silently.
describe('reportTypeSurvivesBuilder', () => {
  it('returns true for types the builder round-trips losslessly', () => {
    for (const type of [
      'device_inventory',
      'software_inventory',
      'alert_summary',
      'compliance',
      'performance'
    ] as const) {
      expect(reportTypeSurvivesBuilder(type)).toBe(true);
    }
  });

  it('returns true for native builder types', () => {
    for (const type of ['devices', 'alerts', 'patches', 'compliance', 'activity'] as const) {
      expect(reportTypeSurvivesBuilder(type)).toBe(true);
    }
  });

  it('returns false for types the builder would downgrade', () => {
    // posture → compliance, executive_summary → performance
    expect(reportTypeSurvivesBuilder('security_compliance_posture')).toBe(false);
    expect(reportTypeSurvivesBuilder('executive_summary')).toBe(false);
  });
});
