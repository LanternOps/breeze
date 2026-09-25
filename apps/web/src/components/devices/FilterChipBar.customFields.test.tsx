import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';

import { FilterChipBar } from './FilterChipBar';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';
import { setCustomFilterFields } from './filterFields';

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

beforeEach(() => {
  vi.clearAllMocks();
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
  setCustomFilterFields([]);
});

describe('FilterChipBar — custom fields (#6594)', () => {
  it('resolves a custom.<key> filter chip to its display name instead of "unknown: custom.<key>"', async () => {
    const value: FilterConditionGroup = {
      operator: 'AND',
      conditions: [{ field: 'custom.bdr_windows_activation', operator: 'equals', value: 'Notification' }]
    };
    render(<FilterChipBar value={value} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('filter-chip-custom.bdr_windows_activation')).toBeDefined();
    });
    expect(screen.getByTestId('filter-chip-custom.bdr_windows_activation').textContent).toContain('Windows Activation');
    expect(screen.queryByText(/unknown/i)).toBeNull();
  });

  it('offers the custom field in the "+ Add filter" picker under Custom Fields', async () => {
    render(<FilterChipBar value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('filter-add-button'));

    await waitFor(() => {
      expect(screen.getByTestId('filter-add-field-custom.bdr_windows_activation')).toBeDefined();
    });
  });
});
