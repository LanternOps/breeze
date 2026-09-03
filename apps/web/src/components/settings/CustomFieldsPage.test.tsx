import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
import CustomFieldsPage from './CustomFieldsPage';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

import { fetchWithAuth } from '../../stores/auth';

const mockedFetchWithAuth = vi.mocked(fetchWithAuth);

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body
  } as Response;
}

function customField(overrides: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    name: 'RAM slot type',
    fieldKey: 'ram_slot_type',
    type: 'text',
    required: false,
    scriptWrite: false,
    defaultValue: null,
    deviceTypes: null,
    options: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

describe('CustomFieldsPage script-write toggle', () => {
  beforeEach(() => {
    mockedFetchWithAuth.mockReset();
    // Initial GET /custom-fields on mount.
    mockedFetchWithAuth.mockResolvedValue(jsonResponse({ data: [] }));
  });

  it('sends scriptWrite in the create payload when the toggle is on', async () => {
    render(<CustomFieldsPage />);

    await waitFor(() => expect(mockedFetchWithAuth).toHaveBeenCalled());

    fireEvent.click(await screen.findByTestId('custom-field-add'));
    fireEvent.change(screen.getByTestId('custom-field-name'), { target: { value: 'RAM slot type' } });
    fireEvent.change(screen.getByTestId('custom-field-key'), { target: { value: 'ram_slot_type' } });
    fireEvent.click(screen.getByTestId('custom-field-script-write'));

    // The POST resolves like a normal create, then the page re-fetches.
    mockedFetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: { id: 'f1' } }));
    mockedFetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: [] }));

    fireEvent.click(screen.getByTestId('custom-field-submit'));

    await waitFor(() => {
      const postCall = mockedFetchWithAuth.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'POST'
      );
      expect(postCall).toBeDefined();
    });

    const postCall = mockedFetchWithAuth.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST'
    )!;
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    expect(body.scriptWrite).toBe(true);
  });

  it('defaults scriptWrite to false when the toggle is left off', async () => {
    render(<CustomFieldsPage />);

    await waitFor(() => expect(mockedFetchWithAuth).toHaveBeenCalled());

    fireEvent.click(await screen.findByTestId('custom-field-add'));
    fireEvent.change(screen.getByTestId('custom-field-name'), { target: { value: 'Asset Tag' } });
    fireEvent.change(screen.getByTestId('custom-field-key'), { target: { value: 'asset_tag' } });

    mockedFetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: { id: 'f2' } }));
    mockedFetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: [] }));

    fireEvent.click(screen.getByTestId('custom-field-submit'));

    await waitFor(() => {
      const postCall = mockedFetchWithAuth.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'POST'
      );
      expect(postCall).toBeDefined();
    });

    const postCall = mockedFetchWithAuth.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'POST'
    )!;
    const body = JSON.parse(String((postCall[1] as RequestInit).body));
    expect(body.scriptWrite).toBe(false);
  });

  it('preserves scriptWrite:true through the edit (PATCH) path when left untouched', async () => {
    mockedFetchWithAuth.mockResolvedValue(jsonResponse({ data: [customField({ scriptWrite: true })] }));

    render(<CustomFieldsPage />);

    fireEvent.click(await screen.findByTitle('Edit'));
    // The toggle should already be checked, seeded from field.scriptWrite.
    expect(screen.getByTestId('custom-field-script-write')).toBeChecked();

    mockedFetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: { id: 'f1' } }));
    mockedFetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: [] }));

    fireEvent.click(screen.getByTestId('custom-field-submit'));

    await waitFor(() => {
      const patchCall = mockedFetchWithAuth.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
    });

    const patchCall = mockedFetchWithAuth.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH'
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body.scriptWrite).toBe(true);
  });

  it('turns scriptWrite off through the edit (PATCH) path when unchecked', async () => {
    mockedFetchWithAuth.mockResolvedValue(jsonResponse({ data: [customField({ scriptWrite: true })] }));

    render(<CustomFieldsPage />);

    fireEvent.click(await screen.findByTitle('Edit'));
    fireEvent.click(screen.getByTestId('custom-field-script-write'));
    expect(screen.getByTestId('custom-field-script-write')).not.toBeChecked();

    mockedFetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: { id: 'f1' } }));
    mockedFetchWithAuth.mockResolvedValueOnce(jsonResponse({ data: [] }));

    fireEvent.click(screen.getByTestId('custom-field-submit'));

    await waitFor(() => {
      const patchCall = mockedFetchWithAuth.mock.calls.find(
        (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
    });

    const patchCall = mockedFetchWithAuth.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH'
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(body.scriptWrite).toBe(false);
  });

  it('renders the Script write badge only for fields with scriptWrite:true', async () => {
    mockedFetchWithAuth.mockResolvedValue(
      jsonResponse({
        data: [
          customField({ id: 'f1', fieldKey: 'ram_slot_type', scriptWrite: true }),
          customField({ id: 'f2', fieldKey: 'asset_tag', scriptWrite: false })
        ]
      })
    );

    render(<CustomFieldsPage />);

    const rows = await screen.findAllByRole('row');
    // rows[0] is the header row; data rows follow in list order.
    const [, ramRow, assetRow] = rows;

    expect(ramRow).toHaveTextContent('Script write');
    expect(assetRow).not.toHaveTextContent('Script write');
  });
});

describe('CustomFieldsPage — field key help (issue #4198)', () => {
  beforeEach(() => {
    mockedFetchWithAuth.mockReset();
    mockedFetchWithAuth.mockResolvedValue(jsonResponse([]));
  });

  it('shows a help affordance next to Field Key explaining how scripts read/write it', async () => {
    render(<CustomFieldsPage />);

    await waitFor(() => expect(mockedFetchWithAuth).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Add your first custom field' }));

    const trigger = await screen.findByRole('button', { name: 'About using this field in scripts' });
    fireEvent.click(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/PATCH request/i);
  });
});
