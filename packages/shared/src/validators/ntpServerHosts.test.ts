import { describe, expect, it } from 'vitest';
import vectors from './__fixtures__/ntpServers.json';
import {
  isValidNtpServerHost,
  ntpServerHostSchema,
  parseNtpServerHosts,
} from './timeSync';

describe('NTP host contract shared with Go', () => {
  it.each(vectors.valid)('accepts %s', (host) => {
    expect(isValidNtpServerHost(host)).toBe(true);
    expect(ntpServerHostSchema.safeParse(host).success).toBe(true);
  });
  it.each(vectors.invalid)('rejects %s', (host) => {
    expect(isValidNtpServerHost(host)).toBe(false);
    expect(ntpServerHostSchema.safeParse(host).success).toBe(false);
  });
  it.each([
    ['  time.a.com,0x9   time.b.com,0x8  ', ['time.a.com', 'time.b.com']],
    ['time.a.com,0x1,0x8', ['time.a.com']],
    ['', []],
    [null, []],
    ['dc01\tpool.ntp.org,0X9', ['dc01', 'pool.ntp.org']],
    ['bad,flag', ['bad,flag']],
    ['pool.ntp.org;bad', ['pool.ntp.org;bad']],
  ])('parses %s without masking malformed flags', (raw, expected) => {
    expect(parseNtpServerHosts(raw as string | null)).toEqual(expected);
  });
});
