import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/lib/i18n';
import OrgRecordHeader from './OrgRecordHeader';
import type { OrgRecordOrg, OrgSummary } from './orgRecordFetch';

const ORG: OrgRecordOrg = {
  id: 'org-1',
  name: 'Acme Dental',
  status: 'active',
  type: 'customer',
  createdAt: '2026-01-05T00:00:00.000Z',
};

const SUMMARY: OrgSummary = {
  orgId: 'org-1',
  sites: { count: 3 },
  contacts: { count: 2, primary: { id: 'c1', name: 'Dana Reed', email: 'dana@acme.test', phone: null } },
  lastActivityAt: null,
};

function renderHeader(props: Partial<React.ComponentProps<typeof OrgRecordHeader>> = {}) {
  return render(
    <OrgRecordHeader
      org={ORG}
      summary={SUMMARY}
      archived={false}
      mismatchedScopeOrgName={null}
      onWorkHere={vi.fn()}
      onOpenSettings={vi.fn()}
      onArchive={vi.fn()}
      onMerge={vi.fn()}
      {...props}
    />,
  );
}

describe('OrgRecordHeader', () => {
  it('always states the status, including "active" (unlike the exception-only list pill)', () => {
    renderHeader();
    expect(screen.getByTestId('org-record-status').textContent).toBe('Active');
  });

  it('renders a status the client does not know about rather than an empty pill', () => {
    // A newly added server-side status must not blank the pill — the operator
    // seeing a raw token still learns more than seeing nothing.
    renderHeader({ org: { ...ORG, status: 'quarantined' } });
    expect(screen.getByTestId('org-record-status').textContent).toBe('quarantined');
  });

  it('shows the primary contact when the summary carries one', () => {
    renderHeader();
    const contact = screen.getByTestId('org-record-primary-contact');
    expect(contact.textContent).toContain('Dana Reed');
    expect(screen.getByRole('link', { name: /dana@acme.test/ }).getAttribute('href')).toBe('mailto:dana@acme.test');
  });

  it('says so explicitly when a loaded summary has no primary contact', () => {
    renderHeader({ summary: { ...SUMMARY, contacts: { count: 0, primary: null } } });
    expect(screen.queryByTestId('org-record-primary-contact')).toBeNull();
    expect(screen.getByText('No primary contact')).toBeTruthy();
  });

  it('stays quiet about contacts while the summary is still null', () => {
    renderHeader({ summary: null });
    expect(screen.queryByTestId('org-record-primary-contact')).toBeNull();
    expect(screen.queryByText('No primary contact')).toBeNull();
  });

  it('drops every write affordance when the org is archived', () => {
    renderHeader({ archived: true });
    expect(screen.queryByTestId('org-record-work-here')).toBeNull();
    expect(screen.queryByTestId('org-record-more')).toBeNull();
    // Settings stays: the archived org's settings page is itself read-only.
    expect(screen.getByTestId('org-record-settings')).toBeTruthy();
  });

  it('hides the overflow menu entirely when neither lifecycle action is offered', () => {
    renderHeader({ onArchive: undefined, onMerge: undefined });
    expect(screen.queryByTestId('org-record-more')).toBeNull();
  });

  it('offers only Archive when Merge is withheld (system-scope sessions)', async () => {
    const user = userEvent.setup();
    renderHeader({ onMerge: undefined });
    await user.click(screen.getByTestId('org-record-more'));
    expect(screen.getByTestId('org-record-archive')).toBeTruthy();
    expect(screen.queryByTestId('org-record-merge')).toBeNull();
  });

  it('names the other workspace in the scope chip, and shows nothing when scopes agree', () => {
    const { unmount } = renderHeader({ mismatchedScopeOrgName: 'Beta Legal' });
    expect(screen.getByTestId('org-record-scope-chip').textContent).toContain('Beta Legal');
    unmount();
    renderHeader({ mismatchedScopeOrgName: null });
    expect(screen.queryByTestId('org-record-scope-chip')).toBeNull();
  });
});
