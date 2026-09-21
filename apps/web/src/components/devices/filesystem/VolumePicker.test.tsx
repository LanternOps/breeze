import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import VolumePicker from './VolumePicker';
import type { FilesystemVolume } from './useFilesystemVolumes';

const volume = (overrides: Partial<FilesystemVolume> & { scanPath: string }): FilesystemVolume => ({
  mountPoint: overrides.scanPath, fsType: 'NTFS',
  totalGb: 500, usedGb: 400, freeGb: 100, usedPercent: 80, isOsRoot: false,
  scanState: null, latestSnapshot: null,
  ...overrides,
});

describe('VolumePicker', () => {
  it('renders one chip per volume, keyed on the scan path', () => {
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true }), volume({ scanPath: 'D:\\' })]}
        selectedScanPath={"C:\\"}
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    const chips = screen.getAllByTestId('volume-chip');
    expect(chips.map((chip) => chip.getAttribute('data-volume'))).toEqual(['C:\\', 'D:\\']);
  });

  it('marks the selected chip with aria-pressed so it is announced, not just coloured', () => {
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true }), volume({ scanPath: 'D:\\' })]}
        selectedScanPath={"D:\\"}
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    const chips = screen.getAllByTestId('volume-chip');
    expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('badges the OS volume', () => {
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true }), volume({ scanPath: 'D:\\' })]}
        selectedScanPath={"C:\\"}
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    expect(screen.getAllByTestId('volume-os-badge')).toHaveLength(1);
  });

  it('hands the scan path back on click', () => {
    const onSelect = vi.fn();
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true }), volume({ scanPath: 'D:\\' })]}
        selectedScanPath={"C:\\"}
        onSelect={onSelect}
        loading={false}
      />,
    );

    fireEvent.click(screen.getAllByTestId('volume-chip')[1]!);

    expect(onSelect).toHaveBeenCalledWith('D:\\');
  });

  it('says the capacity is unknown rather than rendering a fake 0%', () => {
    render(
      <VolumePicker
        volumes={[volume({ scanPath: 'C:\\', isOsRoot: true, totalGb: null, usedGb: null, freeGb: null, usedPercent: null })]}
        selectedScanPath={"C:\\"}
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    expect(screen.getByTestId('volume-capacity')).toHaveTextContent('Capacity unknown');
    expect(screen.queryByTestId('volume-usage-bar')).not.toBeInTheDocument();
  });

  it('distinguishes a never-scanned volume from a scanned one', () => {
    render(
      <VolumePicker
        volumes={[
          volume({ scanPath: 'C:\\', isOsRoot: true }),
          volume({ scanPath: 'D:\\', latestSnapshot: { id: 's', capturedAt: '2026-09-19T09:00:00.000Z', partial: false, cleanupEstimateBytes: 4096 } }),
        ]}
        selectedScanPath={"C:\\"}
        onSelect={vi.fn()}
        loading={false}
      />,
    );

    const chips = screen.getAllByTestId('volume-chip');
    expect(chips[0]!).toHaveTextContent('Never scanned');
    expect(chips[1]!).not.toHaveTextContent('Never scanned');
  });

  it('shows a loading state and an error state instead of an empty row', () => {
    const { rerender } = render(
      <VolumePicker volumes={[]} selectedScanPath="" onSelect={vi.fn()} loading />,
    );
    expect(screen.getByTestId('volume-picker-loading')).toBeInTheDocument();

    rerender(<VolumePicker volumes={[]} selectedScanPath="" onSelect={vi.fn()} loading={false} error="Failed to fetch volumes" />);
    const alert = screen.getByTestId('volume-picker-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Failed to fetch volumes');

    rerender(<VolumePicker volumes={[]} selectedScanPath="" onSelect={vi.fn()} loading={false} />);
    expect(screen.getByTestId('volume-picker-empty')).toBeInTheDocument();
  });
});
