import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/lib/i18n';

const granted = vi.hoisted(() => new Set<string>());
const flags = vi.hoisted(() => ({ ENABLE_ENDPOINT_MESSAGING: true }));
vi.mock('@/lib/featureFlags', async (orig) => ({
  ...(await orig<typeof import('@/lib/featureFlags')>()),
  get ENABLE_ENDPOINT_MESSAGING() { return flags.ENABLE_ENDPOINT_MESSAGING; },
}));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => granted.has(`${r}:${a}`) }),
}));
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

  it('renders the billing address on its own line under the contact line', () => {
    renderHeader({
      org: {
        ...ORG,
        billingAddressLine1: '1 Main St',
        billingAddressLine2: 'Suite 200',
        billingAddressCity: 'Springfield',
        billingAddressRegion: 'IL',
        billingAddressPostalCode: '62701',
        billingAddressCountry: 'US',
      },
    });
    expect(screen.getByTestId('org-record-billing-address').textContent).toContain(
      '1 Main St, Suite 200 · Springfield, IL 62701 · US',
    );
    expect(screen.queryByTestId('org-record-billing-address-link')).toBeNull();
  });

  it('offers the billing settings tab when every address field is empty', () => {
    renderHeader();
    expect(screen.getByText('No billing address')).toBeTruthy();
    expect(screen.getByTestId('org-record-billing-address-link').getAttribute('href')).toBe(
      '/settings/organizations/org-1#billing',
    );
  });

  it('renders a partial address rather than the empty state', () => {
    renderHeader({ org: { ...ORG, billingAddressCountry: 'US' } });
    expect(screen.getByTestId('org-record-billing-address').textContent).toContain('US');
    expect(screen.queryByText('No billing address')).toBeNull();
  });

  it('shows the address even while the summary is still null', () => {
    renderHeader({ summary: null, org: { ...ORG, billingAddressCity: 'Austin' } });
    expect(screen.getByTestId('org-record-billing-address')).toBeTruthy();
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

describe('OrgRecordHeader - Send message is gated on endpoint_messages:send', () => {
  it('hides the button without the permission even when a handler is passed', () => {
    granted.clear();
    renderHeader({ onSendMessage: vi.fn() });
    expect(screen.queryByTestId('org-record-send-message')).toBeNull();
  });

  it('shows the button with the permission', () => {
    granted.clear();
    granted.add('endpoint_messages:send');
    renderHeader({ onSendMessage: vi.fn() });
    expect(screen.getByTestId('org-record-send-message')).toBeTruthy();
  });

  // #8968: the rollout flag cannot be switched on from any UI yet, so the
  // entry point stays hidden until the build enables endpoint messaging.
  it('hides the button when the build-time endpoint messaging flag is off', () => {
    flags.ENABLE_ENDPOINT_MESSAGING = false;
    try {
      granted.clear();
      granted.add('endpoint_messages:send');
      renderHeader({ onSendMessage: vi.fn() });
      expect(screen.queryByTestId('org-record-send-message')).toBeNull();
    } finally {
      flags.ENABLE_ENDPOINT_MESSAGING = true;
    }
  });

  describe('More menu keyboard handling (#9021)', () => {
    it('ArrowDown on the trigger opens the menu and focuses the first item', async () => {
      const user = userEvent.setup();
      renderHeader();
      screen.getByTestId('org-record-more').focus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByTestId('org-record-archive')).toHaveFocus();
    });

    it('click-open moves focus into the menu, arrows wrap, Home/End jump', async () => {
      const user = userEvent.setup();
      renderHeader();
      await user.click(screen.getByTestId('org-record-more'));
      expect(screen.getByTestId('org-record-archive')).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByTestId('org-record-merge')).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByTestId('org-record-archive')).toHaveFocus();
      await user.keyboard('{ArrowUp}');
      expect(screen.getByTestId('org-record-merge')).toHaveFocus();
      await user.keyboard('{Home}');
      expect(screen.getByTestId('org-record-archive')).toHaveFocus();
      await user.keyboard('{End}');
      expect(screen.getByTestId('org-record-merge')).toHaveFocus();
    });

    it('Escape closes the menu and returns focus to the trigger', async () => {
      const user = userEvent.setup();
      renderHeader();
      await user.click(screen.getByTestId('org-record-more'));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(screen.getByTestId('org-record-more')).toHaveFocus();
    });

    it('activating an item hands focus back to the trigger and fires the action', async () => {
      const user = userEvent.setup();
      const onArchive = vi.fn();
      renderHeader({ onArchive });
      await user.click(screen.getByTestId('org-record-more'));
      await user.keyboard('{Enter}');
      expect(onArchive).toHaveBeenCalled();
      expect(screen.getByTestId('org-record-more')).toHaveFocus();
    });

    it('Tab closes the menu', async () => {
      const user = userEvent.setup();
      renderHeader();
      await user.click(screen.getByTestId('org-record-more'));
      await user.keyboard('{Tab}');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('Escape with focus still on the trigger also closes', async () => {
      const user = userEvent.setup();
      renderHeader();
      const more = screen.getByTestId('org-record-more');
      await user.click(more);
      more.focus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});
