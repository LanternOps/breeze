import { describe, it, expect } from 'vitest';
import {
  LEGACY_AUTH_CLIENT_APPS,
  foreignCountrySignins,
  isRiskFieldMeasured,
  signinCoverageLine,
} from './identityAccess';

describe('isRiskFieldMeasured', () => {
  it('treats Graph’s hidden sentinel as unmeasured, not as a risk level', () => {
    expect(isRiskFieldMeasured('hidden')).toBe(false);
    expect(isRiskFieldMeasured(null)).toBe(false);
    expect(isRiskFieldMeasured('none')).toBe(true);   // 'none' IS a measurement
    expect(isRiskFieldMeasured('high')).toBe(true);
  });

  it('treats unknownFutureValue and blanks as unmeasured', () => {
    expect(isRiskFieldMeasured('unknownFutureValue')).toBe(false);
    expect(isRiskFieldMeasured('   ')).toBe(false);
    expect(isRiskFieldMeasured(undefined)).toBe(false);
  });
});

describe('foreignCountrySignins', () => {
  it('returns null when no home countries are configured — not configured, NOT none', () => {
    expect(foreignCountrySignins([{ locationCountry: 'RU' }], [])).toBeNull();
  });

  it('counts sign-ins outside the configured set and ignores unknown locations', () => {
    expect(foreignCountrySignins(
      [{ locationCountry: 'RU' }, { locationCountry: 'US' }, { locationCountry: null }],
      ['US'],
    )).toBe(1);
  });

  it('compares country codes case-insensitively', () => {
    expect(foreignCountrySignins([{ locationCountry: 'us' }], ['US'])).toBe(0);
  });
});

describe('signinCoverageLine', () => {
  it('says the tenant is unlicensed rather than implying there were no sign-ins', () => {
    const line = signinCoverageLine({ unlicensed: true });
    expect(line).toMatch(/licen[cs]e/i);
    expect(line).not.toMatch(/\bno sign-ins\b/i);
  });

  it('names the shortfall when Breeze started collecting mid-period', () => {
    const line = signinCoverageLine({ periodStart: '2026-09-01', periodEnd: '2026-09-30', coveredFrom: '2026-09-20' });
    expect(line).toMatch(/2026-09-20/);
    expect(line).toMatch(/does not cover/i);
  });

  it('is empty when coverage spans the period and the tenant is licensed', () => {
    expect(signinCoverageLine({
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      coveredFrom: '2026-09-01', coveredTo: '2026-09-30',
    })).toBe('');
  });

  it('appends an explicit gap note when one is present', () => {
    const line = signinCoverageLine({
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      coveredFrom: '2026-09-01', coveredTo: '2026-09-30',
      gapNote: 'No successful sync between 2026-09-10 and 2026-09-14.',
    });
    expect(line).toMatch(/No successful sync between 2026-09-10/);
  });

  it('says no sign-in events were collected without claiming nobody signed in', () => {
    const line = signinCoverageLine({ periodStart: '2026-09-01', periodEnd: '2026-09-30', coveredFrom: null });
    expect(line).toMatch(/no interactive sign-in events/i);
    expect(line).not.toMatch(/\bnobody signed in\b/i);
  });
});

describe('LEGACY_AUTH_CLIENT_APPS', () => {
  it('names the Graph clientAppUsed values that indicate legacy authentication', () => {
    expect(LEGACY_AUTH_CLIENT_APPS.has('IMAP4')).toBe(true);
    expect(LEGACY_AUTH_CLIENT_APPS.has('Other clients')).toBe(true);
    expect(LEGACY_AUTH_CLIENT_APPS.has('Authenticated SMTP')).toBe(true);
    // Modern authentication values must NOT be in the set.
    expect(LEGACY_AUTH_CLIENT_APPS.has('Browser')).toBe(false);
    expect(LEGACY_AUTH_CLIENT_APPS.has('Mobile Apps and Desktop clients')).toBe(false);
  });
});
