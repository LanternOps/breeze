import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AnalyticsPage from './AnalyticsPage';
import GaugeWidget from './GaugeWidget';
import { formatAxisLabel } from './ChartWidget';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const respond = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body
  }) as unknown as Response;

let routes: Record<string, unknown> = {};

beforeEach(() => {
  routes = {};
  window.location.hash = '';
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const path = String(input).split('?')[0]!;
    return respond(path in routes ? routes[path] : {});
  });
});

/** Text matches that are not <option> elements (the range <select> lists "Last 30 days"). */
const visibleText = (text: string) =>
  screen.queryAllByText(text).filter((el) => el.tagName !== 'OPTION');

describe('Analytics papercuts (#9650)', () => {
  it('does not print a range label on live cards that ignore the range', async () => {
    render(<AnalyticsPage />);
    await screen.findByText('Alert Statistics');
    expect(visibleText('Last 30 days')).toHaveLength(0);
  });

  it('calls the point-in-time ratio "Online now", not "Fleet uptime"', async () => {
    render(<AnalyticsPage />);
    expect(await screen.findByText('Online now')).toBeInTheDocument();
    expect(screen.queryByText('Fleet uptime')).not.toBeInTheDocument();
  });

  it('names the capacity metric in the card title', async () => {
    window.location.hash = 'capacity';
    render(<AnalyticsPage />);
    expect(await screen.findByText('Disk Capacity Forecast')).toBeInTheDocument();
  });

  it('formats capacity X-axis ISO timestamps as short dates', () => {
    expect(formatAxisLabel('2026-10-05T00:00:00.000Z')).not.toContain('T00:00');
    expect(formatAxisLabel('Week 3')).toBe('Week 3');
  });

  it('hides the SLA card until a definition exists', async () => {
    window.location.hash = 'sla';
    routes['/analytics/sla'] = { data: [] };
    render(<AnalyticsPage />);
    // "Updated <time>" is set only after every request (incl. SLA) has settled.
    await screen.findByText(/^Updated /);
    expect(screen.queryByText('SLA Compliance', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('sends the selected range to /metrics so sessions follow it', async () => {
    render(<AnalyticsPage />);
    await screen.findByText(/^Updated /);
    fireEvent.change(screen.getByRole('combobox', { name: 'Date range' }), { target: { value: '7d' } });
    await waitFor(() => {
      const last = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/metrics?')).at(-1);
      expect(last).toContain('range=7d');
    });
  });

  it('shows the in-range sessions count, not the live remoteSessions count', async () => {
    routes['/metrics'] = { data: { sessions: 1, remoteSessions: 0 } };
    render(<AnalyticsPage />);
    const label = await screen.findByText('Sessions in range');
    await waitFor(() => {
      expect(label.closest('a')?.textContent).toMatch(/Sessions in range\s*1(?!\d)/);
    });
  });

  it('does not show the coverage note below the device cap', async () => {
    routes['/devices'] = { data: Array.from({ length: 99 }, (_, i) => ({ id: `d-${i}` })) };
    render(<AnalyticsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Query Builder/ }));
    await screen.findByText('Run Query');
    await screen.findByText(/^Updated /);
    expect(screen.queryByText(/online devices only/i)).not.toBeInTheDocument();
  });

  it('keeps the gauge when checks exist, even at a real 0%', async () => {
    routes['/policies/compliance/stats'] = {
      data: { complianceRate: 0, complianceOverview: { compliant: 0, non_compliant: 4, pending: 0 } }
    };
    render(<AnalyticsPage />);
    await screen.findByText(/^Updated /);
    expect(screen.queryByText('No compliance checks to evaluate')).not.toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('labels the SLA definition it shows and drops the always-empty incidents figure', async () => {
    window.location.hash = 'sla';
    routes['/analytics/sla'] = { data: [{ id: 'sla-1', name: 'Gold support', uptimeTarget: 99.5 }] };
    routes['/analytics/sla/sla-1/compliance'] = { liveUptime: 99.9, uptimeTarget: 99.5 };
    render(<AnalyticsPage />);
    expect(await screen.findByText('Gold support')).toBeInTheDocument();
    expect(screen.getByText('SLA Compliance', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Gold support')).toBeInTheDocument();
    expect(screen.queryByText(/incidents/)).not.toBeInTheDocument();
  });

  it('says when the Query Builder only covers the first batch of online devices', async () => {
    routes['/devices'] = { data: Array.from({ length: 100 }, (_, i) => ({ id: `d-${i}` })) };
    render(<AnalyticsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Query Builder/ }));
    expect(await screen.findByText(/first 100 online devices/i)).toBeInTheDocument();
  });

  it('shows an empty state instead of a green 0% when there are no compliance checks', async () => {
    routes['/policies/compliance/stats'] = {
      data: {
        complianceRate: 0,
        totalPolicies: 0,
        enabledPolicies: 0,
        complianceOverview: { compliant: 0, non_compliant: 0, pending: 0 }
      }
    };
    render(<AnalyticsPage />);
    expect(await screen.findByText('No compliance checks to evaluate')).toBeInTheDocument();
  });

  it('gauge: empty prop renders the empty state with no percentage', () => {
    render(<GaugeWidget title="Policy Compliance" value={0} empty />);
    expect(screen.getByText('No compliance checks to evaluate')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('does not promise saving to a dashboard in the Query Builder subtitle', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Query Builder/ }));
    await screen.findByText('Run Query');
    expect(screen.queryByText(/dashboard/i, { selector: 'p' })).not.toBeInTheDocument();
  });
});
