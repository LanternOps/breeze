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

  it('never takes the sender name from Helper branding; only the accent follows it (#9396)', () => {
    const decision = buildBrandingDecision(
      { companyName: 'Microsoft Security', displayName: 'Microsoft Security', primaryColor: '#2255AA' },
      SCOPE,
    );
    expect(endpointMessageIdentity(decision, FALLBACK)).toEqual({
      companyName: 'Acme IT',
      displayName: 'Acme IT',
      accent: '#2255AA',
    });
  });

  it('keeps the partner accent when a set decision has no primary colour', () => {
    const decision = buildBrandingDecision({ displayName: 'Example Assist' }, SCOPE);
    expect(endpointMessageIdentity(decision, FALLBACK)).toEqual(FALLBACK);
  });
});
