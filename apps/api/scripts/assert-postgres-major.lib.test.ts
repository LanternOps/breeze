import { describe, expect, it, vi } from 'vitest';
import {
  checkPostgresMajor,
  parseExpectedMajor,
  runAssertPostgresMajor,
  serverMajorFromVersionNum,
} from './assert-postgres-major.lib';

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

describe('runAssertPostgresMajor (the exit code CI acts on)', () => {
  const URL = 'postgresql://user:secret-pw@db.example.invalid:5434/breeze';
  const capture = () => {
    const lines: string[] = [];
    return { lines, out: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } };
  };
  const version = (num: string, text: string) => async () => ({ server_version_num: num, server_version: text });

  it('exits 0 only when the server major matches', async () => {
    const c = capture();
    expect(await runAssertPostgresMajor({ argv: ['18'], env: { DATABASE_URL: URL }, readVersion: version('180006', '18.6'), out: c.out })).toBe(0);
    expect(c.lines.join('\n')).toMatch(/18\.6 \(major 18\), as expected/);
  });

  it('exits 1 when the leg reached another major', async () => {
    const c = capture();
    expect(await runAssertPostgresMajor({ argv: ['18'], env: { DATABASE_URL: URL }, readVersion: version('160013', '16.13'), out: c.out })).toBe(1);
  });

  it('exits 2 on bad usage or a missing DATABASE_URL, without connecting', async () => {
    const readVersion = vi.fn();
    const cases: Array<[string[], Record<string, string>]> = [[[], { DATABASE_URL: URL }], [['eighteen'], { DATABASE_URL: URL }], [['18'], {}]];
    for (const [argv, env] of cases) {
      expect(await runAssertPostgresMajor({ argv, env, readVersion, out: capture().out })).toBe(2);
    }
    expect(readVersion).not.toHaveBeenCalled();
  });

  it('exits 2 on a driver error or an unparseable version, and never prints the URL or its password', async () => {
    const driverErr = Object.assign(new Error(`connect ECONNREFUSED ${URL}`), { code: 'ECONNREFUSED' });
    const readers = [async () => { throw driverErr; }, version('garbage', '??')];
    for (const readVersion of readers) {
      const c = capture();
      expect(await runAssertPostgresMajor({ argv: ['18'], env: { DATABASE_URL: URL }, readVersion, out: c.out })).toBe(2);
      expect(c.lines.join('\n')).not.toMatch(/secret-pw|db\.example\.invalid/);
    }
  });
});
