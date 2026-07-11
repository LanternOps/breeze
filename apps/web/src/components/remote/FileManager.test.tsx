import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileManager from './FileManager';

const mockFetchWithAuth = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

describe('FileManager downloads', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it('uses the translated fallback when a download rejects with a non-Error value', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/download?')) return Promise.reject('network offline');
      return Promise.resolve({
        ok: true,
        json: async () => ({
          data: [{ name: 'report.txt', path: '/report.txt', type: 'file', size: 12 }],
        }),
      });
    });

    render(
      <FileManager
        deviceId="device-1"
        deviceHostname="workstation-1"
        initialPath="/"
      />
    );

    await screen.findByText('report.txt');
    fireEvent.click(screen.getByTitle('Download'));

    await waitFor(() => {
      expect(screen.getByText('Failed to download')).toBeInTheDocument();
    });
  });
});
