import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DeviceFilterBar } from './DeviceFilterBar';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';

// #6594 — the legacy FilterBuilder-based advanced filter (DeviceFilterBar,
// still the fallback UI when the v2 chip bar flag is off) syncs custom field
// definitions into its own `filterFields` prop independently of
// FilterChipBar's useSyncCustomFilterFields. Cover it separately so a
// regression in DeviceFilterBar's own wiring doesn't slip through untested.
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
    if (url === '/filters') {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  })
}));

beforeEach(() => {
  vi.clearAllMocks();
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
});

describe('DeviceFilterBar — custom fields (#6594)', () => {
  it('offers a custom field in the field picker once definitions load', async () => {
    render(<DeviceFilterBar value={null} onChange={vi.fn()} defaultExpanded showSavedFilters={false} collapsible={false} />);

    // Initial condition defaults to the "hostname" field — its button opens
    // the categorized field picker (FieldSelector).
    fireEvent.click(screen.getByText('Hostname'));

    await waitFor(() => {
      expect(screen.getByText('Windows Activation')).toBeDefined();
    });
  });
});
