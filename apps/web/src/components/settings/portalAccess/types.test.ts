import { describe, expect, it } from 'vitest';
import { makePolicyView } from './viewFixture';
import {
  capabilityProviderSet,
  draftHasSsoMethod,
  effectiveProviderSet,
  effectiveSsoProviders,
  ssoProviderSet,
} from './types';

describe('SSO provider wording helpers (W7 #11384)', () => {
  it('picks one wording per provider set; neither falls back to the Microsoft wording', () => {
    expect(ssoProviderSet({ microsoft: true, google: false })).toBe('microsoft');
    expect(ssoProviderSet({ microsoft: false, google: true })).toBe('google');
    expect(ssoProviderSet({ microsoft: true, google: true })).toBe('both');
    expect(ssoProviderSet({ microsoft: false, google: false })).toBe('microsoft');
  });

  it('capability wording never names Google while the deployment cannot run it', () => {
    expect(capabilityProviderSet({ entra: true, google: false, selfRegistration: true })).toBe('microsoft');
    expect(capabilityProviderSet({ entra: false, google: false, selfRegistration: false })).toBe('microsoft');
    expect(capabilityProviderSet({ entra: false, google: true, selfRegistration: false })).toBe('google');
    expect(capabilityProviderSet({ entra: true, google: true, selfRegistration: false })).toBe('both');
  });

  it('Google counts as effective only with the capability and, on an org view, a verified domain', () => {
    const on = { googleEnabled: true };
    expect(effectiveSsoProviders(makePolicyView({ inherited: on }), {}).google).toBe(false);
    expect(effectiveSsoProviders(makePolicyView({ capabilities: { google: true }, inherited: on }), {}).google).toBe(false);
    expect(effectiveSsoProviders(
      makePolicyView({ capabilities: { google: true }, inherited: on, verifiedDomains: ['acme.example.com'] }), {},
    ).google).toBe(true);
    // A partner view has no domains of its own: the default applies wherever one is verified.
    expect(effectiveSsoProviders(makePolicyView({ kind: 'partner', capabilities: { google: true }, inherited: on }), {}).google).toBe(true);
  });

  it('follows the draft: turning Google on in the draft makes it effective', () => {
    const view = makePolicyView({ capabilities: { google: true }, verifiedDomains: ['acme.example.com'] });
    expect(draftHasSsoMethod(view, {})).toBe(false);
    expect(draftHasSsoMethod(view, { googleEnabled: true })).toBe(true);
    expect(effectiveProviderSet(view, { googleEnabled: true })).toBe('google');
  });

  it('effective wording: both on → both; none effective → the capability wording', () => {
    const both = makePolicyView({
      capabilities: { entra: true, google: true },
      inherited: { entraEnabled: true, googleEnabled: true },
      entraTenantProven: true,
      verifiedDomains: ['acme.example.com'],
    });
    expect(effectiveProviderSet(both, {})).toBe('both');
    expect(effectiveProviderSet(both, { googleEnabled: false })).toBe('microsoft');
    expect(effectiveProviderSet(makePolicyView({ capabilities: { entra: true, google: true } }), {})).toBe('both');
    expect(effectiveProviderSet(makePolicyView({ capabilities: { entra: true } }), {})).toBe('microsoft');
  });

  it('the fixture keeps the verified-domain count and list consistent', () => {
    expect(makePolicyView({ verifiedDomains: ['a.example.com', 'b.example.com'] }).verifiedDomainCount).toBe(2);
    expect(makePolicyView({ verifiedDomainCount: 2 }).verifiedDomains).toHaveLength(2);
    expect(makePolicyView({ kind: 'partner' }).verifiedDomains).toBeNull();
  });
});
