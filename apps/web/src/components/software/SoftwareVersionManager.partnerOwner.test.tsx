import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SoftwareVersionManager from './SoftwareVersionManager';
import { fetchWithAuth } from '../../stores/auth';
import { uploadPackageVersion } from '../../lib/softwarePackageUpload';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const uploadMock = vi.mocked(uploadPackageVersion);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const EXISTING = {
  id: 'ver-1',
  version: '1.0.0',
  releaseDate: '2026-01-01T00:00:00Z',
  architecture: 'x64',
  fileType: 'msi',
  isLatest: true,
};

async function renderLoaded(props: Record<string, unknown>) {
  render(<SoftwareVersionManager catalogId="cat-1" embedded {...props} />);
  await waitFor(() =>
    expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: /add version/i }));
}

describe('SoftwareVersionManager partner-owned packages', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).startsWith('/custom-fields')
          ? jsonResponse({ data: [] })
          : jsonResponse({ data: [EXISTING] }),
      ),
    );
  });

  it('partner-owned without full partner access: file picker and save disabled, reason shown', async () => {
    await renderLoaded({ ownerScope: 'partner', canManagePartnerWide: false });

    expect(screen.getByRole('button', { name: /choose file/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /save version/i })).toBeDisabled();
    expect(screen.getByTestId('partner-wide-requires-full-access')).toBeInTheDocument();
  });

  it('partner-owned with full access uploads through the chunked client', async () => {
    uploadMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: 'ver-9', version: '2.0.0', isLatest: true } }, true, 201),
    );
    await renderLoaded({ ownerScope: 'partner', canManagePartnerWide: true });

    expect(screen.queryByTestId('partner-wide-requires-full-access')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.0.0'), { target: { value: '2.0.0' } });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], 'a.msi')] } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0][0]).toMatchObject({ catalogId: 'cat-1' });
  });

  it('undefined canManagePartnerWide (not loaded) leaves the form enabled', async () => {
    await renderLoaded({ ownerScope: 'partner' });
    expect(screen.getByRole('button', { name: /choose file/i })).toBeEnabled();
  });

  it('built-in integration package shows the default-args helper', async () => {
    await renderLoaded({
      ownerScope: 'partner',
      canManagePartnerWide: true,
      integrationProvider: 'sentinelone',
    });
    expect(screen.getByTestId('builtin-args-default')).toBeInTheDocument();
  });

  it('org-owned package shows neither partner notice nor helper', async () => {
    await renderLoaded({});
    expect(screen.queryByTestId('partner-wide-requires-full-access')).not.toBeInTheDocument();
    expect(screen.queryByTestId('builtin-args-default')).not.toBeInTheDocument();
  });
});
