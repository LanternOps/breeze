import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __resetUnknownDeviceOsWarnings,
  compareOsVersions,
  DECLARED_MACOS_FLOOR,
  evaluateOsFloor,
  noteOsFloorHold,
  OS_BELOW_MINIMUM_REASON,
  OS_VERSION_UNKNOWN_REASON,
  parseDeviceOsVersion,
  parseOsFloor,
} from './agentOsFloor';

const mac = (reported: string | null, stored: string | null = null) => ({
  platform: 'macos',
  reportedOsVersion: reported,
  storedOsVersion: stored,
});

describe('parseDeviceOsVersion', () => {
  it('parses the agent shape "darwin 15.8.1"', () => {
    expect(parseDeviceOsVersion('macos', 'darwin 15.8.1')).toEqual([15, 8, 1]);
  });
  it('accepts macos / mac os x prefixes and bare versions', () => {
    expect(parseDeviceOsVersion('macos', 'macOS 13.6')).toEqual([13, 6]);
    expect(parseDeviceOsVersion('macos', 'Mac OS X 12.7.6')).toEqual([12, 7, 6]);
    expect(parseDeviceOsVersion('macos', ' 14 ')).toEqual([14]);
  });
  it('parses compat 10.16 as unknown', () => {
    expect(parseDeviceOsVersion('macos', 'darwin 10.16')).toBeNull();
    expect(parseDeviceOsVersion('macos', '10.16.0')).toBeNull();
  });
  it('bare darwin is unknown', () => {
    expect(parseDeviceOsVersion('macos', 'darwin')).toBeNull();
    expect(parseDeviceOsVersion('macos', '')).toBeNull();
    expect(parseDeviceOsVersion('macos', null)).toBeNull();
  });
  it('rejects garbage', () => {
    expect(parseDeviceOsVersion('macos', 'darwin 15.x')).toBeNull();
    expect(parseDeviceOsVersion('macos', 'darwin 1234.1')).toBeNull();
  });
  it('non-macos platforms are not parsed', () => {
    expect(parseDeviceOsVersion('windows', '10.0.19045')).toBeNull();
    expect(parseDeviceOsVersion('linux', 'ubuntu 22.04')).toBeNull();
  });
});

describe('parseOsFloor / compareOsVersions', () => {
  it('treats missing parts as 0', () => {
    expect(compareOsVersions([13], [13, 0, 0])).toBe(0);
    expect(compareOsVersions([12, 7, 6], [13])).toBeLessThan(0);
    expect(compareOsVersions([13, 0, 1], [13])).toBeGreaterThan(0);
  });
  it('parses valid floors and rejects malformed ones', () => {
    expect(parseOsFloor('13.0')).toEqual([13, 0]);
    expect(parseOsFloor('12.x')).toBeNull();
    expect(parseOsFloor('')).toBeNull();
  });
});

describe('evaluateOsFloor', () => {
  it('null floor always allows', () => {
    expect(evaluateOsFloor(mac('darwin 10.15'), null)).toEqual({ kind: 'allow' });
    expect(evaluateOsFloor(mac('darwin'), null)).toEqual({ kind: 'allow' });
  });

  it('holds darwin 12.7.6 below 13.0', () => {
    expect(evaluateOsFloor(mac('darwin 12.7.6'), '13.0')).toEqual({
      kind: 'hold',
      reason: OS_BELOW_MINIMUM_REASON,
      requiredOs: '13.0',
      reportedOs: '12.7.6',
    });
  });

  it('allows darwin 13.0 and above', () => {
    expect(evaluateOsFloor(mac('darwin 13.0'), '13.0')).toEqual({ kind: 'allow' });
    expect(evaluateOsFloor(mac('darwin 15.8.1'), '13.0')).toEqual({ kind: 'allow' });
  });

  it('allows 13 vs floor 13.0.0', () => {
    expect(evaluateOsFloor(mac('darwin 13'), '13.0.0')).toEqual({ kind: 'allow' });
  });

  it('falls back to the stored version when the beat omits it', () => {
    expect(evaluateOsFloor(mac(null, 'darwin 12.7.6'), '13.0')).toMatchObject({
      kind: 'hold',
      reason: OS_BELOW_MINIMUM_REASON,
      reportedOs: '12.7.6',
    });
    expect(evaluateOsFloor(mac('darwin', 'darwin 14.1'), '13.0')).toEqual({ kind: 'allow' });
  });

  it('the beat wins over a stale stored value', () => {
    expect(evaluateOsFloor(mac('darwin 13.1', 'darwin 12.7.6'), '13.0')).toEqual({ kind: 'allow' });
  });

  it('holds an unknown macOS version when the release has a floor (fail closed)', () => {
    expect(evaluateOsFloor(mac('darwin 10.16'), '13.0')).toEqual({
      kind: 'hold',
      reason: OS_VERSION_UNKNOWN_REASON,
      requiredOs: '13.0',
      reportedOs: null,
    });
    expect(evaluateOsFloor(mac(null, null), '12.0')).toMatchObject({ kind: 'hold', reason: OS_VERSION_UNKNOWN_REASON });
  });

  // Only macOS floors are declared (plan Open Decision 6). A stray floor on a
  // Windows or Linux row must not hold that whole fleet as "unknown".
  it('non-macos platforms are never held, even under a floor', () => {
    expect(
      evaluateOsFloor({ platform: 'windows', reportedOsVersion: '10.0.19045', storedOsVersion: null }, '13.0'),
    ).toEqual({ kind: 'allow' });
    expect(evaluateOsFloor({ platform: 'linux', reportedOsVersion: null, storedOsVersion: null }, '13.0')).toEqual({
      kind: 'allow',
    });
  });

  it('DECLARED_MACOS_FLOOR mirrors agent/platform-floors.json', () => {
    const floors = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../agent/platform-floors.json'), 'utf8'),
    );
    expect(DECLARED_MACOS_FLOOR).toBe(floors.macos);
  });

  it('a malformed floor fails closed', () => {
    expect(evaluateOsFloor(mac('darwin 15.0'), '15.x')).toMatchObject({ kind: 'hold' });
  });
});

describe('noteOsFloorHold', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetUnknownDeviceOsWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('warns once per (platform, raw shape) for unknown-OS holds', () => {
    const facts = mac('darwin');
    const hold = evaluateOsFloor(facts, '13.0');
    if (hold.kind !== 'hold') throw new Error('expected hold');
    noteOsFloorHold(facts, hold);
    noteOsFloorHold(facts, hold);
    expect(warn).toHaveBeenCalledTimes(1);
    const other = mac('darwin 10.16');
    const hold2 = evaluateOsFloor(other, '13.0');
    if (hold2.kind !== 'hold') throw new Error('expected hold');
    noteOsFloorHold(other, hold2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not warn for a parsed below-minimum hold', () => {
    const facts = mac('darwin 12.7.6');
    const hold = evaluateOsFloor(facts, '13.0');
    if (hold.kind !== 'hold') throw new Error('expected hold');
    noteOsFloorHold(facts, hold);
    expect(warn).not.toHaveBeenCalled();
  });
});
