import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MetricHistoryCharts } from './MetricHistoryCharts';
import { fetchWithAuth } from '../../../stores/auth';
import type { Collection, CollectionOid } from './types';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// recharts needs a measured container; jsdom reports 0×0 and the chart body
// never renders. Stubbing ChartWidget keeps these assertions on OUR logic
// (which OID, which type, which subtitle) instead of on recharts' internals.
vi.mock('../../analytics/ChartWidget', () => ({
  default: ({ title, subtitle, type, data, series }: { title: string; subtitle?: string; type: string; data: unknown[]; series: unknown[] }) => (
    <div data-testid={`chart-widget-${title}`} data-type={type} data-points={data.length} data-rows={JSON.stringify(data)} data-series={JSON.stringify(series)}>
      {title}
      {subtitle ? <span>{subtitle}</span> : null}
    </div>
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const AT = '2026-09-16T10:00:00.000Z';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function entry(overrides: Partial<CollectionOid> & { baseOid: string; name: string }): CollectionOid {
  return {
    mode: 'walk',
    cadence: 'fast',
    state: 'collecting',
    observedAt: AT,
    error: null,
    instances: [{ oid: `${overrides.baseOid}.1`, instance: '1', value: '10', valueType: 'gauge32', observedAt: AT }],
    ...overrides,
  };
}

const collection: Collection = {
  templateId: 'tpl-1', lastPolledAt: AT, pollingInterval: 300, status: 'ok', consecutiveFailures: 0,
  oids: [
    entry({ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' }),
    entry({ baseOid: '1.3.6.1.2.1.25.3.5.1.1', name: 'hrPrinterStatus' }),
  ],
};

const counterCollection: Collection = {
  ...collection,
  oids: [
    entry({
      baseOid: '1.3.6.1.2.1.2.2.1.10',
      name: 'ifInOctets',
      instances: [{ oid: '1.3.6.1.2.1.2.2.1.10.1', instance: '1', value: '99', valueType: 'counter64', observedAt: AT }],
    }),
  ],
};

const fiveOidCollection: Collection = {
  ...collection,
  oids: Array.from({ length: 5 }, (_, i) => entry({ baseOid: `1.3.6.1.2.1.99.${i}`, name: `metric${i}` })),
};

describe('MetricHistoryCharts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(json({ series: [{ oid: 'x', instance: '1', name: 'x', points: [[AT, 1]] }] }));
  });

  it('defaults to the first chartable OID and offers a 24h/7d/30d toggle', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);

    expect(screen.getByTestId('network-detail-chart-range-24h')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-chart-range-7d')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-chart-range-30d')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('network-detail-chart-1.3.6.1.2.1.1.3.0')).toBeInTheDocument());
    expect(screen.queryByTestId('network-detail-chart-1.3.6.1.2.1.25.3.5.1.1')).toBeNull();
    await waitFor(() => expect(fetchWithAuthMock.mock.calls[0][0] as string).toContain('bucket=5m'));
  });

  it('re-requests with the new bucket when the range changes', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());

    await userEvent.click(screen.getByTestId('network-detail-chart-range-30d'));

    await waitFor(() => expect(fetchWithAuthMock.mock.calls.at(-1)![0] as string).toContain('bucket=1d'));
  });

  it('charts a gauge OID as a line with no delta', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('chart-widget-sysUpTime')).toHaveAttribute('data-type', 'line'));
    expect(fetchWithAuthMock.mock.calls[0][0] as string).not.toContain('delta=1');
  });

  it('charts a counter OID as per-bucket delta bars', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={counterCollection} timezone="UTC" />);
    await waitFor(() => expect(fetchWithAuthMock.mock.calls.at(-1)![0] as string).toContain('delta=1'));
    const widget = screen.getByTestId('chart-widget-ifInOctets');
    expect(widget).toHaveAttribute('data-type', 'bar');
    // The subtitle must say the value is per bucket, or a delta bar reads as a level.
    expect(widget.textContent).toContain('per');
  });

  it('caps the selection at four OIDs', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={fiveOidCollection} timezone="UTC" />);
    for (const oid of fiveOidCollection.oids) {
      const pick = screen.getByTestId(`network-detail-chart-pick-${oid.baseOid}`);
      if (!(pick as HTMLInputElement).disabled && !(pick as HTMLInputElement).checked) {
        await userEvent.click(pick);
      }
    }
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="network-detail-chart-1.3.6.1.2.1.99."]')).toHaveLength(4),
    );
    expect(screen.getByTestId('network-detail-chart-cap')).toBeInTheDocument();
  });

  it('renders a per-chart error without blanking the others', async () => {
    fetchWithAuthMock.mockImplementation((url: string) =>
      Promise.resolve(
        (url as string).includes(encodeURIComponent('1.3.6.1.2.1.25.3.5.1.1'))
          ? json({ error: 'Range exceeds the 90-day cap' }, 400)
          : json({ series: [{ oid: 'x', instance: '1', name: 'x', points: [[AT, 1]] }] }),
      ),
    );
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);

    await userEvent.click(screen.getByTestId('network-detail-chart-pick-1.3.6.1.2.1.25.3.5.1.1'));

    await waitFor(() =>
      expect(screen.getByTestId('network-detail-chart-error-1.3.6.1.2.1.25.3.5.1.1').textContent).toContain('90-day'),
    );
    // The healthy chart is untouched.
    expect(screen.getByTestId('chart-widget-sysUpTime')).toBeInTheDocument();
  });

  it('offers nothing to chart, and says so, when no OID is collecting', () => {
    render(<MetricHistoryCharts assetId="a1" collection={{ ...collection, oids: [] }} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-charts-empty')).toBeInTheDocument();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('says nothing is configured when there is no collection at all', () => {
    render(<MetricHistoryCharts assetId="a1" collection={null} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-charts-empty')).toBeInTheDocument();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });
});

  it('keeps walked instances as separate series and merges sparse points by timestamp', async () => {
    const later = '2026-09-16T11:00:00.000Z';
    fetchWithAuthMock.mockResolvedValue(json({ series: [
      { oid: 'x.1', instance: '1', name: 'Port', points: [[later, 12], [AT, 10]] },
      { oid: 'x.2', instance: '2', name: 'Port', points: [[AT, 20]] },
    ] }));
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('chart-widget-sysUpTime')).toHaveAttribute('data-points', '2'));
    const widget = screen.getByTestId('chart-widget-sysUpTime');
    expect(JSON.parse(widget.getAttribute('data-rows')!)).toEqual([
      { timestamp: AT, '1': 10, '2': 20 }, { timestamp: later, '1': 12 },
    ]);
    expect(JSON.parse(widget.getAttribute('data-series')!)).toMatchObject([
      { key: '1', label: 'Port / 1' }, { key: '2', label: 'Port / 2' },
    ]);
  });

  it('uses value as the scalar key and shows the instance truncation note', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ truncatedSeries: true, series: [
      { oid: 'x', instance: '', name: 'Temperature', points: [[AT, 10]] },
    ] }));
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);
    expect(await screen.findByTestId('network-detail-chart-truncated-1.3.6.1.2.1.1.3.0')).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('chart-widget-sysUpTime').getAttribute('data-series')!)).toMatchObject([
      { key: 'value', label: 'Temperature' },
    ]);
  });
