import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GoogleDomainsStatus } from './GoogleDomainsStatus';
import { makePolicyView } from './viewFixture';

describe('GoogleDomainsStatus (W7 #11384)', () => {
  it("the Google row lists the org's verified domains", () => {
    render(<GoogleDomainsStatus view={makePolicyView({ capabilities: { google: true }, verifiedDomains: ['a.example.com', 'b.example.com'] })} draft={{}} />);
    expect(screen.getByTestId('google-domains-status')).toHaveTextContent('Verified domains: a.example.com, b.example.com');
    expect(screen.queryByTestId('google-domains-none')).toBeNull();
  });

  it('the Google row says no verified domain and links to #domains', () => {
    render(<GoogleDomainsStatus view={makePolicyView({ capabilities: { google: true }, verifiedDomains: [] })} draft={{}} />);
    const none = screen.getByTestId('google-domains-none');
    expect(none).toHaveTextContent('No verified domain');
    expect(within(none).getByRole('link')).toHaveAttribute('href', '#domains');
    expect(screen.queryByTestId('google-domains-status')).toBeNull();
  });

  it('the partner view says the default applies wherever a domain is verified, while Google is on', () => {
    const view = makePolicyView({ kind: 'partner', capabilities: { google: true } });
    const { unmount } = render(<GoogleDomainsStatus view={view} draft={{ googleEnabled: true }} />);
    expect(screen.getByTestId('google-domains-partner')).toHaveTextContent('On wherever a domain is verified');
    expect(screen.queryByTestId('google-domains-none')).toBeNull();
    unmount();
    // Off: nothing to qualify.
    render(<GoogleDomainsStatus view={view} draft={{}} />);
    expect(screen.queryByTestId('google-domains-partner')).toBeNull();
  });

  it('renders nothing while the deployment cannot run Google sign-in', () => {
    const { container } = render(
      <GoogleDomainsStatus view={makePolicyView({ verifiedDomains: ['a.example.com'] })} draft={{}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
