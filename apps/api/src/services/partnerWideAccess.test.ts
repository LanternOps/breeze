import { describe, expect, it } from 'vitest';
import {
  canManagePartnerWidePolicies,
  PartnerWideWriteDeniedError,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE
} from './partnerWideAccess';

describe('PARTNER_WIDE_WRITE_DENIED_MESSAGE', () => {
  // The constant is returned by every canManagePartnerWidePolicies gate, including
  // routes that administer partner-wide state which is NOT a policy (partner login
  // branding today, and more such surfaces to come). Resource-specific wording at
  // those call sites is wrong copy.
  it('does not name a specific resource kind', () => {
    for (const resourceWord of ['policy', 'policies', 'template', 'profile', 'package', 'window']) {
      expect(PARTNER_WIDE_WRITE_DENIED_MESSAGE.toLowerCase()).not.toContain(resourceWord);
    }
  });

  it('still tells the caller which capability is missing', () => {
    expect(PARTNER_WIDE_WRITE_DENIED_MESSAGE).toContain('partner-wide');
    // Sibling route-local denials all name this capability; keep the wording aligned.
    expect(PARTNER_WIDE_WRITE_DENIED_MESSAGE).toContain('full partner org access');
    expect(PARTNER_WIDE_WRITE_DENIED_MESSAGE).toContain('orgAccess must be "all"');
  });

  it('is the message carried by PartnerWideWriteDeniedError', () => {
    expect(new PartnerWideWriteDeniedError().message).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
  });
});

describe('canManagePartnerWidePolicies', () => {
  it('allows system scope and full-partner admins only', () => {
    expect(canManagePartnerWidePolicies({ scope: 'system', partnerOrgAccess: null })).toBe(true);
    expect(canManagePartnerWidePolicies({ scope: 'partner', partnerOrgAccess: 'all' })).toBe(true);
    expect(canManagePartnerWidePolicies({ scope: 'partner', partnerOrgAccess: 'selected' })).toBe(
      false
    );
    expect(canManagePartnerWidePolicies({ scope: 'partner', partnerOrgAccess: null })).toBe(false);
    expect(canManagePartnerWidePolicies({ scope: 'organization', partnerOrgAccess: null })).toBe(
      false
    );
  });
});
