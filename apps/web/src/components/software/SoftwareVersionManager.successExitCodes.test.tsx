/**
 * Vendor-documented installer success exit codes (issue #7038). They ADD to
 * the agent's built-in success codes (0 always; 3010/1641 for exe/msi) and
 * live behind the same Advanced disclosure as detection rules.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SoftwareVersionManager from './SoftwareVersionManager';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const EXISTING_VERSION = {
  id: 'ver-1',
  version: '1.0.0',
  releaseDate: '2026-01-01T00:00:00Z',
  architecture: 'x64',
  fileType: 'msi',
  isLatest: true,
  downloadUrl: 'https://dl.example.com/app-1.0.0.msi',
  successExitCodes: [1000, 1101],
};

/** The JSON body of the metadata-only version POST/PATCH. */
const lastCall = (method: string) =>
  fetchMock.mock.calls.find(
    ([u, o]) =>
      /\/versions(\/[^/]+)?$/.test(String(u)) && (o as RequestInit)?.method === method,
  );

const bodyOf = (method: string) =>
  JSON.parse((lastCall(method)?.[1] as RequestInit).body as string);

async function openAddForm() {
  render(<SoftwareVersionManager catalogId="cat-1" embedded />);
  await waitFor(() =>
    expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: /add version/i }));
}

const openAdvanced = () =>
  fireEvent.click(screen.getByRole('button', { name: /advanced options/i }));

describe('SoftwareVersionManager success exit codes', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).startsWith('/custom-fields')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      if (/\/versions$/.test(String(url)) && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ data: { ...EXISTING_VERSION, id: 'ver-2' } }));
      }
      if (/\/versions\/ver-1$/.test(String(url)) && opts?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ data: EXISTING_VERSION }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
  });

  it('sends parsed successExitCodes when adding a version', async () => {
    await openAddForm();
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.0.0'), {
      target: { value: '2.0.0' },
    });
    fireEvent.change(
      screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'),
      { target: { value: 'https://dl.example.com/app-2.0.0.msi' } },
    );
    openAdvanced();
    fireEvent.change(
      screen.getByLabelText(/additional success exit codes/i),
      { target: { value: '1000, 1101' } },
    );

    fireEvent.submit(screen.getByLabelText(/additional success exit codes/i).closest('form')!);

    await waitFor(() => expect(bodyOf('POST').successExitCodes).toEqual([1000, 1101]));
  });

  it('blocks submit and shows an inline error for an invalid exit code token', async () => {
    await openAddForm();
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.0.0'), {
      target: { value: '2.0.0' },
    });
    openAdvanced();
    fireEvent.change(
      screen.getByLabelText(/additional success exit codes/i),
      { target: { value: 'abc' } },
    );

    expect(
      await screen.findByText('"abc" is not a valid exit code'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /save version/i }),
    ).toBeDisabled();
  });

  it('prefills the edit form from the stored codes and always sends the array on PATCH', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).startsWith('/custom-fields')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      if (/\/versions\/ver-1$/.test(String(url)) && opts?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ data: { ...EXISTING_VERSION, successExitCodes: [] } }));
      }
      return Promise.resolve(jsonResponse({ data: [EXISTING_VERSION] }));
    });
    render(<SoftwareVersionManager catalogId="cat-1" embedded />);
    await waitFor(() =>
      expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('version-edit-ver-1'));

    const field = screen.getByLabelText(
      /additional success exit codes/i,
    ) as HTMLInputElement;
    expect(field.value).toBe('1000, 1101');

    fireEvent.change(field, { target: { value: '' } });
    fireEvent.submit(field.closest('form')!);

    await waitFor(() => expect(bodyOf('PATCH').successExitCodes).toEqual([]));
  });
});
