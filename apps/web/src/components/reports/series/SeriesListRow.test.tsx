import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  deleteSeries: vi.fn(() => Promise.resolve()),
  fetchSeriesOwnerCandidates: vi.fn(() => Promise.resolve([])),
  transferSeriesOwner: vi.fn(),
  updateSeries: vi.fn(() => Promise.resolve({})),
}));
vi.mock('./seriesApi', () => api);
vi.mock('./SeriesDrilldown', () => ({ SeriesDrilldown: () => null }));
vi.mock('../CoversCell', () => ({ CoversCell: () => <span data-testid="covers-cell-stub" /> }));

import { SeriesListRow } from './SeriesListRow';
import type { SeriesDetail } from './types';

const DETAIL = {
  series: { id: 's-1', name: 'Monthly', type: 'device_inventory', format: 'pdf', schedule: 'monthly', targetMode: 'all', ownerUserId: 'u-1', enabled: true },
  targets: [],
  orgs: [],
} as unknown as SeriesDetail;
const PAUSED = { ...DETAIL, series: { ...DETAIL.series, enabled: false } } as SeriesDetail;

const renderRow = (onChanged = vi.fn(), detail: SeriesDetail = DETAIL) =>
  render(<table><tbody><SeriesListRow detail={detail} expanded={false} onToggle={vi.fn()} onChanged={onChanged} timezone="UTC" /></tbody></table>);

describe('SeriesListRow actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('links Edit to the series page', () => {
    renderRow();
    expect(screen.getByTestId('report-series-edit-s-1')).toHaveAttribute('href', '/reports/series/s-1');
  });

  it('deletes only after the confirm and then refreshes', async () => {
    const onChanged = vi.fn();
    renderRow(onChanged);
    fireEvent.click(screen.getByTestId('report-series-delete-s-1'));
    expect(api.deleteSeries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('series-confirm-delete'));
    await waitFor(() => expect(api.deleteSeries).toHaveBeenCalledWith('s-1', expect.objectContaining({ successMessage: 'Deleted multi-org report “Monthly”' })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('opens the transfer-owner dialog', async () => {
    renderRow();
    fireEvent.click(screen.getByTestId('report-series-transfer-s-1'));
    expect(await screen.findByTestId('series-transfer-owner-dialog')).toBeInTheDocument();
  });

  it('pauses an active series with PATCH { enabled: false } and refreshes; no Paused badge while active', async () => {
    const onChanged = vi.fn();
    renderRow(onChanged);
    expect(screen.queryByTestId('report-series-paused-covers-s-1')).toBeNull();
    const pause = screen.getByTestId('report-series-pause-s-1');
    expect(pause).toHaveAttribute('data-enabled', 'true');
    expect(pause).toHaveTextContent('Pause');
    fireEvent.click(pause);
    await waitFor(() => expect(api.updateSeries).toHaveBeenCalledWith('s-1', { enabled: false }, expect.objectContaining({ successMessage: 'Paused “Monthly”' })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('a paused series shows Paused in the Covers and Last-run cells and offers Resume', async () => {
    renderRow(vi.fn(), PAUSED);
    expect(screen.getByTestId('report-series-paused-covers-s-1')).toHaveTextContent('Paused');
    expect(screen.getByTestId('report-series-paused-lastrun-s-1')).toHaveTextContent('Paused');
    const resume = screen.getByTestId('report-series-pause-s-1');
    expect(resume).toHaveTextContent('Resume');
    fireEvent.click(resume);
    await waitFor(() => expect(api.updateSeries).toHaveBeenCalledWith('s-1', { enabled: true }, expect.objectContaining({ successMessage: 'Resumed “Monthly”' })));
  });
});
