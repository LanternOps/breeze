import { fireEvent, render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, expect, it, vi } from 'vitest';

import OrgSwitcherPane from './OrgSwitcherPane';
import { ORG_SWITCHER_DESTINATIONS, type OrgSwitcherDestination } from './orgSwitcherDestinations';
import { formatAddress } from '@/lib/formatAddress';
import { statusColors } from '@/lib/orgStatus';
import type { Organization } from '@/stores/orgStore';
import type { OrgSummary } from '@/components/organizations/record/orgRecordFetch';

const ORG: Organization = {
  id: 'org-b',
  partnerId: 'p1',
  name: 'Acme Dental',
  status: 'trial',
  createdAt: '2024-01-01',
  billingAddressLine1: '1 Main St',
  billingAddressCity: 'Springfield',
  billingAddressRegion: 'IL',
  billingAddressPostalCode: '62701',
  billingAddressCountry: 'US',
};

const SUMMARY: OrgSummary = {
  orgId: 'org-b',
  devices: { total: 42, online: 39, offline: 3 },
  alerts: { open: 4, critical: 1, high: 2 },
  tickets: { open: 2, awaitingCustomer: 0 },
  sites: { count: 3 },
  contacts: { count: 1, primary: { id: 'c1', name: 'Dana Reyes', email: null, phone: '+1 555 0100' } },
};

const ALL: OrgSwitcherDestination[] = [...ORG_SWITCHER_DESTINATIONS];

function renderPane(
  over: Partial<React.ComponentProps<typeof OrgSwitcherPane>> = {},
) {
  const onDestination = vi.fn();
  render(
    <OrgSwitcherPane
      org={ORG}
      summary={SUMMARY}
      summaryStatus="ready"
      destinations={ALL}
      onDestination={onDestination}
      {...over}
    />,
  );
  return { onDestination };
}

describe('OrgSwitcherPane', () => {
  it('header shows name, the shared status badge, the formatted address and a tel link', () => {
    renderPane();
    expect(screen.getByText('Acme Dental')).toBeTruthy();
    for (const cls of statusColors.trial.split(' ')) {
      expect(screen.getByText('Trial').className).toContain(cls);
    }
    const expected = formatAddress({
      line1: '1 Main St',
      city: 'Springfield',
      region: 'IL',
      postalCode: '62701',
      country: 'US',
    });
    expect(expected).toBe('1 Main St · Springfield, IL 62701 · US');
    expect(screen.getByTestId('org-switcher-pane-address').textContent).toBe(expected);
    expect(screen.getByRole('link').getAttribute('href')).toBe('tel:+1 555 0100');
  });

  it('renders the counts the spec fixes', () => {
    renderPane();
    const devices = screen.getByTestId('org-switcher-count-devices');
    expect(devices.textContent).toBe('42 · 3 offline');
    expect(devices.querySelector('.text-warning-strong')?.textContent).toBe('3 offline');
    expect(screen.getByTestId('org-switcher-count-tickets').textContent).toBe('2 open');
    const alerts = screen.getByTestId('org-switcher-count-alerts');
    expect(alerts.textContent).toBe('1 critical');
    expect(alerts.className).toContain('text-destructive');
    expect(screen.getByTestId('org-switcher-count-sites').textContent).toBe('3');
    expect(screen.queryByTestId('org-switcher-count-overview')).toBeNull();
    expect(screen.queryByTestId('org-switcher-count-billing')).toBeNull();
  });

  it('zero offline and zero critical lose their tones', () => {
    renderPane({
      summary: {
        ...SUMMARY,
        devices: { total: 42, online: 42, offline: 0 },
        alerts: { open: 4, critical: 0, high: 2 },
      },
    });
    const devices = screen.getByTestId('org-switcher-count-devices');
    expect(devices.textContent).toBe('42 · 0 offline');
    expect(devices.querySelector('.text-warning-strong')).toBeNull();
    const alerts = screen.getByTestId('org-switcher-count-alerts');
    expect(alerts.textContent).toBe('none');
    expect(alerts.className).not.toContain('text-destructive');
  });

  it('loading shows skeletons and never a number', () => {
    renderPane({ summary: undefined, summaryStatus: 'loading' });
    expect(screen.getAllByTestId('org-switcher-count-skeleton')).toHaveLength(4);
    expect(screen.queryByTestId('org-switcher-count-devices')).toBeNull();
    expect(screen.queryByTestId('org-switcher-count-sites')).toBeNull();
  });

  it('error and idle render destinations without counts or skeletons', () => {
    for (const status of ['error', 'idle'] as const) {
      const { unmount } = render(
        <OrgSwitcherPane
          org={ORG}
          summary={undefined}
          summaryStatus={status}
          destinations={ALL}
          onDestination={vi.fn()}
        />,
      );
      expect(screen.getAllByTestId(/^org-switcher-dest-/)).toHaveLength(6);
      expect(screen.queryByTestId('org-switcher-count-skeleton')).toBeNull();
      expect(screen.queryByTestId('org-switcher-count-devices')).toBeNull();
      unmount();
    }
  });

  it('only the given destinations render, in order', () => {
    renderPane({ destinations: ['overview', 'sites'] });
    const buttons = screen.getAllByTestId(/^org-switcher-dest-/);
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual([
      'org-switcher-dest-overview',
      'org-switcher-dest-sites',
    ]);
  });

  it('a destination click hands the org id and target to onDestination', () => {
    const { onDestination } = renderPane();
    fireEvent.click(screen.getByTestId('org-switcher-dest-billing'));
    expect(onDestination).toHaveBeenLastCalledWith('org-b', '/organizations/org-b#billing');
    fireEvent.click(screen.getByTestId('org-switcher-dest-devices'));
    expect(onDestination).toHaveBeenLastCalledWith('org-b', '/devices');
  });

  it('accessible names read "Devices, Acme Dental, 42 · 3 offline"', () => {
    renderPane();
    expect(screen.getByRole('button', { name: 'Devices, Acme Dental, 42 · 3 offline' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Billing, Acme Dental' })).toBeTruthy();
  });

  it('summary sections the caller cannot read leave their count off', () => {
    renderPane({ summary: { orgId: 'org-b', sites: { count: 3 } } });
    expect(screen.queryByTestId('org-switcher-count-devices')).toBeNull();
    expect(screen.queryByTestId('org-switcher-count-tickets')).toBeNull();
    expect(screen.queryByTestId('org-switcher-count-alerts')).toBeNull();
    expect(screen.getByTestId('org-switcher-count-sites').textContent).toBe('3');
  });

  it('a contact with an empty name still renders the tel link', () => {
    renderPane({
      summary: {
        ...SUMMARY,
        contacts: { count: 1, primary: { id: 'c1', name: '', email: null, phone: '+1 555 0100' } },
      },
    });
    expect(screen.getByRole('link').getAttribute('href')).toBe('tel:+1 555 0100');
    expect(screen.getByTestId('org-switcher-pane-contact').textContent).toBe('+1 555 0100');
  });

  it('no address and no contact render neither line', () => {
    renderPane({
      org: { id: 'org-b', partnerId: 'p1', name: 'Acme Dental', status: 'active', createdAt: '2024-01-01' },
      summary: { orgId: 'org-b', sites: { count: 3 } },
    });
    expect(screen.queryByTestId('org-switcher-pane-address')).toBeNull();
    expect(screen.queryByTestId('org-switcher-pane-contact')).toBeNull();
    expect(screen.getByText('Acme Dental')).toBeTruthy();
  });
});
