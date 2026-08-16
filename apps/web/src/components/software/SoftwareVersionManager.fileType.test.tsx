/**
 * The add-version-to-an-existing-package flow. It POSTs to the same
 * `/software/catalog/:id/versions` route as AddPackageModal and had none of the
 * installer-type handling, so a URL-sourced MSI added here reached the agent as
 * `fileType: 'exe'` and was exec'd directly — the original bug, in the flow an
 * MSP actually hits most often over a package's life.
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
};

async function renderLoaded() {
  render(<SoftwareVersionManager catalogId="cat-1" embedded />);
  await waitFor(() =>
    expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: /add version/i }));
}

const urlInput = () =>
  screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi');

/** The JSON body of the metadata-only version POST. */
const versionBody = () => {
  const call = fetchMock.mock.calls.find(
    ([u, o]) => /\/versions$/.test(String(u)) && (o as RequestInit)?.method === 'POST',
  );
  return JSON.parse((call?.[1] as RequestInit).body as string);
};

const submitForm = () =>
  fireEvent.submit(urlInput().closest('form')!);

describe('SoftwareVersionManager installer type (URL source)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).startsWith('/custom-fields')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      if (/\/versions$/.test(String(url)) && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ data: { ...EXISTING_VERSION, id: 'ver-2' } }));
      }
      // No existing versions: "Add version" seeds itself from the latest one
      // when there is one (see openAddForm), and every case below is about how
      // a BLANK form derives the installer type from the URL. The seeded path
      // is covered by its own case at the bottom of this file.
      return Promise.resolve(jsonResponse({ data: [] }));
    });
  });

  it('prefills the msiexec commands from a .msi URL', async () => {
    await renderLoaded();
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/acme.msi' } });

    await waitFor(() =>
      expect(screen.getByTestId('version-file-type')).toHaveValue(''),
    );
    expect(screen.getByDisplayValue('msiexec /i "{file}" /qn /norestart')).toBeTruthy();
  });

  it('retracts the prefill when the URL is corrected to a non-MSI', async () => {
    await renderLoaded();
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/acme.msi' } });
    await waitFor(() =>
      expect(screen.queryByDisplayValue('msiexec /i "{file}" /qn /norestart')).toBeTruthy(),
    );

    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/setup.exe' } });
    await waitFor(() =>
      expect(screen.queryByDisplayValue('msiexec /i "{file}" /qn /norestart')).toBeNull(),
    );
  });

  it('sends an explicitly chosen fileType for a URL with no usable extension', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.0.0'), {
      target: { value: '2.0.0' },
    });
    fireEvent.change(urlInput(), {
      target: { value: 'https://vendor.example/download.php?product=acme' },
    });
    fireEvent.change(screen.getByTestId('version-file-type'), { target: { value: 'msi' } });

    submitForm();

    await waitFor(() => expect(versionBody().fileType).toBe('msi'));
  });

  it('omits fileType when left on auto so the server infers it', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.0.0'), {
      target: { value: '2.0.0' },
    });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/acme.msi' } });

    submitForm();

    await waitFor(() => expect(versionBody().downloadUrl).toBe('https://cdn.example/acme.msi'));
    expect(versionBody()).not.toHaveProperty('fileType');
  });

  it('warns when the URL carries no recognizable installer extension', async () => {
    await renderLoaded();
    fireEvent.change(urlInput(), {
      target: { value: 'https://vendor.example/download.php?product=acme' },
    });

    await waitFor(() =>
      expect(screen.getByText(/no recognizable installer extension/i)).toBeTruthy(),
    );
  });

  it('does not warn before a URL has been entered', async () => {
    await renderLoaded();
    expect(screen.queryByText(/no recognizable installer extension/i)).toBeNull();
  });

  // The add form seeds itself from the latest version so a routine "new release,
  // same install shape" needs one glance. The installer type has to ride along:
  // carrying the URL and args but dropping fileType would store file_type NULL,
  // and the dispatcher then falls back to 'exe' and execs an MSI directly —
  // exactly the bug the selector exists to prevent.
  it('carries the installer type over when seeding a new version from the latest', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).startsWith('/custom-fields')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      if (/\/versions$/.test(String(url)) && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ data: { ...EXISTING_VERSION, id: 'ver-2' } }));
      }
      return Promise.resolve(jsonResponse({ data: [EXISTING_VERSION] }));
    });

    await renderLoaded();

    await waitFor(() =>
      expect(screen.getByTestId('version-file-type')).toHaveValue('msi'),
    );
    submitForm();
    await waitFor(() => expect(versionBody().fileType).toBe('msi'));
  });
});
