// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ReportPreview from './ReportPreview';

/**
 * Staff preview for the Backup Status report (#6013 W05). The stored summary is
 * the whole snapshot (rows with a 28-day history each, buckets, options), so
 * the generic key/value summary cards would print it as JSON. The designed
 * tiles count health instead.
 */

function previewData(summary: Record<string, unknown>) {
  return {
    type: 'backup_status' as never,
    format: 'pdf',
    generatedAt: '2026-09-28T05:18:00.000Z',
    data: { rows: [], rowCount: 0, summary },
  };
}

const SUMMARY = {
  org: { id: 'o1', name: 'Acme' },
  asOf: '2026-09-28T05:00:00.000Z',
  generatedAt: '2026-09-28T05:00:00.000Z',
  summary: { byHealth: { healthy: 7, warning: 2, critical: 1, unknown: 0 } },
  statusBuckets: [],
  recencyBuckets: [],
  rows: [{ key: 'a', history28d: [{ day: '2026-09-27', status: 'failed' }] }],
  truncated: false,
  options: { includeDevicesWithoutBackup: true, sources: ['breeze', 'provider'] },
};

describe('ReportPreview: backup_status', () => {
  it('renders designed health tiles instead of the generic summary cards', () => {
    render(<ReportPreview data={previewData(SUMMARY)} timezone="UTC" />);
    const panel = screen.getByTestId('backup-status-summary');
    expect(within(panel).getByText('Healthy').nextSibling).toHaveTextContent('7');
    expect(within(panel).getByText('Warning').nextSibling).toHaveTextContent('2');
    expect(within(panel).getByText('Critical').nextSibling).toHaveTextContent('1');
    // No raw JSON of the nested snapshot leaks into the page.
    expect(document.body.textContent).not.toContain('history28d');
    expect(document.body.textContent).not.toContain('[object Object]');
    expect(screen.queryByTestId('backup-status-truncated')).toBeNull();
  });

  it('flags a truncated device list', () => {
    render(<ReportPreview data={previewData({ ...SUMMARY, truncated: true })} timezone="UTC" />);
    expect(screen.getByTestId('backup-status-truncated')).toBeInTheDocument();
  });
});
