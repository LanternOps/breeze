import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  replaceSeriesTargets: vi.fn(() => Promise.resolve({})),
  detachSeriesChild: vi.fn(() => Promise.resolve()),
  generateSeriesChild: vi.fn(() => Promise.resolve()),
  updateSeries: vi.fn(() => Promise.resolve({})),
}));
vi.mock('./seriesApi', () => api);

import { SeriesDrilldown } from './SeriesDrilldown';
import type { SeriesDetail } from './types';

const series = (targetMode: 'all' | 'selected') => ({
  id: 's-1', name: 'Monthly', type: 'device_inventory', format: 'pdf', schedule: 'monthly', config: {}, targetMode,
  recipientRule: { primaryContact: true, roles: [] }, internalCc: [], revision: 1, enabled: true, ownerUserId: 'u-1', createdAt: '', updatedAt: '',
}) as SeriesDetail['series'];

const ALL: SeriesDetail = {
  series: series('all'),
  targets: ['o-x'],
  orgs: [
    { orgId: 'o-b', orgName: 'Birch Law', state: 'blocked_no_authority', childReportId: 'c-b', lastRun: null },
    { orgId: 'o-a', orgName: 'Acme Dental', state: 'active', childReportId: 'c-a', lastRun: { status: 'completed', deliveryStatus: 'sent', recipientCount: 2, completedAt: '2026-10-01T09:00:00Z' } },
    { orgId: 'o-x', orgName: 'Xeno', state: 'excluded', childReportId: 'c-x', lastRun: null },
  ],
};

describe('SeriesDrilldown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists orgs by name with state, delivery and recipient count', () => {
    render(<SeriesDrilldown detail={ALL} onChanged={vi.fn()} timezone="UTC" />);
    const rows = screen.getAllByTestId(/^series-org-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['series-org-row-o-a', 'series-org-row-o-b', 'series-org-row-o-x']);
    expect(rows[0]).toHaveAttribute('data-state', 'active');
    expect(rows[0]).toHaveTextContent('Sent');
    expect(rows[0]).toHaveTextContent('2');
    expect(screen.getByTestId('series-org-recipients-o-a')).toHaveAttribute('href', '/reports/c-a/edit');
  });

  it('never runs a child the owner cannot reach', () => {
    render(<SeriesDrilldown detail={ALL} onChanged={vi.fn()} timezone="UTC" />);
    expect(screen.getByTestId('series-org-run-o-b')).toBeDisabled();
    expect(screen.getByTestId('series-org-hint-o-b')).toHaveTextContent("The owner can't reach this organization");
  });

  it('Run now generates that org\'s copy', async () => {
    const onChanged = vi.fn();
    render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-run-o-a'));
    await waitFor(() => expect(api.generateSeriesChild).toHaveBeenCalledWith('c-a', expect.objectContaining({ errorFallback: expect.any(String) })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('Exclude (All orgs) confirms, then adds an exclusion', async () => {
    const onChanged = vi.fn();
    render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-exclude-o-a'));
    expect(api.replaceSeriesTargets).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('series-confirm-exclude'));
    await waitFor(() => expect(api.replaceSeriesTargets).toHaveBeenCalledWith('s-1', { targetMode: 'all', orgIds: ['o-x', 'o-a'] }, expect.anything()));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('Include removes the exclusion without a confirm', async () => {
    render(<SeriesDrilldown detail={ALL} onChanged={vi.fn()} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-include-o-x'));
    await waitFor(() => expect(api.replaceSeriesTargets).toHaveBeenCalledWith('s-1', { targetMode: 'all', orgIds: [] }, expect.anything()));
  });

  // W03 final review: Include would be a no-op while the standalone copy is live.
  it('shows a detached org as Detached with no Include/Exclude/Run, and says why', () => {
    const withDetached: SeriesDetail = {
      ...ALL,
      orgs: [...ALL.orgs, { orgId: 'o-d', orgName: 'Delta', state: 'detached', childReportId: null, lastRun: null }],
    };
    render(<SeriesDrilldown detail={withDetached} onChanged={vi.fn()} timezone="UTC" />);
    const row = screen.getByTestId('series-org-row-o-d');
    expect(row).toHaveAttribute('data-state', 'detached');
    expect(row).toHaveTextContent('Detached');
    expect(screen.queryByTestId('series-org-include-o-d')).toBeNull();
    expect(screen.queryByTestId('series-org-exclude-o-d')).toBeNull();
    expect(screen.queryByTestId('series-org-run-o-d')).toBeNull();
    expect(screen.getByTestId('series-org-hint-o-d')).toHaveTextContent('standalone');
  });

  // Review Focus 1.
  it('disables Exclude on the only chosen organization', () => {
    const one: SeriesDetail = { series: series('selected'), targets: ['o-a'], orgs: [ALL.orgs[1]!] };
    render(<SeriesDrilldown detail={one} onChanged={vi.fn()} timezone="UTC" />);
    expect(screen.getByTestId('series-org-exclude-o-a')).toBeDisabled();
    expect(screen.getByTestId('series-org-hint-o-a')).toHaveTextContent('needs at least one');
  });

  it('Detach confirms, then detaches the child', async () => {
    const onChanged = vi.fn();
    render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-detach-o-a'));
    fireEvent.click(screen.getByTestId('series-confirm-detach'));
    await waitFor(() => expect(api.detachSeriesChild).toHaveBeenCalledWith('c-a', expect.anything()));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('refreshes nothing when an action fails', async () => {
    api.generateSeriesChild.mockRejectedValueOnce(new Error('network'));
    const onChanged = vi.fn();
    render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('series-org-run-o-a'));
    await waitFor(() => expect(api.generateSeriesChild).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
  });
  it('pauses the series from the drill-down header, and shows Paused when disabled', async () => {
    const onChanged = vi.fn();
    const { rerender } = render(<SeriesDrilldown detail={ALL} onChanged={onChanged} timezone="UTC" />);
    expect(screen.queryByTestId('series-drilldown-paused-s-1')).toBeNull();
    fireEvent.click(screen.getByTestId('series-drilldown-pause-s-1'));
    await waitFor(() => expect(api.updateSeries).toHaveBeenCalledWith('s-1', { enabled: false }, expect.anything()));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    rerender(<SeriesDrilldown detail={{ ...ALL, series: { ...ALL.series, enabled: false } }} onChanged={onChanged} timezone="UTC" />);
    expect(screen.getByTestId('series-drilldown-paused-s-1')).toHaveTextContent('Paused');
    expect(screen.getByTestId('series-drilldown-pause-s-1')).toHaveTextContent('Resume');
  });
});
