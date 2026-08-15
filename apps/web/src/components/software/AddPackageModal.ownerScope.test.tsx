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

  it('disables the file source for partner-wide packages (URL-only)', () => {
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

    expect(screen.getByRole('tab', { name: /upload file/i })).toBeDisabled();

    // Switching to org-owned re-enables the file source.
    fireEvent.click(screen.getByTestId('software-package-owner-org'));
    expect(screen.getByRole('tab', { name: /upload file/i })).toBeEnabled();
  });
});
