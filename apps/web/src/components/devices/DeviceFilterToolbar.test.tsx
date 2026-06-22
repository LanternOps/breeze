import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DeviceFilterToolbar } from './DeviceFilterToolbar';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: [] }),
  })),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (state: { currentOrgId: string | null }) => unknown) => {
      const state = { currentOrgId: null };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ currentOrgId: null }) },
  ),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('./SavedViewsMenu', () => ({
  SavedViewsMenu: () => null,
}));

describe('DeviceFilterToolbar — device search', () => {
  it('labels the quick search as device search and writes into listFilters.search', () => {
    const onListFiltersChange = vi.fn();

    render(
      <DeviceFilterToolbar
        value={null}
        onChange={vi.fn()}
        listFilters={{ search: '' }}
        onListFiltersChange={onListFiltersChange}
      />
    );

    const input = screen.getByLabelText('Search devices');
    expect(input).toHaveAttribute('placeholder', 'Search devices');

    fireEvent.change(input, { target: { value: 'Reception' } });

    expect(onListFiltersChange).toHaveBeenCalledWith({ search: 'Reception' });
  });
});
