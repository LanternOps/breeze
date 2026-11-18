import { describe, expect, it } from 'vitest';
import { summarizeToolInputForAudit } from './aiToolAuditInput';

const MD5 = 'f'.repeat(32);

describe('summarizeToolInputForAudit (#6268)', () => {
  it('replaces ioc_hunt iocs with { count, kinds } and keeps the rest', () => {
    const input = {
      action: 'import_iocs', ruleSetId: 'set-1', label: 'Advisory 7',
      iocs: [{ kind: 'md5', value: MD5 }, { kind: 'domain', value: 'bad.example' }, { kind: 'md5', value: 'e'.repeat(32) }],
    };
    const out = summarizeToolInputForAudit('ioc_hunt', input);
    expect(out).toEqual({ action: 'import_iocs', ruleSetId: 'set-1', label: 'Advisory 7', iocs: { count: 3, kinds: ['domain', 'md5'] } });
    expect(JSON.stringify(out)).not.toContain(MD5);
    expect(JSON.stringify(out)).not.toContain('bad.example');
    // The caller's object is not mutated (the same input is executed / persisted elsewhere).
    expect(Array.isArray(input.iocs)).toBe(true);
  });

  it('tolerates a non-array or malformed iocs value without echoing it', () => {
    expect(summarizeToolInputForAudit('ioc_hunt', { action: 'import_iocs', iocs: 'md5:' + MD5 })).toEqual({ action: 'import_iocs', iocs: { count: 0, kinds: [] } });
    expect(summarizeToolInputForAudit('ioc_hunt', { action: 'import_iocs', iocs: [null, 5, { value: MD5 }] }))
      .toEqual({ action: 'import_iocs', iocs: { count: 3, kinds: [] } });
    expect(summarizeToolInputForAudit('ioc_hunt', { action: 'sweep_status', sweepId: 's-1' })).toEqual({ action: 'sweep_status', sweepId: 's-1' });
  });

  it('is the identity for every other tool', () => {
    const input = { action: 'scan', deviceId: 'd-1', iocs: [{ kind: 'md5', value: MD5 }] };
    expect(summarizeToolInputForAudit('security_scan', input)).toBe(input);
  });
});
