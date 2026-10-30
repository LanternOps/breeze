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

function renderStrip(overrides: Partial<Parameters<typeof NetworkDeviceStats>[0]> = {}) {
  return render(
    <NetworkDeviceStats
      asset={asset}
      reachability={reachability}
      collection={supplyCollection}
      onViewPorts={vi.fn()}
      {...overrides}
    />,
  );
}

describe('NetworkDeviceStats', () => {
  it('does not restate the reachability verdict or the poll age — the header badge and the card own those', () => {
    // The strip used to carry "Responding · SNMP 2 min ago" and "Polling ·
    // 3 min ago" directly under a header badge that said the same thing, and
    // above a card that said it twice more.
    renderStrip();
    expect(screen.queryByTestId('network-detail-stat-reachability')).toBeNull();
    expect(screen.queryByTestId('network-detail-stat-last-poll')).toBeNull();
    expect(screen.getByTestId('network-detail-stats').textContent).not.toMatch(/\bmin\b/);
  });

  it('fills the printer type slot with the lowest supply', () => {
    renderStrip();
    const slot = screen.getByTestId('network-detail-stat-type').textContent ?? '';
    expect(slot).toContain('Cyan Toner');
    expect(slot).toContain('12');
    expect(slot).not.toContain('78'); // the lowest supply, not the first one
  });

  it('links the open-port count through to the ports view', async () => {
    const onViewPorts = vi.fn();
    renderStrip({ onViewPorts });
    expect(screen.getByTestId('network-detail-stat-ports').textContent).toContain('2');
    await userEvent.click(screen.getByTestId('network-detail-stat-ports'));
    expect(onViewPorts).toHaveBeenCalledTimes(1);
  });

  it('still renders every cell when the API sent no reachability and no collection', () => {
    renderStrip({ reachability: null, collection: null });
    expect(screen.getByTestId('network-detail-stat-type')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-stat-ports').textContent).toContain('2');
  });
});
