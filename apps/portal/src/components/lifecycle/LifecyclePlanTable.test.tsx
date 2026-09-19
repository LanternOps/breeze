// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HardwareLifecycleDeviceRow } from '@breeze/shared';
import { LifecyclePlanTable } from './LifecyclePlanTable';

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

const MANUAL_ASSET = row({
  name: 'PRINTER1',
  kind: 'manual_asset',
  manufacturer: 'HP',
  model: 'LaserJet Pro',
});

describe('LifecyclePlanTable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the Computer, OS risk tag, Age, Purchased, Warranty and Status cells', () => {
    render(
      <LifecyclePlanTable
        sectionId="workstations"
        title="Workstations and laptops"
        ruleSentence="We plan to replace a computer 4 years after purchase, or when its warranty ends if it is still covered past that point."
        rows={[SAM4, MACBOOK_AIR]}
      />,
    );

    const table = screen.getByTestId('lifecycle-plan-table-workstations');
    expect(table).toHaveTextContent('We plan to replace a computer 4 years after purchase');

    const sam4Row = screen.getByTestId('lifecycle-plan-row-SAM4');
    expect(sam4Row).toHaveTextContent('Sam Lee');
    expect(sam4Row).toHaveTextContent('OptiPlex 3050');
    expect(sam4Row).toHaveTextContent('No security updates');
    expect(sam4Row).toHaveTextContent('7 yr');
    expect(sam4Row).toHaveTextContent('Apr 2019');
    expect(sam4Row).toHaveTextContent('Expired Apr 2022');
    expect(sam4Row).toHaveTextContent('Replace now');

    const macRow = screen.getByTestId('lifecycle-plan-row-MacBook-Air.local');
    expect(macRow).toHaveTextContent('Purchase date unknown');
  });

  it('shows a "Support ending" risk tag for osSupport ending', () => {
    render(
      <LifecyclePlanTable
        sectionId="servers"
        title="Servers"
        ruleSentence="We plan to replace a server 5 years after purchase, or when its warranty ends if it is still covered past that point. Server replacements are scheduled outside your business hours."
        rows={[LAW_SRV]}
      />,
    );
    const lawSrvRow = screen.getByTestId('lifecycle-plan-row-LAW-SRV');
    expect(lawSrvRow).toHaveTextContent('Support ending');
    expect(lawSrvRow).toHaveTextContent('Oct 2021 *');
  });

  it('renders a legend dot per non-zero band, counted from this table\'s own rows', () => {
    render(
      <LifecyclePlanTable
        sectionId="workstations"
        title="Workstations and laptops"
        ruleSentence="rule sentence"
        rows={[SAM4, MACBOOK_AIR]}
      />,
    );
    const legend = screen.getByTestId('lifecycle-plan-legend-workstations');
    expect(legend).toHaveTextContent('Replace now');
    expect(legend).toHaveTextContent('Purchase date unknown');
    expect(legend).not.toHaveTextContent('Due soon');
    expect(legend).not.toHaveTextContent('On track');
  });

  it('shows the vendor-sourced footnote only when a row has a vendor purchase date', () => {
    const { rerender } = render(
      <LifecyclePlanTable
        sectionId="servers"
        title="Servers"
        ruleSentence="rule sentence"
        rows={[LAW_SRV]}
      />,
    );
    expect(screen.getByTestId('lifecycle-plan-footnote-servers')).toHaveTextContent(
      "Purchase date taken from the manufacturer's ship record.",
    );

    rerender(
      <LifecyclePlanTable
        sectionId="servers"
        title="Servers"
        ruleSentence="rule sentence"
        rows={[SAM4]}
      />,
    );
    expect(screen.queryByTestId('lifecycle-plan-footnote-servers')).toBeNull();
  });

  it('delegates the Replacement timeline column to TimelineCell', () => {
    render(
      <LifecyclePlanTable
        sectionId="workstations"
        title="Workstations and laptops"
        ruleSentence="rule sentence"
        rows={[SAM4]}
      />,
    );
    expect(screen.getByTestId('lifecycle-timeline-cell')).toBeInTheDocument();
  });

  it('links a device row\'s Computer cell to /devices#<id>', () => {
    render(
      <LifecyclePlanTable
        sectionId="workstations"
        title="Workstations and laptops"
        ruleSentence="rule sentence"
        rows={[SAM4]}
      />,
    );
    const link = screen.getByTestId('lifecycle-plan-row-link-SAM4');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/devices#SAM4');
    expect(link).toHaveTextContent('Sam Lee');
  });

  it('renders a manual asset\'s Computer cell as plain text, never a link', () => {
    render(
      <LifecyclePlanTable
        sectionId="workstations"
        title="Workstations and laptops"
        ruleSentence="rule sentence"
        rows={[MANUAL_ASSET]}
      />,
    );
    expect(screen.queryByTestId('lifecycle-plan-row-link-PRINTER1')).toBeNull();
    expect(screen.getByTestId('lifecycle-plan-row-PRINTER1')).toHaveTextContent('LaserJet Pro');
  });

  // #5880: /portal/devices redirects home when the org's self-service flag is
  // off, so a device row's Computer cell must never link there in that case —
  // it would silently drop the customer on Proposals with no explanation.
  it('renders a device row\'s Computer cell as plain text, never a link, when self-service is off', () => {
    render(
      <LifecyclePlanTable
        sectionId="workstations"
        title="Workstations and laptops"
        ruleSentence="rule sentence"
        rows={[SAM4]}
        enableSelfService={false}
      />,
    );
    expect(screen.queryByTestId('lifecycle-plan-row-link-SAM4')).toBeNull();
    const row = screen.getByTestId('lifecycle-plan-row-SAM4');
    expect(row).toHaveTextContent('Sam Lee');
  });

  it('still links a device row\'s Computer cell when self-service is explicitly on', () => {
    render(
      <LifecyclePlanTable
        sectionId="workstations"
        title="Workstations and laptops"
        ruleSentence="rule sentence"
        rows={[SAM4]}
        enableSelfService={true}
      />,
    );
    const link = screen.getByTestId('lifecycle-plan-row-link-SAM4');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/devices#SAM4');
  });
});
