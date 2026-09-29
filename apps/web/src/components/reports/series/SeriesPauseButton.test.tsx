import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ updateSeries: vi.fn(() => Promise.resolve({})) }));
vi.mock('./seriesApi', () => api);

import { SeriesPauseButton } from './SeriesPauseButton';
import type { SeriesDetail } from './types';

const detail = (enabled: boolean) =>
  ({ series: { id: 's-1', name: 'Monthly', enabled }, targets: [], orgs: [] }) as unknown as SeriesDetail;

describe('SeriesPauseButton', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not refresh when the PATCH fails', async () => {
    api.updateSeries.mockRejectedValueOnce(new Error('network'));
    const onChanged = vi.fn();
    render(<SeriesPauseButton detail={detail(true)} onChanged={onChanged} testId="btn" />);
    fireEvent.click(screen.getByTestId('btn'));
    await waitFor(() => expect(api.updateSeries).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByTestId('btn')).not.toBeDisabled();
  });
});
