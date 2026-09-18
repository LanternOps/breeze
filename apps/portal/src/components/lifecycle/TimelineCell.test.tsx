// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HardwareLifecycleDeviceRow } from '@breeze/shared';
import { TimelineCell } from './TimelineCell';

function row(
  partial: Partial<HardwareLifecycleDeviceRow> & { name: string },
): HardwareLifecycleDeviceRow {
  return {
    id: partial.name,
    kind: 'device',
    os: 'Windows 11 Pro',
    osSupport: 'supported',
    purchaseDate: null,
    purchaseDateSource: null,
    warrantyEndDate: null,
    ageYears: null,
    replaceBy: null,
    replacement: 'unknown',
    warrantyExtended: false,
    lifeUsed: null,
    ...partial,
  };
}

const SAM4 = row({
  name: 'SAM4',
  user: 'CORP\\sam.lee',
  manufacturer: 'Dell Inc.',
  model: 'OptiPlex 3050',
  serialNumber: '255P3W2',
  os: 'Windows 10 Pro',
  osSupport: 'ended',
  purchaseDate: '2019-04-01',
  purchaseDateSource: 'manual',
  warrantyEndDate: '2022-04-01',
  ageYears: 7.1,
  replaceBy: '2023-04-01',
  replacement: 'replace',
  lifeUsed: 1,
});

const LAW_SRV = row({
  name: 'LAW-SRV',
  deviceKind: 'server',
  manufacturer: 'Dell Inc.',
  model: 'PowerEdge T340',
  os: 'Windows Server 2019',
  osSupport: 'ending',
  purchaseDate: '2021-10-01',
  purchaseDateSource: 'vendor',
  warrantyEndDate: '2026-11-30',
  ageYears: 4.7,
  replaceBy: '2026-11-30',
  replacement: 'due_soon',
  warrantyExtended: true,
  lifeUsed: 0.9,
});

const MACBOOK_AIR = row({ name: 'MacBook-Air.local', manufacturer: 'Apple Inc.', os: 'macOS 26.3.1' });

const SYNTHETIC_DUE_THIS_WEEK = row({
  name: 'NOW1',
  manufacturer: 'Dell Inc.',
  model: 'Latitude 5420',
  os: 'Windows 11 Pro',
  purchaseDate: '2026-01-10',
  purchaseDateSource: 'manual',
  replaceBy: '2026-06-10',
  replacement: 'replace',
});

// Due more than 3 years out (beyond the grid's TIMELINE_QUARTERS window):
// the grid can't show the quarter, so the label has to say "far out" in words.
const FAR_OUT_SUPPORTED = row({
  name: 'FAR1',
  manufacturer: 'Lenovo',
  model: 'ThinkPad T14',
  os: 'Windows 11 Pro',
  purchaseDate: '2026-01-01',
  purchaseDateSource: 'manual',
  replaceBy: '2030-01-01',
  replacement: 'supported',
});

// A replace-by date with no purchase record (warranty-derived, no purchase
// history): the planned-life tint should run from the grid's left edge, not
// from some finite "bought" quarter.
const UNKNOWN_PURCHASE_KNOWN_DUE = row({
  name: 'NOPURCHASE1',
  manufacturer: 'HP',
  model: 'EliteDesk 800',
  os: 'Windows 11 Pro',
  purchaseDate: null,
  replaceBy: '2027-06-01',
  replacement: 'due_soon',
});

describe('TimelineCell', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a solid overdue run through today with an "N yr over" label for SAM4', () => {
    render(<TimelineCell row={SAM4} />);
    const grid = screen.getByTestId('lifecycle-timeline-grid');
    expect(grid).toBeInTheDocument();
    // Quarters 0..8 (todayQ) should be the solid overdue tone.
    for (let q = 0; q <= 8; q += 1) {
      expect(screen.getByTestId(`lifecycle-timeline-quarter-${q}`).className).toContain('bg-destructive');
      expect(screen.getByTestId(`lifecycle-timeline-quarter-${q}`).className).not.toContain('/');
    }
    expect(screen.getByTestId('lifecycle-timeline-label')).toHaveTextContent(/yr over/);
  });

  it('renders a tinted planned-life run to a solid due quarter with no label for LAW-SRV', () => {
    render(<TimelineCell row={LAW_SRV} />);
    // boughtQ ~ -10 (before grid), dueQ = 10: quarters 0..9 tinted, quarter 10 solid.
    for (let q = 0; q <= 9; q += 1) {
      expect(screen.getByTestId(`lifecycle-timeline-quarter-${q}`).className).toContain('bg-warning/');
    }
    expect(screen.getByTestId('lifecycle-timeline-quarter-10').className).toContain('bg-warning');
    expect(screen.getByTestId('lifecycle-timeline-quarter-10').className).not.toContain('bg-warning/');
    expect(screen.queryByTestId('lifecycle-timeline-label')).toBeNull();
  });

  it('renders no grid and no label for MacBook-Air (no dates)', () => {
    render(<TimelineCell row={MACBOOK_AIR} />);
    expect(screen.queryByTestId('lifecycle-timeline-grid')).toBeNull();
    expect(screen.queryByTestId('lifecycle-timeline-label')).toBeNull();
  });

  it('renders the "now" label for a row purchased and due this week', () => {
    render(<TimelineCell row={SYNTHETIC_DUE_THIS_WEEK} />);
    expect(screen.getByTestId('lifecycle-timeline-label')).toHaveTextContent('now');
  });

  it('renders an "N yr out" label when the due date falls beyond the drawn grid', () => {
    render(<TimelineCell row={FAR_OUT_SUPPORTED} />);
    expect(screen.getByTestId('lifecycle-timeline-label')).toHaveTextContent(/yr out/);
  });

  it('tints the whole planned-life run from the grid\'s left edge when purchase date is unknown but due date is known', () => {
    render(<TimelineCell row={UNKNOWN_PURCHASE_KNOWN_DUE} />);
    // dueQ = 12 for this fixture; boughtQ is -Infinity, so quarters 0..11 are
    // all tinted (not just some finite run starting mid-grid).
    for (let q = 0; q <= 11; q += 1) {
      expect(screen.getByTestId(`lifecycle-timeline-quarter-${q}`).className).toContain('bg-warning/');
    }
    expect(screen.getByTestId('lifecycle-timeline-quarter-12').className).toContain('bg-warning');
    expect(screen.getByTestId('lifecycle-timeline-quarter-12').className).not.toContain('bg-warning/');
    expect(screen.queryByTestId('lifecycle-timeline-label')).toBeNull();
  });

  it('gives every quarter cell a hover title with its quarter label', () => {
    render(<TimelineCell row={LAW_SRV} />);
    for (let q = 0; q < 20; q += 1) {
      const title = screen.getByTestId(`lifecycle-timeline-quarter-${q}`).getAttribute('title');
      expect(title).toMatch(/^Q[1-4] \d{4}$/);
    }
    // System time is fixed at 2026-06-10 (Q2 2026); todayQ = 8.
    expect(screen.getByTestId('lifecycle-timeline-quarter-0').getAttribute('title')).toBe('Q2 2024');
    expect(screen.getByTestId('lifecycle-timeline-quarter-8').getAttribute('title')).toBe('Q2 2026');
    expect(screen.getByTestId('lifecycle-timeline-quarter-19').getAttribute('title')).toBe('Q1 2029');
  });
});
