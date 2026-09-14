// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LifecycleStatusBar } from './LifecycleStatusBar';
import { buildAtAGlanceFacts } from '@breeze/shared';
import type { HardwareLifecycleDeviceRow } from '@breeze/shared';

function row(partial: Partial<HardwareLifecycleDeviceRow> & { name: string }): HardwareLifecycleDeviceRow {
  return {
    id: partial.name, kind: 'device', os: 'Windows 11 Pro', osSupport: 'supported',
    purchaseDate: null, purchaseDateSource: null, warrantyEndDate: null, ageYears: null,
    replaceBy: null, replacement: 'unknown', warrantyExtended: false, lifeUsed: null,
    ...partial,
  };
}

const SAM4 = row({ name: 'SAM4', user: 'CORP\\sam.lee', manufacturer: 'Dell Inc.', model: 'OptiPlex 3050', serialNumber: '255P3W2', os: 'Windows 10 Pro', osSupport: 'ended', purchaseDate: '2019-04-01', purchaseDateSource: 'manual', warrantyEndDate: '2022-04-01', ageYears: 7.1, replaceBy: '2023-04-01', replacement: 'replace', lifeUsed: 1 });
const LAW_SRV = row({ name: 'LAW-SRV', deviceKind: 'server', manufacturer: 'Dell Inc.', model: 'PowerEdge T340', os: 'Windows Server 2019', osSupport: 'ending', purchaseDate: '2021-10-01', purchaseDateSource: 'vendor', warrantyEndDate: '2026-11-30', ageYears: 4.7, replaceBy: '2026-11-30', replacement: 'due_soon', warrantyExtended: true, lifeUsed: 0.9 });
const MACBOOK_AIR = row({ name: 'MacBook-Air.local', manufacturer: 'Apple Inc.', os: 'macOS 26.3.1' });

describe('LifecycleStatusBar', () => {
  it('renders a segment per non-empty band and the at-a-glance fact', () => {
    const rows = [SAM4, LAW_SRV, MACBOOK_AIR];
    expect(buildAtAGlanceFacts(rows)).not.toBe('');

    render(<LifecycleStatusBar rows={rows} />);

    expect(screen.getByTestId('lifecycle-status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('lifecycle-status-segment-replace')).toHaveTextContent('1');
    expect(screen.getByTestId('lifecycle-status-segment-due_soon')).toHaveTextContent('1');
    expect(screen.getByTestId('lifecycle-status-segment-unknown')).toHaveTextContent('1');
    expect(screen.queryByTestId('lifecycle-status-segment-supported')).toBeNull();
    expect(screen.getByTestId('lifecycle-status-fact')).toHaveTextContent(buildAtAGlanceFacts(rows));
  });

  it('renders no fact paragraph for an all-supported fleet with nothing to add', () => {
    const rows: HardwareLifecycleDeviceRow[] = [
      row({ name: 'A', replacement: 'supported', osSupport: 'supported' }),
      row({ name: 'B', replacement: 'supported', osSupport: 'supported' }),
    ];
    expect(buildAtAGlanceFacts(rows)).toBe('');

    render(<LifecycleStatusBar rows={rows} />);

    expect(screen.getByTestId('lifecycle-status-segment-supported')).toHaveTextContent('2');
    expect(screen.queryByTestId('lifecycle-status-fact')).toBeNull();
  });
});
