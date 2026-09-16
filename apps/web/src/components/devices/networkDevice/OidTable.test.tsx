import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { OidTable } from './OidTable';
import type { Collection, CollectionOid } from './types';

const AT = new Date(Date.now() - 4 * 60_000).toISOString();

function entry(overrides: Partial<CollectionOid> & { baseOid: string; name: string }): CollectionOid {
  return {
    mode: 'get', cadence: 'fast', state: 'collecting', observedAt: AT, instances: [], error: null, ...overrides,
  };
}

const collection: Collection = {
  templateId: 'tpl-1', lastPolledAt: AT, pollingInterval: 300, status: 'ok', consecutiveFailures: 0,
  oids: [
    entry({ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', instances: [{ oid: '1.3.6.1.2.1.1.3.0', instance: '', value: '884512', valueType: 'timeticks', observedAt: AT }] }),
    entry({
      baseOid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', mode: 'walk',
      instances: [
        { oid: '1.3.6.1.2.1.43.11.1.1.9.1.1', instance: '1.1', value: '37', valueType: 'integer', observedAt: AT },
        { oid: '1.3.6.1.2.1.43.11.1.1.9.1.2', instance: '1.2', value: '82', valueType: 'integer', observedAt: AT },
      ],
    }),
    entry({ baseOid: '1.3.6.1.2.1.25.3.5.1.1', name: 'hrPrinterStatus', mode: 'walk', state: 'unsupported', error: 'noSuchObject' }),
    entry({ baseOid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', state: 'unknown' }),
    entry({ baseOid: '1.3.6.1.2.1.2.2.1.10', name: 'ifInOctets', mode: 'walk', state: 'collecting', error: 'truncated' }),
  ],
};

describe('OidTable', () => {
  it('renders a row per OID with its mode, state, latest value and age', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    const row = screen.getByTestId('network-detail-oid-row-1.3.6.1.2.1.1.3.0');
    expect(row.textContent).toContain('sysUpTime');
    expect(row.textContent).toContain('1.3.6.1.2.1.1.3.0');
    expect(row.textContent).toContain('get');
    expect(row.textContent).toContain('Collecting');
    expect(row.textContent).toContain('884512');
    expect(row.textContent).toMatch(/4\s*min/);
  });

  it('hides instance rows until the OID is expanded', async () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    expect(screen.queryByTestId('network-detail-oid-instance-1.1')).toBeNull();

    const toggle = screen.getByTestId('network-detail-oid-toggle-1.3.6.1.2.1.43.11.1.1.9');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('network-detail-oid-instance-1.1').textContent).toContain('37');
    expect(screen.getByTestId('network-detail-oid-instance-1.2').textContent).toContain('82');
  });

  it('points aria-controls at the instance container it actually toggles', async () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    const toggle = screen.getByTestId('network-detail-oid-toggle-1.3.6.1.2.1.43.11.1.1.9');
    await userEvent.click(toggle);
    const controls = toggle.getAttribute('aria-controls')!;
    expect(document.getElementById(controls)).not.toBeNull();
  });

  it('offers no toggle for a scalar OID with a single unnamed instance', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    expect(screen.queryByTestId('network-detail-oid-toggle-1.3.6.1.2.1.1.3.0')).toBeNull();
  });

  it('shows the error code on an unsupported OID', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    const row = screen.getByTestId('network-detail-oid-row-1.3.6.1.2.1.25.3.5.1.1');
    expect(row.textContent).toContain('Unsupported');
    expect(row.textContent).toContain('noSuchObject');
  });

  it('names the agent update as the fix for an unknown table OID', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-oid-row-1.3.6.1.2.1.2.2.1.2').textContent)
      .toContain('update the agent');
  });

  it('flags a truncated walk as partial rather than complete', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-oid-row-1.3.6.1.2.1.2.2.1.10').textContent).toContain('Partial');
  });

  it('explains a missing template instead of rendering an empty table', () => {
    render(<OidTable collection={{ ...collection, templateId: null, status: 'no_template', oids: [] }} timezone="UTC" />);
    expect(screen.queryByTestId('network-detail-oid-table')).toBeNull();
    expect(screen.getByTestId('network-detail-oid-no-template')).toBeInTheDocument();
  });

  it('says SNMP is not configured when there is no collection at all', () => {
    render(<OidTable collection={null} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-oid-not-configured')).toBeInTheDocument();
  });
});
