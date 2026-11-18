import { describe, expect, it } from 'vitest';
import {
  WINDOWS_SECURITY_AUDITING_PROVIDER,
  WINDOWS_SECURITY_NOISE_EVENT_IDS,
  windowsSecurityNoiseEventId,
} from './eventLogNoiseFilter';

// Shape the Windows agent sends for a Security-log record (#10702):
// eventId "<windows id>:<record id>", details.eventId the numeric Windows id.
function securityEvent(id: number, overrides: Record<string, unknown> = {}) {
  return {
    category: 'security',
    source: WINDOWS_SECURITY_AUDITING_PROVIDER,
    eventId: `${id}:123456`,
    details: { recordId: 123456, logName: 'Security', eventId: id, auditFailure: true },
    ...overrides,
  };
}

describe('Windows Security event-log noise filter (#11735)', () => {
  it('lists exactly the noise IDs observed in production and keeps the security-relevant ones out', () => {
    expect([...WINDOWS_SECURITY_NOISE_EVENT_IDS.keys()].sort()).toEqual([4957, 5038, 5061, 5152, 5157]);
    // 4625 (failed logon) and 4719 (audit policy changed) are the signal the
    // Security stream exists for; they must never be classified as noise.
    for (const keep of [4625, 4719, 4740, 1102, 4720, 4726, 4728, 4732, 4756, 4771]) {
      expect(WINDOWS_SECURITY_NOISE_EVENT_IDS.has(keep)).toBe(false);
    }
    for (const reason of WINDOWS_SECURITY_NOISE_EVENT_IDS.values()) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it.each([5038, 5157, 5152, 4957, 5061])('classifies Security-Auditing %i as noise', (id) => {
    expect(windowsSecurityNoiseEventId(securityEvent(id))).toBe(id);
  });

  it.each([4625, 4719, 4740, 1102, 4771])('keeps Security-Auditing %i', (id) => {
    expect(windowsSecurityNoiseEventId(securityEvent(id))).toBeNull();
  });

  it('matches the provider name case-insensitively', () => {
    expect(windowsSecurityNoiseEventId(securityEvent(5038, { source: 'microsoft-windows-security-auditing' }))).toBe(5038);
  });

  it('falls back to the numeric eventId prefix when details carry no event id', () => {
    expect(windowsSecurityNoiseEventId(securityEvent(5157, { details: { logName: 'Security' } }))).toBe(5157);
    expect(windowsSecurityNoiseEventId(securityEvent(5157, { details: undefined }))).toBe(5157);
    expect(windowsSecurityNoiseEventId(securityEvent(5157, { eventId: '5157', details: undefined }))).toBe(5157);
  });

  it('never drops a record whose eventId prefix and details.eventId disagree', () => {
    // A failed logon must not be dropped because one of its two agent-supplied
    // ids names a noise event, and vice versa.
    expect(windowsSecurityNoiseEventId(securityEvent(4625, { details: { logName: 'Security', eventId: 5157 } }))).toBeNull();
    expect(windowsSecurityNoiseEventId(securityEvent(5157, { details: { logName: 'Security', eventId: 4625 } }))).toBeNull();
  });

  it.each([
    ['another provider reusing the numeric id', { source: 'Application Error' }],
    ['a non-security category', { category: 'application' }],
    ['a log other than Security', { details: { logName: 'Application', eventId: 5038 } }],
    ['a non-numeric (Linux/macOS) event id', { eventId: 'sshd:5038:abcdef0123456789', details: undefined }],
    ['a numeric prefix that only starts with a noise id', { eventId: '50380:1', details: undefined }],
    ['no event id at all', { eventId: undefined, details: undefined }],
  ])('does not drop %s', (_label, overrides) => {
    expect(windowsSecurityNoiseEventId(securityEvent(5038, overrides))).toBeNull();
  });
});
