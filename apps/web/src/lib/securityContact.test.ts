import { describe, expect, it } from 'vitest';
import {
  buildSecurityTxt,
  getAuthFooterLinks,
  hasSecurityContacts,
  resolveSecurityContacts,
} from './securityContact';

describe('resolveSecurityContacts', () => {
  it('returns no contacts when nothing is configured', () => {
    const contacts = resolveSecurityContacts({});
    expect(contacts).toEqual({});
    expect(hasSecurityContacts(contacts)).toBe(false);
  });

  it('trims values and keeps only well-formed emails and https policy URLs', () => {
    const contacts = resolveSecurityContacts({
      PUBLIC_ABUSE_CONTACT: '  abuse@example.com ',
      PUBLIC_SECURITY_CONTACT: 'not-an-email',
      PUBLIC_SECURITY_POLICY_URL: 'http://example.com/security',
    });
    expect(contacts).toEqual({ abuseEmail: 'abuse@example.com' });
    expect(hasSecurityContacts(contacts)).toBe(true);
  });

  it('accepts a full configuration', () => {
    expect(
      resolveSecurityContacts({
        PUBLIC_ABUSE_CONTACT: 'abuse@example.com',
        PUBLIC_SECURITY_CONTACT: 'security@example.com',
        PUBLIC_SECURITY_POLICY_URL: 'https://example.com/trust',
      }),
    ).toEqual({
      abuseEmail: 'abuse@example.com',
      securityEmail: 'security@example.com',
      policyUrl: 'https://example.com/trust',
    });
  });

  it('ignores empty strings', () => {
    expect(resolveSecurityContacts({ PUBLIC_ABUSE_CONTACT: '', PUBLIC_SECURITY_CONTACT: '   ' })).toEqual({});
  });
});

describe('buildSecurityTxt', () => {
  const now = new Date('2026-10-16T02:00:00.000Z');

  it('returns null when no contact is configured (endpoint 404s)', () => {
    expect(buildSecurityTxt({}, now)).toBeNull();
    expect(buildSecurityTxt({ policyUrl: 'https://example.com/trust' }, now)).toBeNull();
  });

  it('emits an RFC 9116 body: security contact first, then abuse, policy, 180-day expiry (RFC 9116 §2.5.5: under a year)', () => {
    const body = buildSecurityTxt(
      {
        abuseEmail: 'abuse@example.com',
        securityEmail: 'security@example.com',
        policyUrl: 'https://example.com/trust',
      },
      now,
    );
    expect(body).toBe(
      [
        'Contact: mailto:security@example.com',
        'Contact: mailto:abuse@example.com',
        'Expires: 2027-04-14T02:00:00.000Z',
        'Policy: https://example.com/trust',
        'Preferred-Languages: en',
        '',
      ].join('\n'),
    );
  });

  it('omits Policy when unset and works with a single contact', () => {
    expect(buildSecurityTxt({ abuseEmail: 'abuse@example.com' }, now)).toBe(
      ['Contact: mailto:abuse@example.com', 'Expires: 2027-04-14T02:00:00.000Z', 'Preferred-Languages: en', ''].join(
        '\n',
      ),
    );
  });
});

describe('getAuthFooterLinks', () => {
  it('renders nothing when no contact is configured (self-hosted default)', () => {
    expect(getAuthFooterLinks({}, 'rmm.example.com')).toEqual([]);
  });

  it('prefills the abuse mailto subject with the host and links Security to the policy URL', () => {
    expect(
      getAuthFooterLinks(
        {
          abuseEmail: 'abuse@example.com',
          securityEmail: 'security@example.com',
          policyUrl: 'https://example.com/trust',
        },
        'us.rmm.example.com',
      ),
    ).toEqual([
      {
        key: 'authFooter.reportAbuse',
        href: 'mailto:abuse@example.com?subject=Abuse%20report%3A%20us.rmm.example.com',
      },
      { key: 'authFooter.security', href: 'https://example.com/trust' },
    ]);
  });

  it('falls back to the security mailto when there is no policy URL, and skips absent links', () => {
    expect(getAuthFooterLinks({ securityEmail: 'security@example.com' }, 'h')).toEqual([
      { key: 'authFooter.security', href: 'mailto:security@example.com' },
    ]);
    expect(getAuthFooterLinks({ abuseEmail: 'abuse@example.com' }, 'h')).toEqual([
      { key: 'authFooter.reportAbuse', href: 'mailto:abuse@example.com?subject=Abuse%20report%3A%20h' },
    ]);
  });
});
