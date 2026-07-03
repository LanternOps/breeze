import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SsoProviderList, { type SsoProvider } from './SsoProviderList';

function provider(overrides: Partial<SsoProvider>): SsoProvider {
  return {
    id: 'p-1',
    name: 'Okta',
    type: 'oidc',
    status: 'active',
    autoProvision: true,
    enforceSSO: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SsoProviderList partner badge', () => {
  it('renders a Partner badge for partner-wide providers', () => {
    render(<SsoProviderList providers={[provider({ id: 'a', name: 'Team Login', partnerId: 'pt-1' })]} />);
    expect(screen.getByTestId('sso-provider-partner-badge')).toBeTruthy();
  });

  it('does not render the badge for org-scoped providers', () => {
    render(<SsoProviderList providers={[provider({ id: 'b', name: 'Org Login', partnerId: null })]} />);
    expect(screen.queryByTestId('sso-provider-partner-badge')).toBeNull();
  });
});
