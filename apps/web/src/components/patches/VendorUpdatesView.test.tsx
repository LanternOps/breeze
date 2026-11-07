import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// #11074: the Vendor updates tab, against the JSON GET /oem-updates/fleet returns.

const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId }) }));

import { fetchWithAuth } from '../../stores/auth';
import VendorUpdatesView from './VendorUpdatesView';

const fetchMock = vi.mocked(fetchWithAuth);

const COUNTS = { up_to_date: 12, overdue: 3, failing: 2, not_supported: 4, not_managed: 40, waiting_for_reboot: 5, reboot_overdue: 1 };

const device = (overrides: Record<string, unknown> = {}) => ({
  deviceId: 'device-1',
  hostname: 'LAPTOP-01',
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'Main',
  deviceStatus: 'online',
  lane: 'dell',
  displayState: 'overdue',
  lastOutcome: 'failed',
  lastAttemptAt: '2027-02-20T02:00:00.000Z',
  lastSuccessAt: null,
  rebootPendingSince: null,
  scheduleNotHandedBack: false,
  ...overrides,
});

const respond = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

const fleetCalls = () => fetchMock.mock.calls.map((call) => new URL(String(call[0]), 'http://x'));
const lastCall = () => fleetCalls().at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  org.currentOrgId = null;
  window.history.replaceState({}, '', '/patches#vendor-updates');
  fetchMock.mockImplementation(async () => respond({ counts: COUNTS, total: 1, devices: [device()] }));
});

describe('VendorUpdatesView', () => {
  it.each([
    ['up_to_date', 'Up to date', '12'],
    ['overdue', 'Overdue', '3'],
    ['failing', 'Failing', '2'],
    ['not_supported', 'Not supported', '4'],
    ['not_managed', 'Not managed', '40'],
    ['waiting_for_reboot', 'Waiting for restart', '5'],
    ['reboot_overdue', 'Restart overdue', '1'],
  ])('shows the count for %s', async (state, label, count) => {
    render(<VendorUpdatesView />);
    const tile = await screen.findByTestId(`vendor-updates-count-${state}`);
    expect(tile).toHaveTextContent(label);
    await waitFor(() => expect(tile).toHaveTextContent(count));
  });

  it('asks the fleet route for the first page with no filter', async () => {
    render(<VendorUpdatesView />);
    await screen.findByText('LAPTOP-01');
    expect(lastCall().pathname).toBe('/oem-updates/fleet');
    expect(lastCall().searchParams.get('offset')).toBe('0');
    expect(lastCall().searchParams.get('limit')).toBe('50');
    expect(lastCall().searchParams.has('state')).toBe(false);
    expect(lastCall().searchParams.has('lane')).toBe(false);
  });

  it('a row links to the device', async () => {
    render(<VendorUpdatesView />);
    const link = await screen.findByRole('link', { name: /LAPTOP-01/ });
    expect(link).toHaveAttribute('href', '/devices/device-1');
  });

  it('a row shows its organization, site, vendor and state', async () => {
    render(<VendorUpdatesView />);
    const row = await screen.findByTestId('vendor-updates-row-device-1');
    expect(row).toHaveTextContent('Acme');
    expect(row).toHaveTextContent('Main');
    expect(row).toHaveTextContent('Dell');
    expect(within(row).getByTestId('vendor-updates-row-state')).toHaveAttribute('data-state', 'overdue');
  });

  it('a schedule Breeze could not hand back says so on the row', async () => {
    fetchMock.mockResolvedValue(respond({ counts: COUNTS, total: 1, devices: [device({ scheduleNotHandedBack: true })] }));
    render(<VendorUpdatesView />);
    expect(await screen.findByTestId('vendor-updates-row-schedule-note')).toBeInTheDocument();
  });

  it('a row with no schedule problem has no such note', async () => {
    render(<VendorUpdatesView />);
    await screen.findByText('LAPTOP-01');
    expect(screen.queryByTestId('vendor-updates-row-schedule-note')).toBeNull();
  });

  describe('the filter lives in the hash', () => {
    it('clicking a count filters, and writes the hash, never a query param', async () => {
      render(<VendorUpdatesView />);
      fireEvent.click(await screen.findByTestId('vendor-updates-count-overdue'));
      await waitFor(() => expect(lastCall().searchParams.get('state')).toBe('overdue'));
      expect(window.location.hash).toBe('#vendor-updates&state=overdue');
      expect(window.location.search).toBe('');
    });

    it('clicking the selected count clears the filter', async () => {
      window.history.replaceState({}, '', '/patches#vendor-updates&state=overdue');
      render(<VendorUpdatesView />);
      fireEvent.click(await screen.findByTestId('vendor-updates-count-overdue'));
      await waitFor(() => expect(lastCall().searchParams.has('state')).toBe(false));
      expect(window.location.hash).toBe('#vendor-updates');
    });

    it('a deep link lands filtered', async () => {
      window.history.replaceState({}, '', '/patches#vendor-updates&state=failing&lane=hp');
      render(<VendorUpdatesView />);
      await waitFor(() => {
        expect(lastCall().searchParams.get('state')).toBe('failing');
        expect(lastCall().searchParams.get('lane')).toBe('hp');
      });
      expect(screen.getByTestId('vendor-updates-count-failing')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('vendor-updates-lane-filter')).toHaveValue('hp');
    });

    it('an unknown value in the hash is ignored', async () => {
      window.history.replaceState({}, '', '/patches#vendor-updates&state=bogus&lane=acer');
      render(<VendorUpdatesView />);
      await screen.findByText('LAPTOP-01');
      expect(lastCall().searchParams.has('state')).toBe(false);
      expect(lastCall().searchParams.has('lane')).toBe(false);
    });

    it('the vendor filter writes the hash and keeps the state', async () => {
      window.history.replaceState({}, '', '/patches#vendor-updates&state=overdue');
      render(<VendorUpdatesView />);
      fireEvent.change(await screen.findByTestId('vendor-updates-lane-filter'), { target: { value: 'dell' } });
      await waitFor(() => expect(lastCall().searchParams.get('lane')).toBe('dell'));
      expect(window.location.hash).toBe('#vendor-updates&state=overdue&lane=dell');
    });

    it('follows a hash changed from outside', async () => {
      render(<VendorUpdatesView />);
      await screen.findByText('LAPTOP-01');
      await act(async () => {
        window.history.replaceState({}, '', '/patches#vendor-updates&state=reboot_overdue');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await waitFor(() => expect(lastCall().searchParams.get('state')).toBe('reboot_overdue'));
    });
  });

  describe('paging', () => {
    const many = (total: number) => respond({ counts: COUNTS, total, devices: [device()] });

    it('next and previous move by a page, and a new filter goes back to the first', async () => {
      fetchMock.mockResolvedValue(many(120));
      render(<VendorUpdatesView />);
      const next = await screen.findByTestId('vendor-updates-next');
      await waitFor(() => expect(next).toBeEnabled());
      expect(screen.getByTestId('vendor-updates-previous')).toBeDisabled();

      fireEvent.click(next);
      await waitFor(() => expect(lastCall().searchParams.get('offset')).toBe('50'));
      await waitFor(() => expect(screen.getByTestId('vendor-updates-previous')).toBeEnabled());

      fireEvent.click(screen.getByTestId('vendor-updates-count-overdue'));
      await waitFor(() => {
        expect(lastCall().searchParams.get('state')).toBe('overdue');
        expect(lastCall().searchParams.get('offset')).toBe('0');
      });
    });

    it('no next on the last page', async () => {
      fetchMock.mockResolvedValue(many(1));
      render(<VendorUpdatesView />);
      await screen.findByText('LAPTOP-01');
      expect(screen.getByTestId('vendor-updates-next')).toBeDisabled();
    });
  });

  it('refetches when the header org changes', async () => {
    const { rerender } = render(<VendorUpdatesView />);
    await screen.findByText('LAPTOP-01');
    const before = fetchMock.mock.calls.length;
    org.currentOrgId = 'org-2';
    rerender(<VendorUpdatesView />);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });

  it('another org\'s rows and counts do not stay on screen while the new org loads', async () => {
    const { rerender } = render(<VendorUpdatesView />);
    await screen.findByText('LAPTOP-01');

    let answer: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    org.currentOrgId = 'org-2';
    rerender(<VendorUpdatesView />);

    expect(screen.queryByText('LAPTOP-01')).toBeNull();
    expect(screen.getByTestId('vendor-updates-count-overdue')).not.toHaveTextContent('3');

    await act(async () => {
      answer(respond({ counts: COUNTS, total: 1, devices: [device({ deviceId: 'other', hostname: 'OTHER-ORG' })] }));
    });
    expect(await screen.findByText('OTHER-ORG')).toBeInTheDocument();
  });

  it('says it is loading while a new filter is on its way, and stops when it lands', async () => {
    render(<VendorUpdatesView />);
    await screen.findByText('LAPTOP-01');
    await waitFor(() => expect(screen.getByTestId('vendor-updates-view')).toHaveAttribute('aria-busy', 'false'));

    let answer: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    fireEvent.click(screen.getByTestId('vendor-updates-count-overdue'));

    await waitFor(() => expect(screen.getByTestId('vendor-updates-view')).toHaveAttribute('aria-busy', 'true'));
    await act(async () => {
      answer(respond({ counts: COUNTS, total: 1, devices: [device()] }));
    });
    await waitFor(() => expect(screen.getByTestId('vendor-updates-view')).toHaveAttribute('aria-busy', 'false'));
  });

  it('a slow answer for an old filter does not overwrite the new one', async () => {
    let answerOld: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answerOld = resolve; }));
    fetchMock.mockImplementation(async () => respond({ counts: COUNTS, total: 1, devices: [device({ deviceId: 'new', hostname: 'NEW-ONE' })] }));

    render(<VendorUpdatesView />);
    fireEvent.click(await screen.findByTestId('vendor-updates-count-overdue'));
    await screen.findByText('NEW-ONE');

    await act(async () => {
      answerOld(respond({ counts: COUNTS, total: 1, devices: [device({ hostname: 'OLD-ONE' })] }));
    });
    expect(screen.queryByText('OLD-ONE')).toBeNull();
    expect(screen.getByText('NEW-ONE')).toBeInTheDocument();
  });

  it('shows a load failure with a way to retry, and no zero counts as if they were true', async () => {
    fetchMock.mockResolvedValueOnce(respond({ error: 'nope' }, 500));
    render(<VendorUpdatesView />);
    const retry = await screen.findByTestId('vendor-updates-retry');
    expect(screen.queryByTestId('vendor-updates-count-overdue')).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByText('LAPTOP-01')).toBeInTheDocument();
  });

  it('a network failure is a load failure too', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<VendorUpdatesView />);
    expect(await screen.findByTestId('vendor-updates-retry')).toBeInTheDocument();
  });

  it('a platform admin with no org selected is asked to pick one', async () => {
    fetchMock.mockResolvedValue(respond({ error: 'orgId is required' }, 400));
    render(<VendorUpdatesView />);
    expect(await screen.findByTestId('vendor-updates-pick-org')).toBeInTheDocument();
    expect(screen.queryByTestId('vendor-updates-retry')).toBeNull();
  });

  it('says so when a filter matches nothing', async () => {
    fetchMock.mockResolvedValue(respond({ counts: COUNTS, total: 0, devices: [] }));
    render(<VendorUpdatesView />);
    expect(await screen.findByTestId('vendor-updates-empty')).toBeInTheDocument();
  });

  it('makes no mutating request', async () => {
    render(<VendorUpdatesView />);
    await screen.findByText('LAPTOP-01');
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    }
  });
});
