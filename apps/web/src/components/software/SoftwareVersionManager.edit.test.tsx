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
  version: '1.2.3',
  releaseDate: '2026-01-01T00:00:00Z',
  architecture: 'x64',
  fileType: 'msi',
  isLatest: true,
  downloadUrl: 'https://dl.example.com/app-1.2.3.msi',
  silentInstallArgs: 'msiexec /i "{file}" /qn',
  silentUninstallArgs: 'msiexec /x "{file}" /qn',
  supportedOs: ['windows'],
  releaseNotes: 'old notes',
};

async function renderLoaded() {
  render(<SoftwareVersionManager catalogId="cat-1" embedded />);
  await waitFor(() =>
    expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
  );
}

describe('SoftwareVersionManager edit & prefill', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/custom-fields')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.resolve(jsonResponse({ data: [EXISTING_VERSION] }));
    });
  });

  it('prefills the add form from the latest version with the number bumped', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /add version/i }));

    expect(
      (screen.getByPlaceholderText('e.g. 1.0.0') as HTMLInputElement).value,
    ).toBe('1.2.4');
    // The carried-over URL gets the OLD version substituted for the bumped one
    // so the prefill can't silently point 1.2.4 at the 1.2.3 binary.
    expect(
      (screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi') as HTMLInputElement).value,
    ).toBe('https://dl.example.com/app-1.2.4.msi');
    expect(
      (screen.getByPlaceholderText(/msiexec \/i/i) as HTMLInputElement).value,
    ).toBe('msiexec /i "{file}" /qn');
    // Release notes never carry over to a new version.
    expect(
      (screen.getByPlaceholderText(/one item per line/i) as HTMLTextAreaElement).value,
    ).toBe('');
  });

  it('edits a version in place via PATCH and updates the row', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByTestId('version-edit-ver-1'));

    // Form is in edit mode, loaded with the version's data, no file picker.
    expect(screen.getByTestId('version-form-editing')).toBeInTheDocument();
    const versionInput = screen.getByPlaceholderText('e.g. 1.0.0') as HTMLInputElement;
    expect(versionInput.value).toBe('1.2.3');
    expect(document.querySelector('input[type="file"]')).toBeNull();

    fetchMock.mockImplementationOnce((url: string, opts?: RequestInit) => {
      expect(url).toBe('/software/catalog/cat-1/versions/ver-1');
      expect(opts?.method).toBe('PATCH');
      const body = JSON.parse(String(opts?.body));
      expect(body.version).toBe('1.2.9');
      expect(body.silentInstallArgs).toBe('msiexec /i "{file}" /qn');
      return Promise.resolve(
        jsonResponse({ data: { ...EXISTING_VERSION, version: '1.2.9' } }),
      );
    });

    fireEvent.change(versionInput, { target: { value: '1.2.9' } });
    fireEvent.submit(versionInput.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('v1.2.9')).toBeInTheDocument();
    });
    // Form closed after a successful save.
    expect(screen.queryByTestId('version-form-editing')).not.toBeInTheDocument();
  });

  it('surfaces a PATCH failure inline and keeps the edit form open', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByTestId('version-edit-ver-1'));

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        jsonResponse(
          { error: 'This version has no uploaded file — it needs a download URL' },
          false,
          400,
        ),
      ),
    );
    const versionInput = screen.getByPlaceholderText('e.g. 1.0.0') as HTMLInputElement;
    fireEvent.submit(versionInput.closest('form')!);

    await waitFor(() => {
      expect(
        screen.getByText(/needs a download URL/),
      ).toBeInTheDocument();
    });
    // The form stays open in edit mode so the user can correct and retry.
    expect(screen.getByTestId('version-form-editing')).toBeInTheDocument();
  });
});
