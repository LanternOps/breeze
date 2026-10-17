import { describe, expect, it } from 'vitest';
import { buildDigestEmail, conditionLabel, digestSubject } from './digestEmail';
import type { DigestIncident } from './digestPlan';

const inc = (over: Partial<DigestIncident> = {}): DigestIncident => ({
  id: 'i1',
  orgId: null,
  orgName: null,
  displayName: 'Huntress',
  condition: 'sync_failed',
  severity: 'transient',
  detail: null,
  fixHref: '/integrations#huntress',
  openedAt: new Date('2026-10-13T09:00:00Z'),
  resolvedAt: null,
  resolution: null,
  ...over,
});

const base = {
  now: new Date('2026-10-16T08:09:00Z'),
  timeZone: 'UTC',
  appBaseUrl: 'https://app.example.test',
  unsubscribeUrl: 'https://app.example.test/api/v1/email/unsubscribe?t=abc.def',
};

describe('digest email', () => {
  it('subject counts open connections, or restored ones when nothing is open', () => {
    expect(digestSubject({ open: [inc()], restored: [] })).toBe('Connection health: 1 connection needs attention');
    expect(digestSubject({ open: [inc(), inc({ id: 'i2' })], restored: [] })).toBe('Connection health: 2 connections need attention');
    expect(digestSubject({ open: [], restored: [inc()] })).toBe('Connection health: 1 connection restored');
  });

  it('escapes hostile detail and names in HTML', () => {
    const { html, text } = buildDigestEmail({
      ...base,
      plan: { open: [inc({ displayName: '<img src=x onerror=alert(1)>', detail: '<script>alert(1)</script> & "x"' })], restored: [] },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    // Plain text carries the sanitized detail as-is.
    expect(text).toContain('<script>alert(1)</script>');
  });

  it('renders absolute fix links, partner-wide group first, age and condition label', () => {
    const { html, text } = buildDigestEmail({
      ...base,
      plan: {
        open: [
          inc({ id: 'p' }),
          inc({ id: 'o', orgId: 'org-1', orgName: 'Acme Dental', displayName: 'M365', condition: 'needs_consent', fixHref: '/integrations#m365' }),
        ],
        restored: [],
      },
    });
    expect(html).toContain('href="https://app.example.test/integrations#huntress"');
    expect(html).toContain('href="https://app.example.test/integrations#m365"');
    expect(html.indexOf('Partner-wide connections')).toBeLessThan(html.indexOf('Acme Dental'));
    expect(text).toContain('Sync failed · open 3 days');
    expect(text).toContain('Consent needed');
  });

  it('carries the unsubscribe link and the preferences link in HTML and text', () => {
    const { html, text } = buildDigestEmail({ ...base, plan: { open: [inc()], restored: [] } });
    expect(html).toContain('href="https://app.example.test/api/v1/email/unsubscribe?t=abc.def"');
    expect(text).toContain('Unsubscribe: https://app.example.test/api/v1/email/unsubscribe?t=abc.def');
    expect(text).toContain('Email preferences: https://app.example.test/settings/profile');
  });

  it('lists restored connections', () => {
    const { text } = buildDigestEmail({
      ...base,
      plan: { open: [], restored: [inc({ resolvedAt: base.now, resolution: 'recovered', orgId: 'o', orgName: 'Acme' })] },
    });
    expect(text).toContain('Restored since your last digest');
    expect(text).toContain('- Huntress — Acme');
  });

  it('unknown condition codes fall back to a generic label', () => {
    expect(conditionLabel('something_new')).toBe('Needs attention');
    expect(conditionLabel('__proto__')).toBe('Needs attention');
  });
});
