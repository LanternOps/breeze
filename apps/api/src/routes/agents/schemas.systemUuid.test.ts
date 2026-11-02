import { describe, expect, it } from 'vitest';
import { enrollSchema, updateHardwareSchema } from './schemas';

const enrollBase = {
  enrollmentKey: 'k',
  hostname: 'PC-01',
  osType: 'windows' as const,
  osVersion: '11',
  architecture: 'amd64',
  agentVersion: '1.0.0',
};

describe('systemUuid intake (#8318 §7.2): tolerant, normalized', () => {
  it('normalizes a valid value on enroll and on the hardware report', () => {
    const raw = '{4C4C4544-0042-3510-8051-B4C04F4D3132}';
    expect(enrollSchema.parse({ ...enrollBase, hardwareInfo: { systemUuid: raw } }).hardwareInfo?.systemUuid)
      .toBe('4c4c4544-0042-3510-8051-b4c04f4d3132');
    expect(updateHardwareSchema.parse({ systemUuid: raw }).systemUuid).toBe('4c4c4544-0042-3510-8051-b4c04f4d3132');
  });

  it.each([
    ['malformed', 'not-a-uuid'],
    ['placeholder', '03000200-0400-0500-0006-000700080009'],
    ['all zero', '00000000-0000-0000-0000-000000000000'],
    ['a number', 12345],
    ['an object', { uuid: 'x' }],
    ['null', null],
  ])('a %s value never fails the request and becomes null', (_label, value) => {
    const enroll = enrollSchema.safeParse({ ...enrollBase, hardwareInfo: { serialNumber: 'SN1', systemUuid: value } });
    expect(enroll.success).toBe(true);
    expect(enroll.data?.hardwareInfo?.systemUuid).toBeNull();
    expect(enroll.data?.hardwareInfo?.serialNumber).toBe('SN1');
    const report = updateHardwareSchema.safeParse({ cpuModel: 'x', systemUuid: value });
    expect(report.success).toBe(true);
    expect(report.data?.systemUuid).toBeNull();
  });

  it('an absent value stays absent, so the stored value is left alone', () => {
    const report = updateHardwareSchema.parse({ cpuModel: 'x' });
    expect('systemUuid' in report).toBe(false);
    const enroll = enrollSchema.parse({ ...enrollBase, hardwareInfo: { cpuModel: 'x' } });
    expect(enroll.hardwareInfo && 'systemUuid' in enroll.hardwareInfo).toBe(false);
  });
});
