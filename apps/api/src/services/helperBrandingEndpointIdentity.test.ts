import { describe, expect, it } from 'vitest';
import { buildBrandingDecision, brandingScopeId } from './helperBranding';
import { endpointMessageIdentity } from './helperBrandingEndpointIdentity';

const FALLBACK = { companyName: 'Acme IT', displayName: 'Acme IT', accent: '#12AB34' };
const SCOPE = brandingScopeId('partner-1', 'org-1');

describe('endpointMessageIdentity', () => {
  it('keeps the partner fallback when there is no decision', () => {
    expect(endpointMessageIdentity(undefined, FALLBACK)).toEqual(FALLBACK);
  });

  it('keeps the partner fallback when branding is cleared', () => {
    expect(endpointMessageIdentity({ state: 'cleared' }, FALLBACK)).toEqual(FALLBACK);
  });

  it('uses the Helper branding identity and accent when set', () => {
    const decision = buildBrandingDecision(
      { companyName: 'Example MSP', displayName: 'Example Assist', primaryColor: '#2255AA' },
      SCOPE,
    );
    expect(endpointMessageIdentity(decision, FALLBACK)).toEqual({
      companyName: 'Example MSP',
      displayName: 'Example Assist',
      accent: '#2255AA',
    });
  });

  it('falls back field by field for absent values inside a set decision', () => {
    const decision = buildBrandingDecision({ displayName: 'Example Assist' }, SCOPE);
    expect(endpointMessageIdentity(decision, FALLBACK)).toEqual({
      companyName: 'Acme IT',
      displayName: 'Example Assist',
      accent: '#12AB34',
    });
  });
});
