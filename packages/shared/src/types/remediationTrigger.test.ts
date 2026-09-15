import { describe, expect, it } from 'vitest';
import { AI_AGENT_TRIGGER_KINDS, REMEDIATION_TRIGGER_KINDS, REMEDIATION_TRIGGER_KEY_MAX, buildTriggerKey, sweepTriggerKey, alertTriggerKey, monitorTriggerKey } from '../index';

describe('remediation trigger catalog', () => {
  it('contains every agent trigger without duplicates', () => {
    for (const kind of AI_AGENT_TRIGGER_KINDS) expect(REMEDIATION_TRIGGER_KINDS).toContain(kind);
    expect(new Set(REMEDIATION_TRIGGER_KINDS).size).toBe(REMEDIATION_TRIGGER_KINDS.length);
  });
});
describe('trigger keys', () => {
  it('normalizes kind and facet while preserving subject case', () => {
    expect(sweepTriggerKey('SERVICE_DOWN', 'MSSQLSERVER')).toBe('sweep:service_down:MSSQLSERVER');
    expect(buildTriggerKey(['ALERT', ' disk   low ', 'C'])).toBe('alert:disk low:C');
  });
  it('caps keys and handles empty parts', () => {
    expect(buildTriggerKey(['sweep', 'disk_pressure', 'x'.repeat(400)])).toHaveLength(REMEDIATION_TRIGGER_KEY_MAX);
    expect(buildTriggerKey([])).toBe('');
    expect(sweepTriggerKey('disk_pressure', '')).toBe('sweep:disk_pressure');
  });
  it('builds alert and monitor keys with stable fallbacks', () => {
    expect(alertTriggerKey('Disk Low', 'rule-id')).toBe('alert:disk low');
    expect(alertTriggerKey(null, 'RULE-ID')).toBe('alert:RULE-ID');
    expect(alertTriggerKey(null, null)).toBe('alert');
    expect(monitorTriggerKey('Builtin-Key')).toBe('monitor:Builtin-Key');
  });
});
