import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchSeriesOwnerCandidates: vi.fn(),
  transferSeriesOwner: vi.fn(() => Promise.resolve()),
}));
vi.mock('./seriesApi', () => api);

import { TransferOwnerDialog } from './TransferOwnerDialog';

describe('TransferOwnerDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists eligible users, marks the current owner, and transfers to the chosen one', async () => {
    api.fetchSeriesOwnerCandidates.mockResolvedValue([
      { id: 'u-1', name: 'Ada', email: 'ada@x.io' },
      { id: 'u-2', name: 'Bo', email: 'bo@x.io' },
    ]);
    const onTransferred = vi.fn();
    render(<TransferOwnerDialog open onClose={vi.fn()} seriesId="s-1" currentOwnerId="u-1" onTransferred={onTransferred} />);
    const select = await screen.findByTestId('series-transfer-owner-select');
    expect(screen.getByRole('option', { name: 'Ada (current owner)' })).toBeDisabled();
    expect(screen.getByTestId('series-transfer-owner-confirm')).toBeDisabled();
    fireEvent.change(select, { target: { value: 'u-2' } });
    fireEvent.click(screen.getByTestId('series-transfer-owner-confirm'));
    await waitFor(() => expect(api.transferSeriesOwner).toHaveBeenCalledWith('s-1', 'u-2', expect.objectContaining({ successMessage: 'Owner transferred to Bo' })));
    await waitFor(() => expect(onTransferred).toHaveBeenCalled());
  });

  it('explains a missing users:read permission', async () => {
    api.fetchSeriesOwnerCandidates.mockResolvedValue('forbidden');
    render(<TransferOwnerDialog open onClose={vi.fn()} seriesId="s-1" currentOwnerId="u-1" onTransferred={vi.fn()} />);
    expect(await screen.findByTestId('series-transfer-owner-message')).toHaveTextContent('permission to view users');
  });

  it('says when nobody else qualifies', async () => {
    api.fetchSeriesOwnerCandidates.mockResolvedValue([{ id: 'u-1', name: 'Ada', email: 'ada@x.io' }]);
    render(<TransferOwnerDialog open onClose={vi.fn()} seriesId="s-1" currentOwnerId="u-1" onTransferred={vi.fn()} />);
    expect(await screen.findByTestId('series-transfer-owner-message')).toHaveTextContent('No other user');
  });
});
