import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/lib/i18n';
import OrgOverviewTab from './OrgOverviewTab';
import type { OrgFetch, OrgSummary } from './orgRecordFetch';

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

function renderTab(summary: OrgSummary | null, orgFetch: OrgFetch, summaryFailed = false) {
  return render(<OrgOverviewTab orgId={ORG_ID} orgFetch={orgFetch} summary={summary} summaryFailed={summaryFailed} />);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OrgOverviewTab — tiles', () => {
  it('renders a tile for each section the summary carries, and none for the rest', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        devices: { total: 10, online: 7, offline: 3 },
        contracts: { active: 2, nextRenewalAt: '2026-12-01T00:00:00.000Z' },
        contacts: { count: 4, primary: null },
      },
      fetchFor({}),
    );
    await waitFor(() => expect(screen.getByTestId('org-overview-tile-devices')).toBeTruthy());
    expect(screen.getByTestId('org-overview-tile-contracts')).toBeTruthy();
    expect(screen.getByTestId('org-overview-tile-contacts')).toBeTruthy();
    // Sections the caller could not read are absent, not zeroed.
    expect(screen.queryByTestId('org-overview-tile-alerts')).toBeNull();
    expect(screen.queryByTestId('org-overview-tile-tickets')).toBeNull();
    expect(screen.queryByTestId('org-overview-tile-invoices')).toBeNull();
    expect(screen.queryByTestId('org-overview-tile-portalUsers')).toBeNull();
  });

  it('renders every remaining tile when the caller can read everything', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        alerts: { open: 5, critical: 2, high: 1 },
        tickets: { open: 3, awaitingCustomer: 1 },
        invoices: { outstanding: '1250.50', currencyCode: 'USD', nextDueAt: '2026-10-01T00:00:00.000Z', overdueCount: 0 },
        portalUsers: { count: 6 },
      },
      fetchFor({}),
    );
    await waitFor(() => expect(screen.getByTestId('org-overview-tile-alerts')).toBeTruthy());
    expect(screen.getByTestId('org-overview-tile-tickets')).toBeTruthy();
    expect(screen.getByTestId('org-overview-tile-portalUsers')).toBeTruthy();
    const invoices = screen.getByTestId('org-overview-tile-invoices');
    // Formatted as the org's currency, not as a bare number.
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
    await waitFor(() => expect(screen.getByTestId('org-overview-tile-invoices')).toBeTruthy());
    expect(screen.getByTestId('org-overview-tile-invoices').textContent).toContain('3 overdue');
  });

  it('shows the raw outstanding string rather than NaN when it will not parse', async () => {
    renderTab(
      {
        ...BASE_SUMMARY,
        invoices: { outstanding: 'not-a-number', currencyCode: 'USD', nextDueAt: null, overdueCount: 0 },
      },
      fetchFor({}),
    );
    await waitFor(() => expect(screen.getByTestId('org-overview-tile-invoices')).toBeTruthy());
    const tile = screen.getByTestId('org-overview-tile-invoices');
    expect(tile.textContent).toContain('not-a-number');
    expect(tile.textContent).not.toContain('NaN');
  });

  it('says the summary is unavailable — and shows no tiles — when the summary fetch failed', async () => {
    renderTab(null, fetchFor({}), true);
    await waitFor(() => expect(screen.getByTestId('org-overview-summary-error')).toBeTruthy());
    expect(screen.queryByTestId('org-overview-tile-devices')).toBeNull();
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
