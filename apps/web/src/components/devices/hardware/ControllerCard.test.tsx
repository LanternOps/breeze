import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ControllerCard, { PhysicalDisksTable } from './ControllerCard';
import { component } from './hardwareHealth.fixtures';
const vd = component({ componentKey: 'storcli:c0:v0', parentKey: 'storcli:c0',
  name: 'VD 0', componentType: 'virtual_disk', state: 'rebuilding', health: 'warning',
  sizeBytes: 1024 ** 4, progressPercent: 42, attributes: { raidLevel: 'RAID-10' } });
const pd = component({ componentKey: 'storcli:c0:e1:s3', parentKey: vd.componentKey,
  componentType: 'physical_disk', name: 'Slot 3', model: 'Drive Model', serial: 'DISK-3',
  state: 'failed', health: 'critical', stale: true, fresh: false,
  temperatureC: 33, attributes: { slot: 3, mediaType: 'SSD', interface: 'SAS',
    mediaErrors: 0, otherErrors: 2,
    smart: { observedAt: '2026-09-23T12:00:00Z', powerOnHours: 2000 } } });
describe('ControllerCard', () => {
  it('shows hierarchy, zero counters, battery, enclosure and rebuild progress', () => {
    render(<ControllerCard controller={component()} components={[vd, pd,
      component({ componentKey: 'storcli:c0:bbu', parentKey: 'storcli:c0',
        componentType: 'cache_battery', name: 'BBU', state: 'learning' }),
      component({ componentKey: 'storcli:c0:enc1', parentKey: 'storcli:c0',
        componentType: 'enclosure', name: 'Enclosure 1' }),
    ]} />);
    expect(screen.getByTestId('hardware-controller-card')).toHaveTextContent('CTRL-1');
    expect(screen.getByText('RAID-10')).toBeInTheDocument();
    expect(screen.getByText('learning')).toBeInTheDocument();
    expect(screen.getByText('Enclosures: 1')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '42');
    expect(screen.getByText('DISK-3')).toBeInTheDocument();
    expect(screen.getByTestId(`hardware-disk-${pd.componentKey}`)).toHaveClass('opacity-60');
    expect(screen.getByText(/Not seen since/)).toBeInTheDocument();
    expect(screen.getByText('33 °C / 0 / 2 / 2000')).toBeInTheDocument();
  });
  it('renders zero percent and greys expired but non-stale rows', () => {
    render(<ControllerCard controller={component()} components={[
      { ...vd, progressPercent: 0 }, { ...pd, stale: false, fresh: false },
    ]} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0');
    expect(screen.getByTestId(`hardware-disk-${pd.componentKey}`)).toHaveClass('opacity-60');
  });
  it('does not dim a fresh, non-stale disk row', () => {
    const healthyDisk = component({ componentKey: 'storcli:c0:e1:s4', parentKey: 'storcli:c0',
      componentType: 'physical_disk', name: 'Slot 4', serial: 'DISK-4', stale: false, fresh: true });
    render(<ControllerCard controller={component()} components={[healthyDisk]} />);
    expect(screen.getByTestId(`hardware-disk-${healthyDisk.componentKey}`)).not.toHaveClass('opacity-60');
    expect(screen.queryByText(/Not seen since/)).not.toBeInTheDocument();
  });
  it('does not include disks belonging to another controller', () => {
    render(<ControllerCard controller={component()} components={[
      { ...pd, parentKey: 'storcli:c1', serial: 'OTHER' },
    ]} />);
    expect(screen.queryByText('OTHER')).not.toBeInTheDocument();
  });
  it.each([
    ['reported hours', { observedAt: '2026-09-23T12:00:00Z', powerOnHours: 2000 }, '2000'],
    ['zero hours', { observedAt: '2026-09-23T12:00:00Z', powerOnHours: 0 }, '0'],
    ['absent evidence', undefined, '—'],
    ['null evidence', null, '—'],
    ['non-object evidence', 'unavailable', '—'],
    ['missing hours', { observedAt: '2026-09-23T12:00:00Z' }, '—'],
  ])('renders standalone SMART %s', (_label, smart, expected) => {
    const disk = component({ componentType: 'physical_disk', componentKey: 'smart:DISK-3',
      source: 'smartctl', parentKey: null, temperatureC: 33,
      attributes: { mediaErrors: 0, otherErrors: 2,
        ...(smart === undefined ? {} : { smart }) } });
    render(<PhysicalDisksTable disks={[disk]} />);
    expect(screen.getByText(`33 °C / 0 / 2 / ${expected}`)).toBeInTheDocument();
  });
});
