import { describe, expect, it } from 'vitest';
import { buildMfaEnrollmentUrl } from './mfaEnrollmentHandoff';

describe('MfaEnrollmentRequiredScreen handoff', () => {
  it('builds the configured same-server enrollment URL', () => {
    expect(buildMfaEnrollmentUrl('https://breeze.example.test/', '/auth/mfa/setup'))
      .toBe('https://breeze.example.test/auth/mfa/setup');
  });

  it.each([
    ['javascript:alert(1)', '/auth/mfa/setup'],
    ['https://breeze.example.test', 'https://evil.example/setup'],
    ['https://breeze.example.test', '//evil.example/setup'],
  ])('rejects an unsafe handoff (%s, %s)', (server, path) => {
    expect(buildMfaEnrollmentUrl(server, path)).toBeNull();
  });
});
