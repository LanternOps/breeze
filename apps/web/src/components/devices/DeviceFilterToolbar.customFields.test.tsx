import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';

import { DeviceFilterToolbar } from './DeviceFilterToolbar';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';

// #6594 — DeviceFilterToolbar, not <FilterChipBar>, is the surface actually
// mounted on /devices (DevicesPage.tsx). A prior version of this fix wired
// useSyncCustomFilterFields() into FilterChipBar only, which is never
// rendered in production (DeviceFilterToolbar composes Chip/
// FilterSentenceBuilder/FilterAddDropdown directly) — so the real page kept
// the "unknown: custom.<key>" bug even with FilterChipBar's own tests green.
// This test exercises the actual production component.
const CUSTOM_DEFS = [
  {
    id: 'cf-1',
    orgId: null,
    partnerId: 'p1',
    name: 'Windows Activation',
    fieldKey: 'bdr_windows_activation',
    type: 'text',
    options: null,
    required: false,
    defaultValue: null,
    deviceTypes: ['windows']
  }
];

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    if (url === '/custom-fields') {
      return { ok: true, status: 200, json: async () => ({ data: CUSTOM_DEFS, total: 1 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  })
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (state: { currentOrgId: string | null }) => unknown) => {
      const state = { currentOrgId: null };
      return selector ? selector(state) : state;
    },
    { getState: () => ({ currentOrgId: null }) }
  )
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./SavedViewsMenu', () => ({ SavedViewsMenu: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
});

describe('DeviceFilterToolbar — custom fields (#6594)', () => {
  it('resolves an active custom.<key> chip to its display name on the real production toolbar', async () => {
    const value: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'custom.bdr_windows_activation', operator: 'equals', value: 'Notification' }]
    };
    render(
      <DeviceFilterToolbar
        value={value}
        onChange={vi.fn()}
        listFilters={{ search: '' }}
        onListFiltersChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('filter-chip-custom.bdr_windows_activation')).toBeDefined();
    });
    expect(screen.getByTestId('filter-chip-custom.bdr_windows_activation').textContent).toContain(
      'Windows Activation'
    );
  });

  it('offers the custom field in the toolbar "+ Add filter" picker', async () => {
    render(
      <DeviceFilterToolbar
        value={null}
        onChange={vi.fn()}
        listFilters={{ search: '' }}
        onListFiltersChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('filter-more-button'));

    await waitFor(() => {
      expect(screen.getByTestId('filter-add-field-custom.bdr_windows_activation')).toBeDefined();
    });
  });
});
