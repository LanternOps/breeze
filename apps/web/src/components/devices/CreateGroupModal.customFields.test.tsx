import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import CreateGroupModal from './CreateGroupModal';
import { fetchWithAuth } from '../../stores/auth';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';

// #8843 — the dynamic-group rule builder must offer org/partner custom fields
// as `custom.<key>` fields, the same catalog the device list's advanced filter
// shows (#6594). The filter engine already resolves them server-side.
const CUSTOM_DEFS = [
  {
    id: 'cf-1',
    orgId: null,
    partnerId: 'p1',
    name: 'Asset disposition',
    fieldKey: 'asset_disposition',
    type: 'dropdown',
    options: { choices: ['In service', 'Retired'] },
    required: false,
    defaultValue: null,
    deviceTypes: null,
  },
];

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const mockFetch = vi.mocked(fetchWithAuth);

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/custom-fields') return jsonResponse({ data: CUSTOM_DEFS, total: 1 });
    if (url === '/device-groups' && init?.method === 'POST') {
      return jsonResponse({ data: { id: 'new-group' } });
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
});

async function openDynamicFieldPicker() {
  const user = userEvent.setup();
  render(<CreateGroupModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Dynamic' }));
  // The initial condition defaults to "Hostname"; its button opens the
  // categorized field picker (FieldSelector).
  await user.click(screen.getByRole('button', { name: /Hostname/ }));
  return user;
}

describe('CreateGroupModal — custom fields in the rule builder (#8843)', () => {
  it('lists custom field definitions under Custom Fields in the field picker', async () => {
    await openDynamicFieldPicker();

    expect(await screen.findByText('Asset disposition')).toBeInTheDocument();
    expect(screen.getByText('Custom Fields')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith('/custom-fields');
  });

  it('finds a custom field by searching the field picker', async () => {
    const user = await openDynamicFieldPicker();
    await screen.findByText('Asset disposition');

    await user.type(screen.getByPlaceholderText(/search/i), 'disposition');

    expect(screen.getByText('Asset disposition')).toBeInTheDocument();
    expect(screen.queryByText(/No fields match/i)).not.toBeInTheDocument();
  });

  it('submits a dynamic group keyed on the custom.<key> field', async () => {
    const user = await openDynamicFieldPicker();
    await user.click(await screen.findByText('Asset disposition'));
    await user.type(await screen.findByTestId('value-text-input'), 'Retired');
    await user.type(screen.getByRole('textbox', { name: /name/i }), 'Retired assets');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(([url, init]) => url === '/device-groups' && init?.method === 'POST'),
      ).toBe(true);
    });
    const post = mockFetch.mock.calls.find(
      ([url, init]) => url === '/device-groups' && init?.method === 'POST',
    );
    const body = JSON.parse(String((post?.[1] as RequestInit).body));
    expect(body.filterConditions).toEqual({
      operator: 'AND',
      conditions: [{ field: 'custom.asset_disposition', operator: 'equals', value: 'Retired' }],
    });
  });
});
