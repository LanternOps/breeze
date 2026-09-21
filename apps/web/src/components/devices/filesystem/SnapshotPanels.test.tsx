import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SnapshotPanels from './SnapshotPanels';
import type { FilesystemSnapshot, ThresholdEvent } from './filesystemTabUtils';

const snapshot = (over: Partial<FilesystemSnapshot> = {}): FilesystemSnapshot => ({
  id: 'snap-1',
  capturedAt: '2026-09-19T10:00:00.000Z',
  trigger: 'on_demand',
  partial: false,
  scanPath: 'C:\\',
  scanMode: 'baseline',
  summary: {
    filesScanned: 1250,
    dirsScanned: 85,
    bytesScanned: 1024 * 1024 * 1024,
    maxDepthReached: 24,
    permissionDeniedCount: 12,
  },
  topLargestFiles: [{ path: 'C:\\big.iso', sizeBytes: 5 * 1024 * 1024 }],
  topLargestDirectories: [{ path: 'C:\\Windows', sizeBytes: 4 * 1024 * 1024, estimated: true }],
  tempAccumulation: [{ category: 'browser_cache', bytes: 2 * 1024 * 1024 }],
  oldDownloads: [{ path: 'C:\\old.zip', sizeBytes: 1 }],
  unrotatedLogs: [],
  trashUsage: [{ path: 'C:\\$Recycle.Bin', sizeBytes: 3 * 1024 * 1024 }],
  duplicateCandidates: [{ key: 'abc', sizeBytes: 1, count: 2 }],
  cleanupCandidates: [{ path: 'C:\\Windows\\Temp\\a', sizeBytes: 1 }],
  errors: [{ path: 'C:\\locked', error: 'denied' }],
  ...over,
});

const events: ThresholdEvent[] = [
  { id: 'e1', status: 'completed', createdAt: '2026-09-19T09:00:00.000Z', path: 'C:\\' },
];

describe('SnapshotPanels', () => {
  it('renders the scan summary counters', () => {
    render(<SnapshotPanels snapshot={snapshot()} thresholdEvents={events} />);
    const summary = screen.getByTestId('filesystem-scan-summary');
    expect(within(summary).getByText('Files scanned')).toBeInTheDocument();
    expect(within(summary).getByText('1,250')).toBeInTheDocument();
    expect(within(summary).getByText('24')).toBeInTheDocument();
  });

  it('pairs the cleanup-candidate count with its reclaimable size', () => {
    // Issue #6376: the tile reported a count and never a size.
    render(
      <SnapshotPanels
        snapshot={snapshot({ cleanupCandidates: [
          { path: 'C:\\Windows\\Temp\\a', sizeBytes: 1024 },
          { path: 'C:\\Windows\\Temp\\b', sizeBytes: 1024 },
        ] })}
        thresholdEvents={events}
      />,
    );
    // Assert the whole rendered line: `getByText(/2/)` alone would also match
    // the "2" inside "2.0 KB" and prove nothing about the count.
    expect(screen.getByTestId('filesystem-cleanup-candidates-tile')).toHaveTextContent('2 · 2.0 KB');
  });

  it('renders tempAccumulation, which the old tab collected and never showed', () => {
    render(<SnapshotPanels snapshot={snapshot()} thresholdEvents={events} />);
    const panel = screen.getByTestId('filesystem-temp-accumulation');
    expect(within(panel).getByText('Browser cache')).toBeInTheDocument();
    expect(within(panel).getByText('2.0 MB')).toBeInTheDocument();
  });

  it('shows the temp-accumulation empty state when the agent reported none', () => {
    render(<SnapshotPanels snapshot={snapshot({ tempAccumulation: [] })} thresholdEvents={events} />);
    expect(screen.getByText('No temp accumulation data.')).toBeInTheDocument();
  });

  it('marks an estimated directory size with a lower-bound glyph', () => {
    render(<SnapshotPanels snapshot={snapshot()} thresholdEvents={events} />);
    const dirs = screen.getByTestId('filesystem-largest-directories');
    const directory = within(dirs).getByTestId('filesystem-largest-directory-0');
    expect(within(directory).getByText('≥4.0 MB')).toBeInTheDocument();
  });

  it('renders the threshold triggers and their empty state', () => {
    const { rerender } = render(<SnapshotPanels snapshot={snapshot()} thresholdEvents={events} />);
    expect(screen.getByTestId('filesystem-threshold-event-e1')).toBeInTheDocument();

    rerender(<SnapshotPanels snapshot={snapshot()} thresholdEvents={[]} />);
    expect(screen.getByText('No recent threshold-triggered scans.')).toBeInTheDocument();
  });

  it('keys every list row on a stable id, never on an optional path', () => {
    // Two directories with no path at all must not collide into one React key.
    const withMissingPaths = snapshot({
      topLargestFiles: [{ sizeBytes: 2 }, { sizeBytes: 1 }],
    });
    expect(() => render(<SnapshotPanels snapshot={withMissingPaths} thresholdEvents={[]} />)).not.toThrow();
    expect(screen.getAllByTestId(/^filesystem-largest-file-/)).toHaveLength(2);
  });

  it('shows the partial-scan reason when the snapshot is partial', () => {
    render(
      <SnapshotPanels snapshot={snapshot({ partial: true, reason: 'max entries reached' })} thresholdEvents={[]} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('max entries reached');
  });
});
