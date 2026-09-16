import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NetworkDeviceStats } from './NetworkDeviceStats';
import type { Collection, Reachability } from './types';
import type { DiscoveredAsset } from '../../discovery/DiscoveredAssetList';

const asset = {
  id: 'a1', ip: '10.0.0.9', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'prn-01', type: 'printer',
  approvalStatus: 'approved', isOnline: true, manufacturer: 'Xerox', responseTimeMs: 3.1,
  openPorts: [{ port: 9100, service: 'jetdirect' }, { port: 443, service: 'https' }],
} as unknown as DiscoveredAsset;

const reachability: Reachability = {
  state: 'responding', source: 'snmp',
  observedAt: new Date(Date.now() - 120_000).toISOString(),
  lastKnown: null,
  detail: { snmp: { state: 'ok', observedAt: new Date(Date.now() - 120_000).toISOString(), consecutiveFailures: 0 } },
};

const AT = '2026-09-16T10:00:00.000Z';

function supplyOid(baseOid: string, name: string, rows: Array<[string, string]>) {
  return {
    baseOid,
    name,
    mode: 'walk' as const,
    cadence: 'fast' as const,
    state: 'collecting' as const,
    observedAt: AT,
    error: null,
    instances: rows.map(([instance, value]) => ({
      oid: `${baseOid}.${instance}`,
      instance,
      value,
      valueType: 'integer',
      observedAt: AT,
    })),
  };
}

const supplyCollection: Collection = {
  templateId: 'tpl',
  lastPolledAt: new Date(Date.now() - 180_000).toISOString(),
  pollingInterval: 300,
  status: 'ok',
  consecutiveFailures: 0,
  oids: [
    supplyOid('1.3.6.1.2.1.43.11.1.1.6', 'prtMarkerSuppliesDescription', [
      ['1.1', 'Cyan Toner'],
      ['1.2', 'Black Toner'],
    ]),
    supplyOid('1.3.6.1.2.1.43.11.1.1.8', 'prtMarkerSuppliesMaxCapacity', [
      ['1.1', '100'],
      ['1.2', '100'],
    ]),
    supplyOid('1.3.6.1.2.1.43.11.1.1.9', 'prtMarkerSuppliesLevel', [
      ['1.1', '12'],
      ['1.2', '78'],
    ]),
  ],
};

const probeState = { checking: false, pending: false, errorCode: null, checkNow: vi.fn() };

function renderStrip(overrides: Partial<Parameters<typeof NetworkDeviceStats>[0]> = {}) {
  return render(
    <NetworkDeviceStats
      asset={asset}
      reachability={reachability}
      collection={supplyCollection}
      timezone="UTC"
      probeState={probeState}
      onViewPorts={vi.fn()}
      onViewMonitoring={vi.fn()}
      {...overrides}
    />,
  );
}

describe('NetworkDeviceStats', () => {
  it('names the reachability source and age, never a bare state', () => {
    renderStrip();
    const cell = screen.getByTestId('network-detail-stat-reachability').textContent ?? '';
    expect(cell).toContain('Responding');
    expect(cell).toContain('SNMP');
    expect(cell).toMatch(/2\s*min/);
  });

  it('shows the last poll with its status word and links to the Monitoring tab', async () => {
    const onViewMonitoring = vi.fn();
    renderStrip({ onViewMonitoring });
    expect(screen.getByTestId('network-detail-stat-last-poll').textContent).toContain('Polling');
    await userEvent.click(screen.getByTestId('network-detail-stat-last-poll'));
    expect(onViewMonitoring).toHaveBeenCalledTimes(1);
  });

  it('fills the printer type slot with the lowest supply', () => {
    renderStrip();
    const slot = screen.getByTestId('network-detail-stat-type').textContent ?? '';
    expect(slot).toContain('Cyan Toner');
    expect(slot).toContain('12');
    expect(slot).not.toContain('78'); // the lowest supply, not the first one
  });

  it('calls the probe and renders a pending line while it is in flight', async () => {
    const checkNow = vi.fn().mockResolvedValue(undefined);
    const view = renderStrip({ probeState: { checking: false, pending: false, errorCode: null, checkNow } });
    await userEvent.click(screen.getByTestId('network-detail-check-now'));
    expect(checkNow).toHaveBeenCalledTimes(1);
    view.unmount();
    renderStrip({ probeState: { checking: false, pending: true, errorCode: null, checkNow } });
    expect(screen.getByTestId('network-detail-check-now')).toBeDisabled();
    expect(screen.getByTestId('network-detail-probe-status').textContent).toContain('Checking');
  });

  it('renders a probe failure as an inline line under the reachability cell', () => {
    renderStrip({ probeState: { checking: false, pending: false, errorCode: 'NO_AGENT_IN_SITE', checkNow: vi.fn() } });
    const line = screen.getByTestId('network-detail-probe-error');
    expect(line).toHaveAttribute('role', 'status');
    expect(line.textContent).toContain('No online agent');
  });

  it('still renders every cell when the API sent no reachability and no collection', () => {
    renderStrip({ reachability: null, collection: null });
    expect(screen.getByTestId('network-detail-stat-reachability').textContent).toContain('Unverified');
    expect(screen.getByTestId('network-detail-stat-last-poll').textContent).toContain('Not configured');
    expect(screen.getByTestId('network-detail-stat-ports').textContent).toContain('2');
  });
});
