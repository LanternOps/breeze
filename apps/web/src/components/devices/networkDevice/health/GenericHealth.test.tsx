import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GenericHealth } from './GenericHealth';
import type { Collection, CollectionOid } from '../types';

const AT = '2026-09-16T10:00:00.000Z';

function oid(overrides: Partial<CollectionOid> & { baseOid: string; name: string }): CollectionOid {
  return {
    mode: 'get',
    cadence: 'fast',
    state: 'collecting',
    observedAt: AT,
    instances: [{ oid: `${overrides.baseOid}.0`, instance: '', value: '42', valueType: 'integer', observedAt: AT }],
    error: null,
    ...overrides,
  };
}

const base: Collection = {
  templateId: 'tpl-1',
  lastPolledAt: AT,
  pollingInterval: 300,
  status: 'ok',
  consecutiveFailures: 0,
  oids: [
    oid({ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' }),
    oid({ baseOid: '1.3.6.1.2.1.1.5.0', name: 'sysName', instances: [{ oid: '1.3.6.1.2.1.1.5.0', instance: '', value: 'core-sw-01', valueType: 'string', observedAt: AT }] }),
  ],
};

function renderCard(collection: Collection | null = base, overrides: Record<string, unknown> = {}) {
  return render(
    <GenericHealth
      assetId="a1"
      assetType="switch"
      collection={collection}
      snmpEnabled
      timezone="UTC"
      onSetUpMonitoring={vi.fn()}
      onViewMonitoring={vi.fn()}
      {...overrides}
    />,
  );
}

describe('GenericHealth', () => {
  it('lists the template’s OIDs with their latest values', () => {
    renderCard();
    expect(screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.1.3.0').textContent).toContain('sysUpTime');
    expect(screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.1.5.0').textContent).toContain('core-sw-01');
  });

  it('caps the table and offers the full list on the Monitoring tab', async () => {
    const many: Collection = {
      ...base,
      oids: Array.from({ length: 12 }, (_, i) => oid({ baseOid: `1.3.6.1.2.1.99.${i}.0`, name: `metric${i}` })),
    };
    const onViewMonitoring = vi.fn();
    renderCard(many, { onViewMonitoring });
    expect(screen.getAllByTestId(/^network-detail-health-row-/)).toHaveLength(8);
    await userEvent.click(screen.getByTestId('network-detail-health-view-all'));
    expect(onViewMonitoring).toHaveBeenCalledTimes(1);
  });

  it('explains an unsupported OID with its error code instead of a blank cell', () => {
    renderCard({
      ...base,
      oids: [oid({ baseOid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', state: 'unsupported', error: 'noSuchObject', instances: [] })],
    });
    const row = screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.43.11.1.1.9');
    expect(row.textContent).toContain('Unsupported');
    expect(row.textContent).toContain('noSuchObject');
  });

  it('names the agent update as the fix for an unknown table OID', () => {
    renderCard({
      ...base,
      oids: [oid({ baseOid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', state: 'unknown', instances: [] })],
    });
    expect(screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.2.2.1.2').textContent)
      .toContain('update the agent');
  });

  it('explains a missing template and offers the fix instead of an empty table', async () => {
    const onSetUpMonitoring = vi.fn();
    renderCard({ ...base, templateId: null, status: 'no_template', oids: [] }, { onSetUpMonitoring });
    expect(screen.queryByTestId(/^network-detail-health-row-/)).toBeNull();
    expect(screen.getByTestId('network-detail-health-no-template').textContent).toContain('no template');
    await userEvent.click(screen.getByTestId('network-detail-health-pick-template'));
    expect(onSetUpMonitoring).toHaveBeenCalledTimes(1);
  });

  it('renders an accessible unknown for an OID with no value yet', () => {
    renderCard({ ...base, oids: [oid({ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', state: 'never_polled', instances: [] })] });
    const row = screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.1.3.0');
    expect(row.querySelector('[aria-label]')).toHaveAttribute('aria-label', 'Unknown');
  });
});
