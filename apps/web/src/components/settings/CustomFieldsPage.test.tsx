import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
});
