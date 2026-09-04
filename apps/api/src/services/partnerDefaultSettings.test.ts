import { describe, it, expect } from 'vitest';
import { applyNewPartnerDefaultSettings } from './partnerDefaultSettings';

describe('applyNewPartnerDefaultSettings (#3608 / #4520)', () => {
  it('produces the inbound opt-out default when no settings are supplied', () => {
    expect(applyNewPartnerDefaultSettings()).toEqual({
      ticketing: { inbound: { enabled: false } },
    });
  });

  it('treats null settings as absent', () => {
    expect(applyNewPartnerDefaultSettings(null)).toEqual({
      ticketing: { inbound: { enabled: false } },
    });
  });

  it('preserves unrelated caller-supplied settings', () => {
    expect(
      applyNewPartnerDefaultSettings({
        security: { ipAllowlist: ['10.0.0.0/8'] },
        branding: { color: 'blue' },
      }),
    ).toEqual({
      security: { ipAllowlist: ['10.0.0.0/8'] },
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
    });
  });

  it('does not override an explicit enabled:true from the caller', () => {
    expect(
      applyNewPartnerDefaultSettings({ ticketing: { inbound: { enabled: true } } }),
    ).toEqual({ ticketing: { inbound: { enabled: true } } });
  });

  it('does not override an explicit enabled:false from the caller', () => {
    expect(
      applyNewPartnerDefaultSettings({ ticketing: { inbound: { enabled: false } } }),
    ).toEqual({ ticketing: { inbound: { enabled: false } } });
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
    });
    expect(applyNewPartnerDefaultSettings({ ticketing: { inbound: 7 } })).toEqual({
      ticketing: { inbound: { enabled: false } },
    });
    expect(applyNewPartnerDefaultSettings({ ticketing: { inbound: null } })).toEqual({
      ticketing: { inbound: { enabled: false } },
    });
  });

  it('normalizes a non-object settings value to the defaults object', () => {
    expect(applyNewPartnerDefaultSettings('nonsense')).toEqual({
      ticketing: { inbound: { enabled: false } },
    });
    expect(applyNewPartnerDefaultSettings([1, 2, 3])).toEqual({
      ticketing: { inbound: { enabled: false } },
    });
  });
});
