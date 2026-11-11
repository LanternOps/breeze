import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddPackageModal from './AddPackageModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

// Partner-scope All-orgs context (#2135): the selector shows and defaults to
// partner-wide. The hook itself is covered by useDefaultOwnerScope's contract.
vi.mock('../../hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({
    isPartnerScope: true,
    defaultOwnerScope: 'partner' as const,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('AddPackageModal owner scope (#2135)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/software/catalog'
          ? jsonResponse({ data: { id: 'cat-1' } })
          : jsonResponse({ data: [] }),
      ),
    );
  });

  it('shows the selector defaulted to All organizations and sends ownerScope', async () => {
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

    const partnerRadio = screen.getByTestId('software-package-owner-partner') as HTMLInputElement;
    expect(partnerRadio.checked).toBe(true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chrome' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } });
    fireEvent.change(
      screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'),
      { target: { value: 'https://dl.example.com/chrome.msi' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create package' }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        ([url, opts]) => url === '/software/catalog' && opts?.method === 'POST',
      );
      expect(createCall).toBeTruthy();
      expect(JSON.parse(String(createCall![1]!.body)).ownerScope).toBe('partner');
    });
  });

  it('partner-wide keeps the file source and uploads through the chunked API', () => {
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

    expect(screen.getByRole('tab', { name: /upload file/i })).toBeEnabled();
    expect(screen.queryByText(/file upload is not available/i)).not.toBeInTheDocument();
  });

  it('switching to partner-wide keeps a picked file', () => {
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.click(screen.getByTestId('software-package-owner-org'));
    fireEvent.click(screen.getByRole('tab', { name: /upload file/i }));
    const file = new File([new Uint8Array(8)], 'bigapp.msi');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.click(screen.getByTestId('software-package-owner-partner'));
    expect(screen.queryByTestId('pkg-file-dropped-notice')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /upload file/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('bigapp.msi')).toBeInTheDocument();
  });
});
