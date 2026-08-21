import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContextCard } from './ContextCard';
import * as api from './api';
import type { ContactCandidate } from './api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const contactA: ContactCandidate = {
  kind: 'contact',
  id: 'c-1',
  name: 'Alice',
  email: 'alice@acme.com',
  orgId: 'org-1',
  provenance: 'address_match',
};
const contactB: ContactCandidate = {
  kind: 'portal_user',
  id: 'c-2',
  name: 'Bob',
  email: 'bob@acme.com',
  orgId: 'org-1',
  provenance: 'address_match',
};

function baseProps(overrides: Partial<ComponentProps<typeof ContextCard>> = {}) {
  return {
    org: { id: 'org-1', name: 'Acme' },
    orgSummary: null,
    contacts: [],
    headerCapable: true,
    inboundPathConfigured: true,
    onOrgSelected: vi.fn(),
    ...overrides,
  };
}

describe('ContextCard', () => {
  it('renders the resolved org', () => {
    render(<ContextCard {...baseProps()} />);
    expect(screen.getByTestId('context-card-org').textContent).toContain('Acme');
    expect(screen.queryByTestId('org-search-input')).toBeNull();
  });

  it('shows a "no match" state with an org-search typeahead when org is null', async () => {
    vi.spyOn(api, 'searchOrgs').mockResolvedValue({ orgs: [{ id: 'org-9', name: 'Contoso' }] });
    const onOrgSelected = vi.fn();
    render(<ContextCard {...baseProps({ org: null, onOrgSelected })} />);
    expect(screen.getByTestId('context-card-no-match')).toBeTruthy();
    const input = screen.getByTestId('org-search-input');
    fireEvent.change(input, { target: { value: 'cont' } });

    await waitFor(() => expect(screen.getByTestId('org-search-result-org-9')).toBeTruthy());
    expect(api.searchOrgs).toHaveBeenCalledWith('cont');

    fireEvent.click(screen.getByTestId('org-search-result-org-9'));
    expect(onOrgSelected).toHaveBeenCalledWith({ id: 'org-9', name: 'Contoso' });
  });

  it('never renders a contact picker for 0 or 1 candidates', () => {
    render(<ContextCard {...baseProps({ contacts: [contactA] })} />);
    expect(screen.queryByTestId('contact-candidate')).toBeNull();
  });

  it('renders a contact-candidate picker for >1 candidates and never auto-picks', () => {
    const onContactSelected = vi.fn();
    render(<ContextCard {...baseProps({ contacts: [contactA, contactB], onContactSelected })} />);
    const rows = screen.getAllByTestId('contact-candidate');
    expect(rows).toHaveLength(2);
    expect(onContactSelected).not.toHaveBeenCalled();
    fireEvent.click(rows[0]!);
    expect(onContactSelected).toHaveBeenCalledWith(contactA);
  });

  it('shows the header-degrade notice when headerCapable is false', () => {
    render(<ContextCard {...baseProps({ headerCapable: false })} />);
    expect(screen.getByTestId('tech-header-degrade-notice').textContent).toContain(
      'Thread matching limited on this Outlook version',
    );
  });

  it('does not show the header-degrade notice when headerCapable is true', () => {
    render(<ContextCard {...baseProps({ headerCapable: true })} />);
    expect(screen.queryByTestId('tech-header-degrade-notice')).toBeNull();
  });

  it('shows the inbound-path honesty banner when inboundPathConfigured is false', () => {
    render(<ContextCard {...baseProps({ inboundPathConfigured: false })} />);
    expect(screen.getByTestId('tech-inbound-path-notice').textContent).toContain(
      "won't auto-attach",
    );
  });

  it('does not show the inbound-path banner when inboundPathConfigured is true', () => {
    render(<ContextCard {...baseProps({ inboundPathConfigured: true })} />);
    expect(screen.queryByTestId('tech-inbound-path-notice')).toBeNull();
  });

  it('both banners can render together', () => {
    render(<ContextCard {...baseProps({ headerCapable: false, inboundPathConfigured: false })} />);
    expect(screen.getByTestId('tech-header-degrade-notice')).toBeTruthy();
    expect(screen.getByTestId('tech-inbound-path-notice')).toBeTruthy();
  });
});
