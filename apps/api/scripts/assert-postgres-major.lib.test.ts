import { describe, expect, it } from 'vitest';
import { checkPostgresMajor, parseExpectedMajor, serverMajorFromVersionNum } from './assert-postgres-major.lib';

describe('serverMajorFromVersionNum', () => {
  it('reads the major from server_version_num (10+ numbering: MMmmpp)', () => {
    expect(serverMajorFromVersionNum('160013')).toBe(16);
    expect(serverMajorFromVersionNum('170009')).toBe(17);
    expect(serverMajorFromVersionNum('180006')).toBe(18);
    expect(serverMajorFromVersionNum(' 180006\n')).toBe(18);
  });

  it('rejects anything that is not a 10+ server_version_num', () => {
    for (const bad of ['', '18', '18.6', 'abc', '90624', '-180006', '1800060']) {
      expect(() => serverMajorFromVersionNum(bad), bad).toThrow(/server_version_num/);
    }
  });
});

describe('parseExpectedMajor', () => {
  it('takes exactly one positional major', () => {
    expect(parseExpectedMajor(['18'])).toBe(18);
    expect(parseExpectedMajor(['16'])).toBe(16);
  });

  it('rejects a missing, extra, non-integer or pre-10 major', () => {
    for (const bad of [[], ['18', '17'], ['18.0'], ['pg18'], ['9'], ['0x12'], ['']]) {
      expect(() => parseExpectedMajor(bad), JSON.stringify(bad)).toThrow(/usage/);
    }
  });
});

describe('checkPostgresMajor', () => {
  it('passes when the server major matches', () => {
    expect(checkPostgresMajor({ expected: 18, versionNum: '180006', version: '18.6 (Debian)' }))
      .toEqual({ ok: true, message: 'Postgres server is 18.6 (Debian) (major 18), as expected' });
  });

  it('fails, naming both majors, when a leg silently runs another version', () => {
    const r = checkPostgresMajor({ expected: 18, versionNum: '160013', version: '16.13' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/expected major 18.*16\.13.*major 16/);
  });
});
