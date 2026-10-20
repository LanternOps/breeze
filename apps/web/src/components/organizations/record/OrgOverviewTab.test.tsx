import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/lib/i18n';
import OrgOverviewTab from './OrgOverviewTab';
import type { OrgFetch, OrgSummary } from './orgRecordFetch';
import type { ServiceManagementMode } from './orgRecordTabs';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const ORG_ID = 'org-record-1';

const BASE_SUMMARY: OrgSummary = {
  orgId: ORG_ID,
  sites: { count: 2 },
  lastActivityAt: null,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes by path fragment so each feed can succeed or fail independently. */
function fetchFor(handlers: { activity?: () => Response | Promise<Response>; alerts?: () => Response | Promise<Response> }): OrgFetch {
  return vi.fn(async (path: string) => {
    if (path.includes('/audit-logs')) return (handlers.activity ?? (() => json({ logs: [] })))();
    if (path.includes('/alerts')) return (handlers.alerts ?? (() => json({ data: [] })))();
    return json({});
  }) as unknown as OrgFetch;
}

function renderTab(
  summary: OrgSummary | null,
  orgFetch: OrgFetch,
  summaryFailed = false,
  mode?: ServiceManagementMode,
) {
  return render(
    <OrgOverviewTab orgId={ORG_ID} orgFetch={orgFetch} summary={summary} summaryFailed={summaryFailed} mode={mode} />,
  );
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OrgOverviewTab — fleet strip (#9020)', () => {
  it('renders the fleet strip as the first thing on the tab, ahead of the account row and feeds', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        devices: { total: 10, online: 7, offline: 3 },
        contacts: { count: 4, primary: null },
      },
      fetchFor({}),
    );
    const fleet = await screen.findByTestId('org-overview-fleet');
    const account = screen.getByTestId('org-overview-account');
    const alertsFeed = screen.getByTestId('org-overview-critical-alerts');
    // DOCUMENT_POSITION_FOLLOWING: the argument node comes after the receiver.
    expect(fleet.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(account.compareDocumentPosition(alertsFeed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(fleet).getByTestId('org-overview-stat-devices')).toBeTruthy();
  });

  it('shows online / offline / total once each — the devices number is not repeated', async () => {
    renderTab({ ...BASE_SUMMARY, devices: { total: 10, online: 7, offline: 3 } }, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-devices');
    expect(within(stat).getByTestId('org-overview-stat-devices-online').textContent).toContain('7');
    expect(within(stat).getByTestId('org-overview-stat-devices-offline').textContent).toContain('3');
    expect(within(stat).getByTestId('org-overview-stat-devices-total').textContent).toContain('10');
    // The total appears exactly once — not as a headline AND inside a sub-line.
    expect(stat.textContent?.match(/10/g)?.length).toBe(1);
  });

  it('reads "All online" — not a big 0 offline — when nothing is offline', async () => {
    renderTab({ ...BASE_SUMMARY, devices: { total: 4, online: 4, offline: 0 } }, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-devices');
    expect(stat.textContent).toContain('All online');
    expect(within(stat).queryByTestId('org-overview-stat-devices-offline')).toBeNull();
  });

  it('reads "No devices" for an org with no enrolled devices', async () => {
    renderTab({ ...BASE_SUMMARY, devices: { total: 0, online: 0, offline: 0 } }, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-devices');
    expect(stat.textContent).toContain('No devices');
    expect(stat.textContent).not.toMatch(/\d/);
  });

  it('breaks open alerts down by severity, colouring only the non-zero severe counts', async () => {
    renderTab({ ...BASE_SUMMARY, alerts: { open: 5, critical: 2, high: 1 } }, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-alerts');
    const critical = within(stat).getByTestId('org-overview-stat-alerts-critical');
    const high = within(stat).getByTestId('org-overview-stat-alerts-high');
    const other = within(stat).getByTestId('org-overview-stat-alerts-other');
    expect(critical.textContent).toContain('2');
    expect(high.textContent).toContain('1');
    // Other = open − critical − high.
    expect(other.textContent).toContain('2');
    expect(critical.querySelector('.text-destructive')).toBeTruthy();
    expect(high.querySelector('.text-warning-strong')).toBeTruthy();
    expect(other.querySelector('.text-destructive, .text-warning-strong')).toBeNull();
  });

  it('omits a zero severity rather than printing a big 0', async () => {
    renderTab({ ...BASE_SUMMARY, alerts: { open: 3, critical: 0, high: 0 } }, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-alerts');
    expect(within(stat).queryByTestId('org-overview-stat-alerts-critical')).toBeNull();
    expect(within(stat).queryByTestId('org-overview-stat-alerts-high')).toBeNull();
    expect(within(stat).getByTestId('org-overview-stat-alerts-other').textContent).toContain('3');
  });

  it('reads "No open alerts" and "No open tickets" in muted text for a quiet org', async () => {
    renderTab(
      { ...BASE_SUMMARY, alerts: { open: 0, critical: 0, high: 0 }, tickets: { open: 0, awaitingCustomer: 0 } },
      fetchFor({}),
    );
    const alertsStat = await screen.findByTestId('org-overview-stat-alerts');
    const ticketsStat = screen.getByTestId('org-overview-stat-tickets');
    expect(alertsStat.textContent).toContain('No open alerts');
    expect(ticketsStat.textContent).toContain('No open tickets');
    expect(alertsStat.textContent).not.toMatch(/\d/);
    expect(ticketsStat.textContent).not.toMatch(/\d/);
    expect(alertsStat.querySelector('.text-destructive, .text-warning-strong')).toBeNull();
  });

  it('shows open tickets with the awaiting-customer count', async () => {
    renderTab({ ...BASE_SUMMARY, tickets: { open: 3, awaitingCustomer: 1 } }, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-tickets');
    expect(within(stat).getByTestId('org-overview-stat-tickets-open').textContent).toContain('3');
    expect(within(stat).getByTestId('org-overview-stat-tickets-awaiting').textContent).toContain('1');
  });

  it('links every fleet stat to where its detail lives', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        devices: { total: 10, online: 7, offline: 3 },
        alerts: { open: 5, critical: 2, high: 1 },
        tickets: { open: 3, awaitingCustomer: 1 },
      },
      fetchFor({}),
    );
    const devices = await screen.findByTestId('org-overview-stat-devices');
    expect(devices.tagName).toBe('A');
    expect(devices).toHaveAttribute('href', '#devices');
    expect(screen.getByTestId('org-overview-stat-tickets')).toHaveAttribute('href', '#tickets');
    // Alerts have no record tab; /alerts honours ?orgId= by switching the
    // working org to this one (#9108), so the stat links there.
    const alertsStat = screen.getByTestId('org-overview-stat-alerts');
    expect(alertsStat.tagName).toBe('A');
    expect(alertsStat).toHaveAttribute('href', `/alerts?orgId=${ORG_ID}`);
  });

  it('omits the Online metric — no big 0 — when every device is offline', async () => {
    renderTab({ ...BASE_SUMMARY, devices: { total: 5, online: 0, offline: 5 } }, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-devices');
    expect(within(stat).queryByTestId('org-overview-stat-devices-online')).toBeNull();
    expect(within(stat).getByTestId('org-overview-stat-devices-offline').textContent).toContain('5');
    expect(within(stat).getByTestId('org-overview-stat-devices-total').textContent).toContain('5');
    expect(stat.textContent).not.toContain('All online');
  });

  it('shows only the awaiting-customer count when no ticket is open on our side', async () => {
    renderTab({ ...BASE_SUMMARY, tickets: { open: 0, awaitingCustomer: 2 } }, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-tickets');
    expect(within(stat).queryByTestId('org-overview-stat-tickets-open')).toBeNull();
    expect(within(stat).getByTestId('org-overview-stat-tickets-awaiting').textContent).toContain('2');
    expect(stat.textContent).not.toContain('No open tickets');
  });
});

describe('OrgOverviewTab — account row (#9020)', () => {
  const ACCOUNT_SUMMARY: OrgSummary = {
    ...BASE_SUMMARY,
    contracts: { active: 2, nextRenewalAt: '2026-12-01T00:00:00.000Z' },
    invoices: { outstanding: '0.00', currencyCode: 'USD', nextDueAt: null, overdueCount: 0 },
    contacts: { count: 4, primary: null },
    portalUsers: { count: 6 },
  };

  it('renders contracts, outstanding invoices, contacts and portal users as one compact row', async () => {
    renderTab(ACCOUNT_SUMMARY, fetchFor({}));
    const account = await screen.findByTestId('org-overview-account');
    expect(within(account).getByTestId('org-overview-stat-contracts').textContent).toContain('2');
    const invoices = within(account).getByTestId('org-overview-stat-invoices');
    expect(invoices.textContent).toContain('Outstanding invoices');
    expect(invoices.textContent).toContain('$0.00');
    expect(invoices.textContent).toContain('Nothing due');
    expect(within(account).getByTestId('org-overview-stat-contacts').textContent).toContain('4');
    expect(within(account).getByTestId('org-overview-stat-portalUsers').textContent).toContain('6');
  });

  it('links each account stat to its tab (portal users to org settings, which own them)', async () => {
    renderTab(ACCOUNT_SUMMARY, fetchFor({}));
    await screen.findByTestId('org-overview-account');
    expect(screen.getByTestId('org-overview-stat-contracts')).toHaveAttribute('href', '#billing');
    expect(screen.getByTestId('org-overview-stat-invoices')).toHaveAttribute('href', '#billing');
    expect(screen.getByTestId('org-overview-stat-contacts')).toHaveAttribute('href', '#contacts');
    expect(screen.getByTestId('org-overview-stat-portalUsers')).toHaveAttribute(
      'href',
      `/settings/organizations/${ORG_ID}#portal`,
    );
  });

  it('formats the outstanding balance in the org currency', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        invoices: { outstanding: '1250.50', currencyCode: 'USD', nextDueAt: '2026-10-01T00:00:00.000Z', overdueCount: 0 },
      },
      fetchFor({}),
    );
    const invoices = await screen.findByTestId('org-overview-stat-invoices');
    expect(invoices.textContent).toContain('1,250.50');
    expect(invoices.textContent).toMatch(/\$/);
  });

  it('leads with the overdue count when invoices are overdue, rather than the next due date', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        invoices: { outstanding: '900.00', currencyCode: 'USD', nextDueAt: '2026-10-01T00:00:00.000Z', overdueCount: 3 },
      },
      fetchFor({}),
    );
    const stat = await screen.findByTestId('org-overview-stat-invoices');
    expect(stat.textContent).toContain('3 overdue');
    // Overdue is the one account sub-line that earns the destructive tone.
    expect(stat.querySelector('.text-destructive')?.textContent).toBe('3 overdue');
  });

  it('keeps a not-overdue invoice sub-line muted', async () => {
    renderTab(ACCOUNT_SUMMARY, fetchFor({}));
    const stat = await screen.findByTestId('org-overview-stat-invoices');
    expect(stat.querySelector('.text-destructive')).toBeNull();
  });

  it('formats a non-USD balance in its own currency', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        invoices: { outstanding: '75.00', currencyCode: 'EUR', nextDueAt: null, overdueCount: 0 },
      },
      fetchFor({}),
    );
    const stat = await screen.findByTestId('org-overview-stat-invoices');
    expect(stat.textContent).toContain('€');
    expect(stat.textContent).not.toContain('$');
  });

  it('shows the next contract renewal, or says there is none', async () => {
    const { unmount } = renderTab(ACCOUNT_SUMMARY, fetchFor({}));
    expect((await screen.findByTestId('org-overview-stat-contracts')).textContent).toContain('Next renewal');
    unmount();
    renderTab({ ...ACCOUNT_SUMMARY, contracts: { active: 1, nextRenewalAt: null } }, fetchFor({}));
    expect((await screen.findByTestId('org-overview-stat-contracts')).textContent).toContain('No upcoming renewal');
  });

  it('encodes the org id into the portal-users settings link', async () => {
    render(
      <OrgOverviewTab orgId="a b/c" orgFetch={fetchFor({})} summary={{ ...BASE_SUMMARY, portalUsers: { count: 1 } }} summaryFailed={false} />,
    );
    expect(await screen.findByTestId('org-overview-stat-portalUsers')).toHaveAttribute(
      'href',
      '/settings/organizations/a%20b%2Fc#portal',
    );
  });

  it('still shows the key dates card when the caller can read no account section', async () => {
    renderTab(BASE_SUMMARY, fetchFor({}));
    const tier = await screen.findByTestId('org-overview-account-tier');
    expect(within(tier).queryByTestId('org-overview-account')).toBeNull();
    expect(within(tier).getByTestId('org-key-dates')).toBeTruthy();
  });

  it('shows the raw outstanding string rather than NaN when it will not parse', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        invoices: { outstanding: 'not-a-number', currencyCode: 'USD', nextDueAt: null, overdueCount: 0 },
      },
      fetchFor({}),
    );
    const stat = await screen.findByTestId('org-overview-stat-invoices');
    expect(stat.textContent).toContain('not-a-number');
    expect(stat.textContent).not.toContain('NaN');
  });

  it('places the key dates card inside the account tier, not orphaned after the feeds', async () => {
    renderTab(ACCOUNT_SUMMARY, fetchFor({}));
    const tier = await screen.findByTestId('org-overview-account-tier');
    expect(within(tier).getByTestId('org-overview-account')).toBeTruthy();
    expect(within(tier).getByTestId('org-key-dates')).toBeTruthy();
  });
});

describe('OrgOverviewTab — absent sections and tab visibility', () => {
  it('omits every stat whose summary section is absent, rather than zeroing it', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        devices: { total: 10, online: 7, offline: 3 },
        contracts: { active: 2, nextRenewalAt: '2026-12-01T00:00:00.000Z' },
        contacts: { count: 4, primary: null },
      },
      fetchFor({}),
    );
    await screen.findByTestId('org-overview-stat-devices');
    expect(screen.getByTestId('org-overview-stat-contracts')).toBeTruthy();
    expect(screen.getByTestId('org-overview-stat-contacts')).toBeTruthy();
    expect(screen.queryByTestId('org-overview-stat-alerts')).toBeNull();
    expect(screen.queryByTestId('org-overview-stat-tickets')).toBeNull();
    expect(screen.queryByTestId('org-overview-stat-invoices')).toBeNull();
    expect(screen.queryByTestId('org-overview-stat-portalUsers')).toBeNull();
  });

  it('drops the fleet strip entirely when the caller can read none of its sections', async () => {
    renderTab({ ...BASE_SUMMARY, contacts: { count: 4, primary: null } }, fetchFor({}));
    await screen.findByTestId('org-overview-account');
    expect(screen.queryByTestId('org-overview-fleet')).toBeNull();
  });

  it('says the summary is unavailable — and shows no stats — when the summary fetch failed', async () => {
    renderTab(null, fetchFor({}), true);
    await waitFor(() => expect(screen.getByTestId('org-overview-summary-error')).toBeTruthy());
    expect(screen.queryByTestId('org-overview-fleet')).toBeNull();
    expect(screen.queryByTestId('org-overview-account')).toBeNull();
  });

  it('renders a stat without a link when its tab is not visible to this user', async () => {
    render(
      <OrgOverviewTab
        orgId={ORG_ID}
        orgFetch={fetchFor({})}
        summary={{ ...BASE_SUMMARY, devices: { total: 10, online: 7, offline: 3 }, contacts: { count: 4, primary: null } }}
        summaryFailed={false}
        tabs={['overview', 'contacts']}
      />,
    );
    const devices = await screen.findByTestId('org-overview-stat-devices');
    expect(devices.tagName).not.toBe('A');
    expect(devices.closest('a')).toBeNull();
    expect(screen.getByTestId('org-overview-stat-contacts')).toHaveAttribute('href', '#contacts');
  });
});

describe('OrgOverviewTab — Service Management mode gate (#5075 W04)', () => {
  const FULL_SUMMARY: OrgSummary = {
    ...BASE_SUMMARY,
    devices: { total: 10, online: 7, offline: 3 },
    contacts: { count: 4, primary: null },
    tickets: { open: 3, awaitingCustomer: 1 },
    contracts: { active: 2, nextRenewalAt: '2026-12-01T00:00:00.000Z' },
    invoices: { outstanding: '1250.50', currencyCode: 'USD', nextDueAt: '2026-10-01T00:00:00.000Z', overdueCount: 0 },
  };

  it('mode="native" renders every stat the summary carries, including tickets/contracts/invoices', async () => {
    renderTab(FULL_SUMMARY, fetchFor({}), false, 'native');
    await waitFor(() => expect(screen.getByTestId('org-overview-stat-devices')).toBeTruthy());
    expect(screen.getByTestId('org-overview-stat-contacts')).toBeTruthy();
    expect(screen.getByTestId('org-overview-stat-tickets')).toBeTruthy();
    expect(screen.getByTestId('org-overview-stat-contracts')).toBeTruthy();
    expect(screen.getByTestId('org-overview-stat-invoices')).toBeTruthy();
  });

  it('mode="off" keeps devices/contacts but withdraws the tickets/contracts/invoices stats the module owns', async () => {
    renderTab(FULL_SUMMARY, fetchFor({}), false, 'off');
    await waitFor(() => expect(screen.getByTestId('org-overview-stat-devices')).toBeTruthy());
    expect(screen.getByTestId('org-overview-stat-contacts')).toBeTruthy();
    expect(screen.queryByTestId('org-overview-stat-tickets')).toBeNull();
    expect(screen.queryByTestId('org-overview-stat-contracts')).toBeNull();
    expect(screen.queryByTestId('org-overview-stat-invoices')).toBeNull();
  });
});

describe('OrgOverviewTab — feeds header and timestamps (#9020)', () => {
  it('gives Recent activity a "View all" link to the Activity tab', async () => {
    renderTab(BASE_SUMMARY, fetchFor({}));
    const link = await screen.findByTestId('org-overview-activity-view-all');
    expect(link).toHaveAttribute('href', '#activity');
    expect(link.textContent).toBe('View all activity');
  });

  it('omits the "View all" link when the Activity tab is hidden from this user', async () => {
    render(
      <OrgOverviewTab orgId={ORG_ID} orgFetch={fetchFor({})} summary={BASE_SUMMARY} summaryFailed={false} tabs={['overview']} />,
    );
    await screen.findByTestId('org-overview-activity');
    expect(screen.queryByTestId('org-overview-activity-view-all')).toBeNull();
  });

  it('drops seconds from feed timestamps', async () => {
    renderTab(
      BASE_SUMMARY,
      fetchFor({
        activity: () => json({ logs: [{ id: 'a1', action: 'device.created', timestamp: '2026-09-05T10:00:37.000Z' }] }),
        alerts: () =>
          json({ data: [{ id: 'al-1', title: 'Disk full', severity: 'critical', status: 'active', createdAt: '2026-09-05T10:00:37.000Z' }] }),
      }),
    );
    await waitFor(() => expect(screen.getByText('Disk full')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('org-overview-activity').textContent).toContain('Device'));
    const hms = /\d{1,2}:\d{2}:\d{2}/;
    const hm = /\d{1,2}:\d{2}/;
    // Positive half: a time IS rendered, just without seconds.
    expect(screen.getByTestId('org-overview-activity').textContent).toMatch(hm);
    expect(screen.getByTestId('org-overview-critical-alerts').textContent).toMatch(hm);
    expect(screen.getByTestId('org-overview-activity').textContent).not.toMatch(hms);
    expect(screen.getByTestId('org-overview-critical-alerts').textContent).not.toMatch(hms);
  });
});

describe('OrgOverviewTab — critical alert device link (ui-flow W03)', () => {
  const criticalAlert = {
    id: 'al-1',
    title: 'Disk full',
    severity: 'critical',
    status: 'active',
    deviceId: 'dev-1',
    deviceHostname: 'edge-01',
    createdAt: '2026-09-05T10:00:00.000Z',
  };

  it('links a critical alert hostname to the device', async () => {
    renderTab(BASE_SUMMARY, fetchFor({ alerts: () => json({ data: [criticalAlert] }) }));
    const link = await screen.findByTestId('device-record-link');
    expect(link).toHaveAttribute('href', '/devices/dev-1');
    expect(link).toHaveTextContent('edge-01');
  });

  it('prints the hostname as text when the alert has no deviceId', async () => {
    const { deviceId: _omit, ...detached } = criticalAlert;
    renderTab(BASE_SUMMARY, fetchFor({ alerts: () => json({ data: [detached] }) }));
    await waitFor(() => expect(screen.getByText(/edge-01/)).toBeTruthy());
    expect(screen.queryByTestId('device-record-link')).toBeNull();
  });
});

describe('OrgOverviewTab — feeds distinguish "nothing" from "could not find out"', () => {
  it('shows the empty state only when the request genuinely returned no rows', async () => {
    renderTab(BASE_SUMMARY, fetchFor({ alerts: () => json({ data: [] }), activity: () => json({ logs: [] }) }));
    await waitFor(() => expect(screen.getByText('No open critical alerts.')).toBeTruthy());
    expect(screen.getByText('No recorded activity yet.')).toBeTruthy();
    expect(screen.queryByTestId('org-overview-critical-alerts-failed')).toBeNull();
    expect(screen.queryByTestId('org-overview-activity-failed')).toBeNull();
  });

  it('does NOT claim "no critical alerts" when the alerts request 403s', async () => {
    // The regression that matters: a tech without alerts:read must not be told
    // this customer has nothing critical open. That is a false negative in a
    // monitoring tool, and it is actionable — they would not escalate.
    renderTab(BASE_SUMMARY, fetchFor({ alerts: () => json({ error: 'forbidden' }, 403) }));
    await waitFor(() => expect(screen.getByTestId('org-overview-critical-alerts-failed')).toBeTruthy());
    expect(screen.queryByText('No open critical alerts.')).toBeNull();
  });

  it('does NOT claim "no recorded activity" when the activity request fails', async () => {
    renderTab(BASE_SUMMARY, fetchFor({ activity: () => json({ error: 'boom' }, 500) }));
    await waitFor(() => expect(screen.getByTestId('org-overview-activity-failed')).toBeTruthy());
    expect(screen.queryByText('No recorded activity yet.')).toBeNull();
  });

  it('reports a thrown request (network / org-pin conflict) as a failure, not as empty', async () => {
    const orgFetch = vi.fn(async (path: string) => {
      if (path.includes('/alerts')) throw new Error('network down');
      return json({ logs: [] });
    }) as unknown as OrgFetch;
    renderTab(BASE_SUMMARY, orgFetch);
    await waitFor(() => expect(screen.getByTestId('org-overview-critical-alerts-failed')).toBeTruthy());
  });

  it('keeps one feed intact when the other fails', async () => {
    renderTab(
      BASE_SUMMARY,
      fetchFor({
        alerts: () => json({ error: 'forbidden' }, 403),
        activity: () => json({ logs: [{ id: 'a1', action: 'device.created', timestamp: '2026-09-05T10:00:00.000Z' }] }),
      }),
    );
    await waitFor(() => expect(screen.getByTestId('org-overview-critical-alerts-failed')).toBeTruthy());
    // The surviving feed still rendered its row, and the tiles are untouched.
    expect(screen.getByTestId('org-overview-activity').textContent).toContain('Device');
    expect(screen.queryByTestId('org-overview-activity-failed')).toBeNull();
  });

  it('retries just that feed from its failure state', async () => {
    const user = userEvent.setup();
    let alertsAttempt = 0;
    const orgFetch = vi.fn(async (path: string) => {
      if (path.includes('/alerts')) {
        alertsAttempt += 1;
        return alertsAttempt === 1
          ? json({ error: 'boom' }, 500)
          : json({ data: [{ id: 'al-1', title: 'Disk full', severity: 'critical', status: 'active', createdAt: '2026-09-05T10:00:00.000Z' }] });
      }
      return json({ logs: [] });
    }) as unknown as OrgFetch;

    renderTab(BASE_SUMMARY, orgFetch);
    await waitFor(() => expect(screen.getByTestId('org-overview-critical-alerts-failed')).toBeTruthy());
    await user.click(screen.getByTestId('org-overview-critical-alerts-failed').querySelector('button')!);
    await waitFor(() => expect(screen.getByText('Disk full')).toBeTruthy());
    expect(screen.queryByTestId('org-overview-critical-alerts-failed')).toBeNull();
  });

  it('leaves a forensic trail — a failed feed is logged, not swallowed', async () => {
    renderTab(BASE_SUMMARY, fetchFor({ alerts: () => json({ error: 'forbidden' }, 403) }));
    await waitFor(() => expect(screen.getByTestId('org-overview-critical-alerts-failed')).toBeTruthy());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('critical alerts'));
  });
});
