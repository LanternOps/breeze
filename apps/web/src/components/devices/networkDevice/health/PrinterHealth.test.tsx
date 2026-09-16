import '@/lib/i18n';

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrinterHealth } from './PrinterHealth';
import { PRINTER_OIDS } from './printerMib';
import { xeroxCollection } from './printerMib.fixtures';
import { fetchWithAuth } from '../../../../stores/auth';
import type { Collection } from '../types';
import { formatLastSeen } from '@/lib/formatTime';

vi.mock('../../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const deltaSeries = {
  series: [{
    oid: '1.3.6.1.2.1.43.10.2.1.4.1.1',
    instance: '1.1',
    name: 'prtMarkerLifeCount',
    points: [
      ['2026-09-08', 100], ['2026-09-09', 90], ['2026-09-10', 80], ['2026-09-11', 70],
      ['2026-09-12', 60], ['2026-09-13', 50], ['2026-09-14', 40], ['2026-09-15', 30],
    ],
  }],
};

function renderCard(collection: Collection | null = xeroxCollection) {
  return render(
    <PrinterHealth
      assetId="a1"
      assetType="printer"
      collection={collection}
      snmpEnabled
      timezone="UTC"
      onSetUpMonitoring={vi.fn()}
      onViewMonitoring={vi.fn()}
    />,
  );
}

describe('PrinterHealth', () => {
  afterEach(async () => {
    // Settle the metrics request even in synchronous presentation assertions.
    await act(async () => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(json(deltaSeries));
  });

  it('renders one labelled meter per supply with the percentage written out', () => {
    renderCard();
    expect(screen.getAllByTestId(/^network-detail-supply-/)).toHaveLength(5);

    const cyan = screen.getByTestId('network-detail-supply-1.1');
    expect(cyan.textContent).toContain('Cyan Toner Cartridge');
    expect(cyan.textContent).toContain('37');

    // Never color alone: the meter exposes its value to assistive tech too.
    const bar = cyan.querySelector('[role="meter"]')!;
    expect(bar).toHaveAttribute('aria-valuenow', '37');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-label', expect.stringContaining('Cyan Toner Cartridge'));
  });

  it('shows a negative level as unknown and draws no bar for it', () => {
    renderCard();
    const waste = screen.getByTestId('network-detail-supply-1.5');
    expect(waste.textContent).toContain('Waste Toner Container');
    expect(waste.textContent).toContain('Unknown');
    expect(waste.querySelector('[role="meter"]')).toBeNull();
    // -3 ("some remaining") must never be printed as a number.
    expect(waste.textContent).not.toContain('-3');
  });

  it('marks a supply at or below the low threshold with the word Low, not just a color', () => {
    renderCard({
      ...xeroxCollection,
      oids: xeroxCollection.oids.map((entry) =>
        entry.baseOid === '1.3.6.1.2.1.43.11.1.1.9'
          ? { ...entry, instances: entry.instances.map((row) => row.instance === '1.1' ? { ...row, value: '20' } : row) }
          : entry,
      ),
    });
    expect(screen.getByTestId('network-detail-supply-1.1').textContent).toContain('Low');
    expect(screen.getByTestId('network-detail-supply-1.3').textContent).not.toContain('Low');
  });

  it('renders decoded status words and error conditions', () => {
    renderCard();
    const status = screen.getByTestId('network-detail-printer-status').textContent ?? '';
    expect(status).toContain('Idle');
    expect(status).toContain('Warning');
    expect(screen.getByTestId('network-detail-printer-errors').textContent).toContain('Supply missing');
  });

  it('renders no error chips when the bitmask is clear', () => {
    const clean: Collection = {
      ...xeroxCollection,
      oids: xeroxCollection.oids.map((entry) =>
        entry.baseOid === '1.3.6.1.2.1.25.3.5.1.2'
          ? { ...entry, instances: [{ ...entry.instances[0], value: '0x00' }] }
          : entry,
      ),
    };
    renderCard(clean);
    expect(screen.queryByTestId('network-detail-printer-errors')).toBeNull();
  });

  it('requests eight days of daily deltas for the page count', async () => {
    renderCard();
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const url = fetchWithAuthMock.mock.calls[0][0] as string;
    expect(url).toContain('/monitoring/assets/a1/metrics');
    expect(url).toContain(encodeURIComponent('1.3.6.1.2.1.43.10.2.1.4.1.1'));
    expect(url).toContain('bucket=1d');
    expect(url).toContain('delta=1');
    const params = new URL(url, 'https://example.test').searchParams;
    expect(Date.parse(params.get('to')!) - Date.parse(params.get('from')!)).toBe(8 * 86_400_000);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('renders the page count with both deltas once the metrics call resolves', async () => {
    renderCard();
    expect(await screen.findByTestId('network-detail-page-count')).toHaveTextContent('184,230');
    const deltas = (await screen.findByTestId('network-detail-page-deltas')).textContent ?? '';
    expect(deltas).toContain('30');
    expect(deltas).toContain('420');
  });

  it('does not claim a delta when the metrics call fails', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ error: 'nope' }, 500));
    renderCard();
    expect(await screen.findByTestId('network-detail-page-count')).toHaveTextContent('184,230');
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId('network-detail-page-deltas')).toBeNull();
  });

  it('does not claim a week from fewer than seven buckets', async () => {
    fetchWithAuthMock.mockResolvedValue(json({
      series: [{ oid: 'x', instance: '1.1', name: 'prtMarkerLifeCount', points: [['2026-09-15', 30]] }],
    }));
    renderCard();
    const deltas = (await screen.findByTestId('network-detail-page-deltas')).textContent ?? '';
    expect(deltas).toContain('30');
    expect(deltas).not.toContain('week');
  });

  it('says the OIDs are not collected yet instead of rendering an empty card (pre-W02 agents)', () => {
    renderCard({
      ...xeroxCollection,
      oids: xeroxCollection.oids.map((entry) => ({ ...entry, state: 'unknown' as const, instances: [] })),
    });
    expect(screen.getByTestId('network-detail-health-unavailable').textContent).toContain('not been collected yet');
    expect(screen.getByTestId('network-detail-health-unavailable').textContent).toContain('update the agent');
    expect(screen.queryAllByTestId(/^network-detail-supply-/)).toHaveLength(0);
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('explains a missing template rather than an agent problem', () => {
    renderCard({ ...xeroxCollection, templateId: null, status: 'no_template', oids: [] });
    expect(screen.getByTestId('network-detail-health-no-template')).toBeInTheDocument();
    expect(screen.queryByTestId('network-detail-health-unavailable')).toBeNull();
  });
});


describe('PrinterHealth partial data and request changes', () => {
  it('shows collected faults even when no supplies or printer status were collected', () => {
    renderCard({
      ...xeroxCollection,
      oids: xeroxCollection.oids.filter((entry) =>
        entry.baseOid === PRINTER_OIDS.deviceStatus || entry.baseOid === PRINTER_OIDS.detectedErrorState),
    });
    expect(screen.queryByTestId('network-detail-health-unavailable')).toBeNull();
    expect(screen.getByTestId('network-detail-printer-status')).toHaveTextContent('Warning');
    expect(screen.getByTestId('network-detail-printer-errors')).toHaveTextContent('Supply missing');
  });

  it('hides previous asset deltas while loading a different asset', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(json(deltaSeries));
    const { rerender } = renderCard();
    expect(await screen.findByTestId('network-detail-page-deltas')).toHaveTextContent('420');
    fetchWithAuthMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    rerender(
      <PrinterHealth assetId="a2" assetType="printer" collection={xeroxCollection}
        snmpEnabled timezone="UTC" onSetUpMonitoring={vi.fn()} onViewMonitoring={vi.fn()} />,
    );
    expect(screen.queryByTestId('network-detail-page-deltas')).toBeNull();
  });
});

  it('shows Unknown and no meter for a negative level with known capacity', () => {
    renderCard({ ...xeroxCollection, oids: xeroxCollection.oids.map((entry) =>
      entry.baseOid === PRINTER_OIDS.suppliesLevel
        ? { ...entry, instances: entry.instances.map((row) => ({ ...row, value: '-2' })) }
        : entry,
    ) });
    const supply = screen.getByTestId('network-detail-supply-1.1');
    expect(supply).toHaveTextContent('Unknown');
    expect(supply.querySelector('[role="meter"]')).toBeNull();
  });

  it('mutes stale supplies and shows their age without a confident percentage', () => {
    const observedAt = '2026-09-15T10:00:00.000Z';
    renderCard({ ...xeroxCollection, oids: xeroxCollection.oids.map((entry) => ({
      ...entry, state: 'stale', observedAt,
    })) });
    const supply = screen.getByTestId('network-detail-supply-1.1');
    expect(supply).toHaveTextContent('Stale');
    expect(supply).toHaveTextContent(formatLastSeen(observedAt, 'UTC'));
    expect(supply).not.toHaveTextContent('37%');
    expect(supply.querySelector('[role="meter"] > div')).toHaveClass('bg-muted-foreground/30');
    const status = screen.getByTestId('network-detail-printer-status');
    expect(status).toHaveTextContent('Stale');
    expect(status).toHaveTextContent(formatLastSeen(observedAt, 'UTC'));
    expect(screen.getByTestId('network-detail-printer-errors')).toHaveTextContent('Stale');
  });
