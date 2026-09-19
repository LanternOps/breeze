import { describe, expect, it } from 'vitest';
import { AI_AGENT_TRIGGER_KINDS, REMEDIATION_TRIGGER_KINDS, REMEDIATION_TRIGGER_KEY_MAX, buildTriggerKey, sweepTriggerKey, parseSweepTriggerKey, alertTriggerKey, monitorTriggerKey } from '../index';

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
  // #5751 W02 (#5753): a sweep watch re-probes the SUBJECT the finding was
  // about, and the only durable record of that subject is the intent's
  // trigger_key. Build and parse must therefore be inverses.
  it('round-trips a sweep key back to its kind and subject', () => {
    expect(parseSweepTriggerKey(sweepTriggerKey('service_down', 'MSSQLSERVER')))
      .toEqual({ kind: 'service_down', subjectKey: 'MSSQLSERVER' });
    // buildTriggerKey lowercases the kind but PRESERVES subject case, so the
    // parsed subject must come back exactly as it went in.
    expect(parseSweepTriggerKey(sweepTriggerKey('SERVICE_DOWN', 'MSSQLServer')))
      .toEqual({ kind: 'service_down', subjectKey: 'MSSQLServer' });
  });

  it('keeps a subject that itself contains colons intact', () => {
    // A disk_pressure subject is a mount point — on Windows, `C:\`. A naive
    // split(':') would truncate it to 'C' and probe the wrong subject.
    expect(parseSweepTriggerKey(sweepTriggerKey('disk_pressure', 'C:\\')))
      .toEqual({ kind: 'disk_pressure', subjectKey: 'C:\\' });
  });

  it('refuses a key with no subject rather than inventing one', () => {
    // `sweepTriggerKey(kind, '')` drops the empty part, so the key has only
    // two segments. A half-record cannot be probed and must not become a
    // watch (ai_agent_fix_watches_subject_shape_chk forbids it anyway).
    expect(parseSweepTriggerKey(sweepTriggerKey('disk_pressure', ''))).toBeNull();
    expect(parseSweepTriggerKey('sweep')).toBeNull();
    expect(parseSweepTriggerKey('sweep:service_down:')).toBeNull();
  });

  it('refuses a non-sweep key, an empty key and a missing key', () => {
    expect(parseSweepTriggerKey(alertTriggerKey('Disk Low', null))).toBeNull();
    expect(parseSweepTriggerKey(monitorTriggerKey('cpu'))).toBeNull();
    expect(parseSweepTriggerKey('')).toBeNull();
    expect(parseSweepTriggerKey(null)).toBeNull();
    expect(parseSweepTriggerKey(undefined)).toBeNull();
  });

  it('builds alert and monitor keys with stable fallbacks', () => {
    expect(alertTriggerKey('Disk Low', 'rule-id')).toBe('alert:disk low');
    expect(alertTriggerKey(null, 'RULE-ID')).toBe('alert:RULE-ID');
    expect(alertTriggerKey(null, null)).toBe('alert');
    expect(monitorTriggerKey('Builtin-Key')).toBe('monitor:Builtin-Key');
  });
});
