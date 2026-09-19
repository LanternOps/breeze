import { describe, it, expect } from 'vitest';
import { applyNewPartnerDefaultSettings } from './partnerDefaultSettings';

describe('applyNewPartnerDefaultSettings (#3608 / #4520)', () => {
  it('produces the inbound opt-out default when no settings are supplied', () => {
    expect(applyNewPartnerDefaultSettings()).toEqual({
      ticketing: { inbound: { enabled: false } },
      security: { requireMfa: true },
    });
  });

  it('treats null settings as absent', () => {
    expect(applyNewPartnerDefaultSettings(null)).toEqual({
      ticketing: { inbound: { enabled: false } },
      security: { requireMfa: true },
    });
  });

  it('preserves unrelated caller-supplied settings', () => {
    expect(
      applyNewPartnerDefaultSettings({
        security: { ipAllowlist: ['10.0.0.0/8'] },
        branding: { color: 'blue' },
      }),
    ).toEqual({
      security: { ipAllowlist: ['10.0.0.0/8'], requireMfa: true },
      branding: { color: 'blue' },
      ticketing: { inbound: { enabled: false } },
    });
  });

  it('preserves sibling keys under ticketing and ticketing.inbound', () => {
    expect(
      applyNewPartnerDefaultSettings({
        ticketing: {
          slaHours: 4,
          inbound: { defaultTriageOrgId: 'org-1', unknownSenderMode: 'triage' },
        },
      }),
    ).toEqual({
      ticketing: {
        slaHours: 4,
        inbound: {
          defaultTriageOrgId: 'org-1',
          unknownSenderMode: 'triage',
          enabled: false,
        },
      },
      security: { requireMfa: true },
    });
  });

  it('does not override an explicit enabled:true from the caller', () => {
    expect(
      applyNewPartnerDefaultSettings({ ticketing: { inbound: { enabled: true } } }),
    ).toEqual({ ticketing: { inbound: { enabled: true } }, security: { requireMfa: true } });
  });

  it('does not override an explicit enabled:false from the caller', () => {
    expect(
      applyNewPartnerDefaultSettings({ ticketing: { inbound: { enabled: false } } }),
    ).toEqual({ ticketing: { inbound: { enabled: false } }, security: { requireMfa: true } });
  });

  it('does not mutate the caller-supplied object', () => {
    const input = { ticketing: { inbound: { unknownSenderMode: 'triage' } } };
    const snapshot = structuredClone(input);
    const out = applyNewPartnerDefaultSettings(input);

    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.ticketing).not.toBe(input.ticketing);
  });

  it('replaces a non-object ticketing branch rather than leaving the reader fail-open', () => {
    // `loadPartnerInboundPolicy` reads `settings.ticketing.inbound.enabled` and
    // treats anything it cannot traverse as absent → enabled. A garbage branch
    // must therefore be replaced, not preserved.
    expect(applyNewPartnerDefaultSettings({ ticketing: 'nonsense' })).toEqual({
      ticketing: { inbound: { enabled: false } },
      security: { requireMfa: true },
    });
    expect(applyNewPartnerDefaultSettings({ ticketing: { inbound: 7 } })).toEqual({
      ticketing: { inbound: { enabled: false } },
      security: { requireMfa: true },
    });
    expect(applyNewPartnerDefaultSettings({ ticketing: { inbound: null } })).toEqual({
      ticketing: { inbound: { enabled: false } },
      security: { requireMfa: true },
    });
  });

  it('normalizes a non-object settings value to the defaults object', () => {
    expect(applyNewPartnerDefaultSettings('nonsense')).toEqual({
      ticketing: { inbound: { enabled: false } },
      security: { requireMfa: true },
    });
    expect(applyNewPartnerDefaultSettings([1, 2, 3])).toEqual({
      ticketing: { inbound: { enabled: false } },
      security: { requireMfa: true },
    });
  });

  // Spec: docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md (D1)
  describe('security.requireMfa default (new partners require MFA)', () => {
    it('fills security.requireMfa=true when the caller sends no security branch', () => {
      expect(applyNewPartnerDefaultSettings()).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: true },
      });
    });

    it('preserves an explicit requireMfa=false (dev seed / customer opt-out)', () => {
      expect(applyNewPartnerDefaultSettings({ security: { requireMfa: false } })).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: false },
      });
    });

    it('preserves an explicit requireMfa=true', () => {
      expect(applyNewPartnerDefaultSettings({ security: { requireMfa: true } })).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: true },
      });
    });

    it('preserves unrelated security keys while filling the default', () => {
      expect(
        applyNewPartnerDefaultSettings({
          security: { ipAllowlist: ['10.0.0.0/8'], allowedMethods: { sms: false } },
        }),
      ).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { ipAllowlist: ['10.0.0.0/8'], allowedMethods: { sms: false }, requireMfa: true },
      });
    });

    it('replaces a non-object security branch rather than preserving garbage', () => {
      expect(applyNewPartnerDefaultSettings({ security: 'nonsense' })).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: true },
      });
      expect(applyNewPartnerDefaultSettings({ security: null })).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: true },
      });
    });

    it('does not mutate the caller-supplied security object', () => {
      const input = { security: { ipAllowlist: ['10.0.0.0/8'] } };
      const snapshot = structuredClone(input);
      const out = applyNewPartnerDefaultSettings(input);
      expect(input).toEqual(snapshot);
      expect(out.security).not.toBe(input.security);
    });
  });
});
