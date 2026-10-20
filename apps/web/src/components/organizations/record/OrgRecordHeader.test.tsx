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

  it('says so explicitly when a loaded summary has no primary contact, with a way to add one', () => {
    renderHeader({ summary: { ...SUMMARY, contacts: { count: 0, primary: null } } });
    expect(screen.queryByTestId('org-record-primary-contact')).toBeNull();
    // #9024: symmetric with "No billing address · Add in Billing settings".
    const empty = screen.getByTestId('org-record-no-primary-contact');
    expect(empty.textContent).toBe('No primary contact · Add contact');
    expect(screen.getByTestId('org-record-primary-contact-link').getAttribute('href')).toBe('#contacts');
  });

  it('shows the site-level primary instead of "No primary contact" (#9317)', () => {
    const sp = (id: string, name: string, siteName: string) => ({
      id, name, email: `${id}@acme.test`, phone: null, siteId: `s-${id}`, siteName,
    });
    renderHeader({
      summary: { ...SUMMARY, contacts: { count: 2, primary: null, sitePrimaries: [sp('a', 'Sam Site', 'HQ'), sp('b', 'Pat Branch', 'Annex')] } },
    });
    const el = screen.getByTestId('org-record-site-primary-contact');
    expect(el.textContent).toContain('Sam Site');
    expect(el.textContent).toContain('HQ');
    expect(el.textContent).toContain('+1 more');
    expect(el.textContent).toContain('No org-level primary contact');
    expect(screen.queryByText('No primary contact')).toBeNull();
    expect(screen.queryByTestId('org-record-no-primary-contact')).toBeNull();
    expect(screen.getByTestId('org-record-primary-contact-link').getAttribute('href')).toBe('#contacts');
  });

  it('single site primary: phone link, no "+N more", and the org primary wins when both exist (#9317)', () => {
    const one = { id: 'a', name: 'Sam Site', email: 'sam@acme.test', phone: '555-0100', siteId: 's-a', siteName: 'HQ' };
    renderHeader({ summary: { ...SUMMARY, contacts: { count: 1, primary: null, sitePrimaries: [one] } } });
    const el = screen.getByTestId('org-record-site-primary-contact');
    expect(el.textContent).not.toContain('more');
    expect(screen.getByRole('link', { name: /555-0100/ }).getAttribute('href')).toBe('tel:555-0100');
    expect(screen.getByRole('link', { name: /sam@acme.test/ }).getAttribute('href')).toBe('mailto:sam@acme.test');
  });

  it('org primary takes precedence over site primaries; empty sitePrimaries falls back to the empty state (#9317)', () => {
    const one = { id: 'a', name: 'Sam Site', email: null, phone: null, siteId: 's-a', siteName: 'HQ' };
    const { unmount } = renderHeader({
      summary: { ...SUMMARY, contacts: { count: 2, primary: SUMMARY.contacts!.primary, sitePrimaries: [one] } },
    });
    expect(screen.getByTestId('org-record-primary-contact')).toBeTruthy();
    expect(screen.queryByTestId('org-record-site-primary-contact')).toBeNull();
    unmount();
    renderHeader({ summary: { ...SUMMARY, contacts: { count: 0, primary: null, sitePrimaries: [] } } });
    expect(screen.getByTestId('org-record-no-primary-contact')).toBeTruthy();
    expect(screen.queryByTestId('org-record-site-primary-contact')).toBeNull();
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

  it('drops the country when it matches the partner\'s own, and keeps it otherwise (#9024)', () => {
    const org = { ...ORG, billingAddressCity: 'Springfield', billingAddressRegion: 'IL', billingAddressCountry: 'US' };
    const { unmount } = renderHeader({ org, partnerCountry: 'US' });
    expect(screen.getByTestId('org-record-billing-address').textContent).toContain('Springfield, IL');
    expect(screen.getByTestId('org-record-billing-address').textContent).not.toContain('US');
    unmount();
    renderHeader({ org, partnerCountry: 'CA' });
    expect(screen.getByTestId('org-record-billing-address').textContent).toContain('Springfield, IL · US');
  });

  it('offers the billing settings tab when every address field is empty', () => {
    renderHeader();
    expect(screen.getByTestId('org-record-no-billing-address').textContent).toBe(
      'No billing address · Add in Billing settings',
    );
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

  it('states the mismatch as a visible line naming both orgs, and shows nothing when scopes agree', () => {
    const { unmount } = renderHeader({ mismatchedScopeOrgName: 'Beta Legal' });
    const line = screen.getByTestId('org-record-scope-chip');
    expect(line.textContent).toBe('Working in Beta Legal · this record is Acme Dental');
    // No tooltip-only meaning: the text is on the page, and the action it
    // explains points at it for screen readers.
    expect(line.getAttribute('title')).toBeNull();
    expect(screen.getByTestId('org-record-work-here').getAttribute('aria-describedby')).toBe(line.id);
    unmount();
    renderHeader({ mismatchedScopeOrgName: null });
    expect(screen.queryByTestId('org-record-scope-chip')).toBeNull();
  });

  // #9019: the filled button used to render identically whether or not the
  // working org already was this one.
  it('shows a quiet "Working here" state instead of the button when the working org is this one', () => {
    renderHeader({ workingHere: true });
    const pill = screen.getByTestId('org-record-working-here');
    expect(pill.textContent).toBe('Working here');
    expect(pill.tagName).not.toBe('BUTTON');
    expect(pill.getAttribute('aria-label')).toBe('Working in Acme Dental');
    expect(screen.queryByTestId('org-record-work-here')).toBeNull();
    expect(screen.queryByTestId('org-record-scope-chip')).toBeNull();
  });

  it('offers "Work in this org" when the working org differs', async () => {
    const user = userEvent.setup();
    const onWorkHere = vi.fn();
    renderHeader({ workingHere: false, onWorkHere });
    expect(screen.queryByTestId('org-record-working-here')).toBeNull();
    await user.click(screen.getByTestId('org-record-work-here'));
    expect(onWorkHere).toHaveBeenCalledTimes(1);
  });

  it('gives every header action the same h-9 height', () => {
    granted.add('endpoint_messages:send');
    renderHeader({ onSendMessage: vi.fn() });
    for (const id of ['org-record-work-here', 'org-record-send-message', 'org-record-settings', 'org-record-more']) {
      expect(screen.getByTestId(id).className, id).toMatch(/\bh-9\b/);
    }
    granted.clear();
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
