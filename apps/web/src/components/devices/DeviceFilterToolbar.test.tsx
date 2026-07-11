import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { applyLocale } from '@/lib/i18n';
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

  it('localizes the live quick-filter toolbar without changing canonical filters', async () => {
    await applyLocale('pt-BR');
    const onChange = vi.fn();

    render(
      <DeviceFilterToolbar
        value={null}
        onChange={onChange}
        listFilters={{ search: '' }}
        onListFiltersChange={vi.fn()}
      />
    );

    expect(screen.getByText('Servidores')).toBeInTheDocument();
    expect(screen.getByText('Precisa de patches')).toBeInTheDocument();
    expect(screen.getByText('Reinicialização necessária')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Servidores'));
    expect(onChange).toHaveBeenCalledWith({
      operator: 'AND',
      conditions: [{ field: 'deviceRole', operator: 'equals', value: 'server' }],
    });

    await applyLocale('en');
  });
});
