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

  // The `groups` prop was accepted and discarded (`groups: _groups`) after the
  // chip-bar rewrite; this pins the toolbar → Chip → summarizeCondition path.
  it('resolves a groupId chip to the group name through the toolbar', () => {
    const groups = [{ id: '33333333-3333-3333-3333-333333333333', name: 'Domain Controllers', type: 'static' as const, deviceCount: 3 }];
    render(
      <DeviceFilterToolbar
        value={{ operator: 'AND', conditions: [{ field: 'groupId', operator: 'in', value: [groups[0].id] }] }}
        onChange={vi.fn()}
        listFilters={{ search: '' }}
        onListFiltersChange={vi.fn()}
        groups={groups}
      />
    );
    const chip = screen.getByTestId('filter-chip-groupId');
    expect(chip.textContent).toContain('Domain Controllers');
    expect(chip.textContent).not.toContain('33333333');
  });
});

// #9037: when the quick-chip strip overflows, a fade alone is not a cue a
// user can act on. An explicit scroll button appears at the clipped edge.
describe('DeviceFilterToolbar — quick-chip overflow cue (#9037)', () => {
  const layout: Record<string, PropertyDescriptor | undefined> = {};
  const define = (name: string, descriptor: PropertyDescriptor) => {
    layout[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
  };
  const restore = () => {
    for (const [name, descriptor] of Object.entries(layout)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  };

  it('shows a right-scroll button when chips are clipped on the right, and scrolls the strip on click', () => {
    let scrollLeft = 0;
    define('scrollWidth', { get: () => 900 });
    define('clientWidth', { get: () => 300 });
    define('scrollLeft', { get: () => scrollLeft, set: (v: number) => { scrollLeft = v; } });
    const scrollBy = vi.fn();
    define('scrollBy', { value: scrollBy, writable: true });
    try {
      render(
        <DeviceFilterToolbar value={null} onChange={vi.fn()} listFilters={{ search: '' }} onListFiltersChange={vi.fn()} />,
      );
      const right = screen.getByRole('button', { name: 'Scroll filters right' });
      expect(screen.queryByRole('button', { name: 'Scroll filters left' })).toBeNull();
      fireEvent.click(right);
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect((scrollBy.mock.calls[0][0] as { left: number }).left).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('shows no scroll buttons when every chip fits', () => {
    define('scrollWidth', { get: () => 300 });
    define('clientWidth', { get: () => 300 });
    try {
      render(
        <DeviceFilterToolbar value={null} onChange={vi.fn()} listFilters={{ search: '' }} onListFiltersChange={vi.fn()} />,
      );
      expect(screen.queryByRole('button', { name: /Scroll filters/ })).toBeNull();
    } finally {
      restore();
    }
  });
});
