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

  it('aborts the browser request and shows a cancelled state when a download is cancelled', async () => {
    let downloadSignal: AbortSignal | undefined;
    mockFetchWithAuth.mockImplementation((url: string, options?: { signal?: AbortSignal }) => {
      if (url.includes('/download?')) {
        downloadSignal = options?.signal;
        // Hang until aborted, like a large in-flight download.
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }
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

    const cancelButton = await screen.findByTitle('Cancel');
    fireEvent.click(cancelButton);

    expect(downloadSignal?.aborted).toBe(true);
    await waitFor(() => {
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
    });
    // An intentional cancel must not render as a failure.
    expect(screen.queryByText('Failed to download')).not.toBeInTheDocument();
    // Cancelled rows swap the cancel button for a dismiss affordance.
    expect(screen.getByTitle('Dismiss')).toBeInTheDocument();
  });
});

describe('FileManager uploads', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it('marks a cancelled upload as cancelled with the device-side caveat instead of a failure', async () => {
    let uploadSignal: AbortSignal | undefined;
    mockFetchWithAuth.mockImplementation((url: string, options?: { signal?: AbortSignal }) => {
      if (url.includes('/files/upload')) {
        uploadSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
    });

    const { container } = render(
      <FileManager
        deviceId="device-1"
        deviceHostname="workstation-1"
        initialPath="/"
      />
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    // Wait until the upload request is actually in flight.
    await waitFor(() => expect(uploadSignal).toBeDefined());

    fireEvent.click(screen.getByTitle('Cancel'));
    expect(uploadSignal?.aborted).toBe(true);

    await waitFor(() => {
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
    });
    // Honest copy: the dispatched write command may still land on the device.
    expect(screen.getByText(/may still be saved there/)).toBeInTheDocument();
    expect(screen.queryByText('Failed to upload')).not.toBeInTheDocument();
  });
});
