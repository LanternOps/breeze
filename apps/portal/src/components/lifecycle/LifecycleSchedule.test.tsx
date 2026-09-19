// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LifecycleSchedule } from './LifecycleSchedule';
import { buildReplacementSchedule } from '@breeze/shared';
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

describe('LifecycleSchedule', () => {
  it('renders a group per schedule bucket, including Now and a quarter label', () => {
    const rows = [SAM4, LAW_SRV, MACBOOK_AIR];
    const groups = buildReplacementSchedule(rows);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.some((g) => g.label === 'Now')).toBe(true);

    render(<LifecycleSchedule rows={rows} />);

    expect(screen.getByTestId('lifecycle-schedule')).toBeInTheDocument();
    const nowIndex = groups.findIndex((g) => g.label === 'Now');
    expect(screen.getByTestId(`lifecycle-schedule-group-${nowIndex}`)).toHaveTextContent('Now');
    expect(screen.getByTestId(`lifecycle-schedule-group-${nowIndex}`)).toHaveTextContent('SAM4');

    const quarterIndex = groups.findIndex((g) => g.label === 'Q4 2026');
    expect(quarterIndex).toBeGreaterThanOrEqual(0);
    expect(screen.getByTestId(`lifecycle-schedule-group-${quarterIndex}`)).toHaveTextContent('Q4 2026');
    expect(screen.getByTestId(`lifecycle-schedule-group-${quarterIndex}`)).toHaveTextContent('LAW-SRV');
  });

  it('renders nothing when the schedule has no groups', () => {
    const rows: HardwareLifecycleDeviceRow[] = [];
    expect(buildReplacementSchedule(rows)).toEqual([]);

    const { container } = render(<LifecycleSchedule rows={rows} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('lifecycle-schedule')).toBeNull();
  });
});
