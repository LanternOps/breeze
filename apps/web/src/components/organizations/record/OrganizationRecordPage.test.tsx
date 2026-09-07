import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/lib/i18n';
import OrganizationRecordPage from './OrganizationRecordPage';
import { registerOrgIdProvider, useAuthStore, type Permission } from '@/stores/auth';
import { useOrgStore, type Organization } from '@/stores/orgStore';

const RECORD_ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';

const applyOrgSwitchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orgSwitch', () => ({
  applyOrgSwitch: applyOrgSwitchMock,
  getOrgSwitchRedirect: () => null,
  stashSwitchToast: () => undefined,
  consumeSwitchToast: () => null,
}));

const navigateToMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

// A partner JWT: `{"scope":"partner","orgId":null,"partnerId":"p1"}`.
const PARTNER_TOKEN = `h.${btoa(JSON.stringify({ scope: 'partner', partnerId: 'p1' }))}.s`;
const ORG_TOKEN = `h.${btoa(JSON.stringify({ scope: 'organization', orgId: RECORD_ORG }))}.s`;

const ADMIN_PERMISSIONS = [{ resource: '*', action: '*' }] as Permission[];

function seedAuth(token: string, permissions: Permission[] = ADMIN_PERMISSIONS) {
  useAuthStore.setState({
    tokens: { accessToken: token, expiresAt: Date.now() + 60_000 } as never,
    user: { id: 'u1', email: 'u@example.com', permissions } as never,
    isAuthenticated: true,
  });
}

/** The switcher parked on ANOTHER org — the condition the record must survive. */
function seedStore(orgs: Partial<Organization>[], currentOrgId: string | null) {
  useOrgStore.setState({
    currentOrgId,
    allOrgs: currentOrgId === null,
    organizationsLoaded: true,
    organizations: orgs.map((o) => ({
      id: o.id ?? RECORD_ORG,
      partnerId: 'p1',
      name: o.name ?? 'Acme',
      status: (o.status ?? 'active') as Organization['status'],
      createdAt: o.createdAt ?? '2026-01-05T00:00:00.000Z',
    })),
  } as never);
}

const ORG_BODY = {
  id: RECORD_ORG,
  name: 'Acme Dental',
  status: 'active',
  type: 'customer',
  createdAt: '2026-01-05T00:00:00.000Z',
};

const SUMMARY_BODY = {
  orgId: RECORD_ORG,
  devices: { total: 12, online: 9, offline: 3 },
  alerts: { open: 4, critical: 1, high: 2 },
  sites: { count: 2 },
  contacts: {
    count: 3,
    primary: { id: 'c1', name: 'Dana Reed', email: 'dana@acme.test', phone: null },
  },
  lastActivityAt: '2026-09-05T10:00:00.000Z',
};

let fetchSpy: ReturnType<typeof vi.spyOn>;
const requestedUrls: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes by path suffix so the assertion on the URL's org stays meaningful. */
function routeFetch(handlers: Record<string, () => Response>) {
  fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    for (const [fragment, make] of Object.entries(handlers)) {
      if (url.includes(fragment)) return make();
    }
    return json({ data: [] });
  });
}

beforeEach(() => {
  requestedUrls.length = 0;
  applyOrgSwitchMock.mockReset();
  navigateToMock.mockReset();
  window.location.hash = '';
  registerOrgIdProvider(() => useOrgStore.getState().currentOrgId);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  seedAuth(PARTNER_TOKEN);
  seedStore([{ id: RECORD_ORG, name: 'Acme Dental' }, { id: OTHER_ORG, name: 'Beta Legal' }], OTHER_ORG);
});

afterEach(() => {
  vi.restoreAllMocks();
  registerOrgIdProvider(() => null);
  window.location.hash = '';
});

describe('OrganizationRecordPage — happy path', () => {
  beforeEach(() => {
    routeFetch({
      '/summary': () => json(SUMMARY_BODY),
      [`/orgs/organizations/${RECORD_ORG}`]: () => json(ORG_BODY),
    });
  });

  it('renders the header from the record org, not the org the switcher points at', async () => {
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-header')).toBeTruthy());
    expect(screen.getByTestId('org-record-header').textContent).toContain('Acme Dental');
    expect(screen.getByTestId('org-record-status')).toBeTruthy();
  });

  it('pins EVERY request to the record org while the store points at another org', async () => {
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-overview-tab')).toBeTruthy());
    await waitFor(() => expect(requestedUrls.length).toBeGreaterThanOrEqual(4));

    expect(useOrgStore.getState().currentOrgId).toBe(OTHER_ORG);
    for (const url of requestedUrls) {
      expect(url, `request leaked the switcher org: ${url}`).not.toContain(OTHER_ORG);
    }
    // The two feed reads are the ones ambient injection would have widened.
    const feeds = requestedUrls.filter((u) => u.includes('/audit-logs') || u.includes('/alerts'));
    expect(feeds.length).toBeGreaterThanOrEqual(2);
    for (const url of feeds) expect(url).toContain(`orgId=${RECORD_ORG}`);
  });

  it('names the mismatched workspace in a chip so the two org names cannot be confused', async () => {
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-scope-chip')).toBeTruthy());
    expect(screen.getByTestId('org-record-scope-chip').textContent).toContain('Beta Legal');
  });

  it('shows no scope chip when the switcher already points at this org', async () => {
    seedStore([{ id: RECORD_ORG, name: 'Acme Dental' }], RECORD_ORG);
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-header')).toBeTruthy());
    expect(screen.queryByTestId('org-record-scope-chip')).toBeNull();
  });

  it('renders overview tiles only for the summary sections the caller can read', async () => {
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-overview-tile-devices')).toBeTruthy());
    expect(screen.getByTestId('org-overview-tile-alerts')).toBeTruthy();
    // The summary omitted tickets/invoices — a 0 tile there would be a lie.
    expect(screen.queryByTestId('org-overview-tile-tickets')).toBeNull();
    expect(screen.queryByTestId('org-overview-tile-invoices')).toBeNull();
  });

  it('opens the tab named in the URL hash — an unimplemented tab shows the placeholder', async () => {
    window.location.hash = '#activity';
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-tab-placeholder-activity')).toBeTruthy());
    expect(screen.queryByTestId('org-overview-tab')).toBeNull();
  });

  it('opens the Tickets tab named in the URL hash, pinned to the record org', async () => {
    window.location.hash = '#tickets';
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-tickets-tab')).toBeTruthy());
    expect(screen.queryByTestId('org-overview-tab')).toBeNull();
    expect(screen.queryByTestId('org-record-tab-placeholder-tickets')).toBeNull();
    await waitFor(() => expect(requestedUrls.some((u) => u.includes('/tickets?') && u.includes(`orgId=${RECORD_ORG}`))).toBe(true));
  });

  it('opens the Contracts & Billing tab named in the URL hash', async () => {
    window.location.hash = '#billing';
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-billing-tab')).toBeTruthy());
    expect(screen.queryByTestId('org-overview-tab')).toBeNull();
    expect(screen.queryByTestId('org-record-tab-placeholder-billing')).toBeNull();
  });

  it('#contacts renders ContactsCard scoped to the record org', async () => {
    window.location.hash = '#contacts';
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-contacts-card')).toBeTruthy());
    await waitFor(() => expect(requestedUrls.some((u) => u.includes(`/orgs/organizations/${RECORD_ORG}/contacts`))).toBe(true));
  });

  it('#sites renders OrgSitesTab, pinned to the record org via orgIdOverride', async () => {
    window.location.hash = '#sites';
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-sites-tab')).toBeTruthy());
    await waitFor(() => expect(requestedUrls.some((u) => u.includes(`orgId=${RECORD_ORG}`) && u.includes('/orgs/sites'))).toBe(true));
    // No request in this tab ever carries the switcher's org.
    for (const url of requestedUrls) expect(url).not.toContain(OTHER_ORG);
  });

  it('#devices renders OrgDevicesTab, pinned to the record org', async () => {
    window.location.hash = '#devices';
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-devices-tab')).toBeTruthy());
    await waitFor(() => expect(requestedUrls.some((u) => u.includes('/devices') && u.includes(`orgId=${RECORD_ORG}`))).toBe(true));
    for (const url of requestedUrls) expect(url).not.toContain(OTHER_ORG);
  });

  it('#activity renders OrgActivityTab, pinned to the record org', async () => {
    window.location.hash = '#activity';
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-activity-tab')).toBeTruthy());
    await waitFor(() =>
      expect(requestedUrls.some((u) => u.includes('/audit-logs') && u.includes(`orgId=${RECORD_ORG}`))).toBe(true),
    );
    for (const url of requestedUrls) expect(url).not.toContain(OTHER_ORG);
  });

  it('switches the context and lands on the dashboard from Work in this org', async () => {
    const user = userEvent.setup();
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-work-here')).toBeTruthy());
    await user.click(screen.getByTestId('org-record-work-here'));
    expect(applyOrgSwitchMock).toHaveBeenCalledWith(RECORD_ORG, expect.stringContaining('Acme Dental'), '/');
  });
});

describe('OrganizationRecordPage — lifecycle states', () => {
  it('refuses the page for an org-scoped sign-in instead of firing a request that 403s', async () => {
    seedAuth(ORG_TOKEN);
    routeFetch({});
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-unavailable')).toBeTruthy());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names a suspended org from the cached list row when its record 404s', async () => {
    seedStore(
      [{ id: RECORD_ORG, name: 'Acme Dental', status: 'suspended' }, { id: OTHER_ORG, name: 'Beta Legal' }],
      OTHER_ORG,
    );
    routeFetch({ [`/orgs/organizations/${RECORD_ORG}`]: () => json({ error: 'Organization not found' }, 404) });
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-lifecycle')).toBeTruthy());
    expect(screen.getByTestId('org-record-lifecycle').textContent).toContain('Acme Dental');
    expect(screen.queryByTestId('org-record-not-found')).toBeNull();
  });

  it('falls back to not-found when a 404 has no matching lifecycle row', async () => {
    seedStore([{ id: OTHER_ORG, name: 'Beta Legal' }], OTHER_ORG);
    routeFetch({ [`/orgs/organizations/${RECORD_ORG}`]: () => json({ error: 'Organization not found' }, 404) });
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-not-found')).toBeTruthy());
  });

  it('renders an archived org read-only: banner, no Work in this org, no lifecycle menu', async () => {
    routeFetch({
      '/summary': () => json(SUMMARY_BODY),
      [`/orgs/organizations/${RECORD_ORG}`]: () => json({ ...ORG_BODY, status: 'archived', archived: true }),
    });
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-archived-banner')).toBeTruthy());
    expect(screen.queryByTestId('org-record-work-here')).toBeNull();
    expect(screen.queryByTestId('org-record-more')).toBeNull();
    expect(screen.getByTestId('org-record-restore')).toBeTruthy();
  });

  it('surfaces a retryable error card when the record GET fails outright', async () => {
    routeFetch({ [`/orgs/organizations/${RECORD_ORG}`]: () => json({ error: 'boom' }, 500) });
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-error')).toBeTruthy());
  });

  it('still renders the record when only the summary fails — the tiles go, the page does not', async () => {
    routeFetch({
      '/summary': () => json({ error: 'nope' }, 500),
      [`/orgs/organizations/${RECORD_ORG}`]: () => json(ORG_BODY),
    });
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-overview-summary-error')).toBeTruthy());
    expect(screen.getByTestId('org-record-header')).toBeTruthy();
    expect(screen.queryByTestId('org-overview-tile-devices')).toBeNull();
  });
});

describe('OrganizationRecordPage — permission gating', () => {
  it('hides the Devices tab from a user without devices:read', async () => {
    seedAuth(PARTNER_TOKEN, [{ resource: 'organizations', action: 'read' }] as Permission[]);
    routeFetch({
      '/summary': () => json(SUMMARY_BODY),
      [`/orgs/organizations/${RECORD_ORG}`]: () => json(ORG_BODY),
    });
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-record-header')).toBeTruthy());
    // OverflowTabs renders each tab as role="tab" inside a tablist (#5090),
    // so the tab's accessible role is "tab", not "button". Querying for a
    // "button" found nothing either way, which silently made the negative
    // assertion below vacuous as well as breaking the positive one.
    expect(screen.queryByRole('tab', { name: 'Devices' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeTruthy();
  });

  it('falls back to Overview when the hash names a tab this user cannot see', async () => {
    window.location.hash = '#devices';
    seedAuth(PARTNER_TOKEN, [{ resource: 'organizations', action: 'read' }] as Permission[]);
    routeFetch({
      '/summary': () => json(SUMMARY_BODY),
      [`/orgs/organizations/${RECORD_ORG}`]: () => json(ORG_BODY),
    });
    render(<OrganizationRecordPage orgId={RECORD_ORG} />);
    await waitFor(() => expect(screen.getByTestId('org-overview-tab')).toBeTruthy());
    expect(screen.queryByTestId('org-record-tab-placeholder-devices')).toBeNull();
  });
});
