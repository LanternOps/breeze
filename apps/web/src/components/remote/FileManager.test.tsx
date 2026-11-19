import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileManager from './FileManager';

const mockFetchWithAuth = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

describe('FileManager address bar', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  function renderFileManager(initialPath: string, osType?: string) {
    render(<FileManager deviceId="device-1" deviceHostname="workstation-1" initialPath={initialPath} osType={osType} />);
    return screen.getByRole('textbox', { name: 'Folder path' });
  }

  it.each([
    ['C:\\', 'C:\\Program Files\\Reports & Logs', 'C:\\Program Files\\Reports & Logs'],
    ['C:\\', 'D:', 'D:\\'],
    ['/home', '/srv/daily\\reports ', '/srv/daily\\reports '],
  ])('opens an entered path from %s with Enter', async (initialPath, typedPath, requestedPath) => {
    const user = userEvent.setup();
    const expectedUrl = `/system-tools/devices/device-1/files?${new URLSearchParams({ path: requestedPath })}`;
    mockFetchWithAuth.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url === expectedUrl
        ? { path: requestedPath, data: [{ name: 'report.txt', type: 'file', path: 'report.txt' }] }
        : { data: [] },
    }));

    const address = renderFileManager(initialPath);
    await screen.findByText('Empty Directory');
    expect(address).toHaveValue(initialPath);

    await user.click(address);
    fireEvent.change(address, { target: { value: typedPath } });
    expect(mockFetchWithAuth).not.toHaveBeenCalledWith(expectedUrl);
    await user.keyboard('{Enter}');

    expect(await screen.findByText('report.txt')).toBeInTheDocument();
    expect(address).toHaveValue(requestedPath);
    await user.click(screen.getByTitle('Home'));
    await screen.findByText('Empty Directory');
    expect(address).toHaveValue(initialPath);
  });

  it.each([
    ['C:\\', 'windows', '\\\\host\\share'],
    ['C:\\', 'windows', '//host/share'],
    ['/home', 'linux', '//host/share'],
    ['/home', 'linux', '/\\host/share'],
    ['/home', 'linux', '/??/host/share'],
    ['/home', 'windows', '/srv'],
  ])('rejects %s (%s) → %s without requesting a listing', async (initialPath, osType, typedPath) => {
    const user = userEvent.setup();
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    const address = renderFileManager(initialPath, osType);
    await screen.findByText('Empty Directory');
    mockFetchWithAuth.mockClear();

    fireEvent.change(address, { target: { value: typedPath } });
    expect(address).toBeInvalid();
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('keeps the draft editable and preserves it through a same-folder refresh', async () => {
    const user = userEvent.setup();
    const root = { ok: true, json: async () => ({ data: [], path: '/' }) };
    const refresh = Promise.withResolvers<typeof root>();
    mockFetchWithAuth.mockResolvedValue(root);

    const address = renderFileManager('/');
    await screen.findByText('Empty Directory');
    mockFetchWithAuth.mockReturnValueOnce(refresh.promise);

    fireEvent.change(address, { target: { value: '/srv' } });
    await user.click(screen.getByTitle('Refresh'));
    await user.click(address);
    await user.keyboard('/logs');

    await act(async () => refresh.resolve(root));
    expect(address).toHaveValue('/srv/logs');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();

    await user.click(screen.getByTitle('Home'));
    await screen.findByText('Empty Directory');
    expect(address).toHaveValue('/');
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
  });

  it('keeps the latest folder when an older navigation finishes last', async () => {
    const user = userEvent.setup();
    function listing(path: string, name: string) {
      return { ok: true, json: async () => ({ path, data: [{ name, type: 'file', path: name }] }) };
    }
    const older = Promise.withResolvers<ReturnType<typeof listing>>();
    const newer = Promise.withResolvers<ReturnType<typeof listing>>();
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    const address = renderFileManager('/');
    await screen.findByText('Empty Directory');
    mockFetchWithAuth.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    fireEvent.change(address, { target: { value: '/old' } });
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    await user.click(screen.getByTitle('Home'));

    await act(async () => newer.resolve(listing('/', 'current.txt')));
    await act(async () => older.resolve(listing('/old', 'stale.txt')));

    expect(address).toHaveValue('/');
    expect(screen.getByText('current.txt')).toBeInTheDocument();
    expect(screen.queryByText('stale.txt')).not.toBeInTheDocument();
  });

  it('shows a failed lookup and keeps the address available for correction', async () => {
    const user = userEvent.setup();
    mockFetchWithAuth.mockImplementation(async (url: string) => url.endsWith('path=%2Fmissing')
      ? { ok: false, json: async () => ({ error: 'Directory does not exist' }) }
      : { ok: true, json: async () => ({ data: [] }) });

    const address = renderFileManager('/');
    await screen.findByText('Empty Directory');

    fireEvent.change(address, { target: { value: 'relative' } });
    expect(address).toBeInvalid();
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

    fireEvent.change(address, { target: { value: '/missing' } });
    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Directory does not exist');
    expect(address).toHaveValue('/missing');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockFetchWithAuth).toHaveBeenLastCalledWith('/system-tools/devices/device-1/files?path=%2Fmissing');
    await screen.findByRole('alert');

    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    const table = screen.getByRole('table');
    fireEvent.dragOver(table);
    expect(screen.queryByText('Drop Files')).not.toBeInTheDocument();
    const file = new File(['content'], 'blocked.txt', { type: 'text/plain' });
    fireEvent.drop(table, { dataTransfer: { files: [file] } });
    expect(screen.queryByText('blocked.txt')).not.toBeInTheDocument();
    expect(mockFetchWithAuth).not.toHaveBeenCalledWith(expect.stringContaining('/files/upload'), expect.anything());

    await user.click(address);
    await user.keyboard('{Escape}');
    expect(address).toHaveValue('/');
  });
});

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

  describe('over-cap pre-flight', () => {
    // The agent refuses any file_read over 1MB. The listing already knows each
    // entry's size, so these assert the UI never spends a doomed round trip —
    // and, just as importantly, that it never blocks a transfer the agent WOULD
    // have served.
    const OVER_CAP = 2 * 1024 * 1024;
    const AT_CAP = 1024 * 1024;

    function renderWithEntry(entry: Record<string, unknown>) {
      mockFetchWithAuth.mockImplementation((url: string) => {
        if (url.includes('/download?')) {
          return Promise.resolve({
            ok: true,
            blob: async () => new Blob(['x']),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [entry] }),
        });
      });

      return render(
        <FileManager
          deviceId="device-1"
          deviceHostname="workstation-1"
          initialPath="/"
        />
      );
    }

    function downloadUrlCalls() {
      return mockFetchWithAuth.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/download?')
      );
    }

    it('refuses an over-cap download with the real numbers and never calls the API', async () => {
      renderWithEntry({ name: 'manual.pdf', path: '/manual.pdf', type: 'file', size: OVER_CAP });

      await screen.findByText('manual.pdf');
      fireEvent.click(screen.getByTitle('Download'));

      await waitFor(() => {
        expect(
          screen.getByText('Too large to download (2.0 MB). The file browser transfers files up to 1.0 MB.')
        ).toBeInTheDocument();
      });
      // The point of the guard: no round trip at all.
      expect(downloadUrlCalls()).toHaveLength(0);
      // And it must not be reported as the old generic failure.
      expect(screen.queryByText('Failed to download')).not.toBeInTheDocument();
    });

    it('allows a file exactly at the cap through — the agent rejects only what exceeds it', async () => {
      renderWithEntry({ name: 'atcap.bin', path: '/atcap.bin', type: 'file', size: AT_CAP });

      await screen.findByText('atcap.bin');
      fireEvent.click(screen.getByTitle('Download'));

      await waitFor(() => expect(downloadUrlCalls()).toHaveLength(1));
    });

    it('lets a macOS alias through even when the alias file itself looks over-cap', async () => {
      // `size` describes the alias, not the target the agent resolves and reads,
      // so the client cannot judge it — fail open and let the agent decide.
      renderWithEntry({
        name: 'shortcut',
        path: '/shortcut',
        type: 'file',
        size: OVER_CAP,
        isAlias: true,
        aliasTarget: '/elsewhere/real.pdf',
      });

      await screen.findByText('shortcut');
      fireEvent.click(screen.getByTitle('Download'));

      await waitFor(() => expect(downloadUrlCalls()).toHaveLength(1));
    });

    it('lets an entry with no reported size through rather than guessing', async () => {
      renderWithEntry({ name: 'unsized.bin', path: '/unsized.bin', type: 'file' });

      await screen.findByText('unsized.bin');
      fireEvent.click(screen.getByTitle('Download'));

      await waitFor(() => expect(downloadUrlCalls()).toHaveLength(1));
    });
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

    await screen.findByText('Empty Directory');
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

  it('surfaces the 120s watchdog timeout as unverified, not as a user cancel', async () => {
    // The watchdog aborts the SAME controller as user cancel — this pins the
    // distinction so a future "if AbortError then treat as cancel" refactor
    // cannot silently eat real timeouts.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let uploadSignal: AbortSignal | undefined;
      mockFetchWithAuth.mockImplementation((url: string, options?: { signal?: AbortSignal }) => {
        if (url.includes('/files/upload')) {
          uploadSignal = options?.signal;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The user aborted a request.', 'AbortError'));
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

      await screen.findByText('Empty Directory');
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['hello world'], 'big.bin', { type: 'application/octet-stream' });
      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => expect(uploadSignal).toBeDefined());

      // No user cancel — let the watchdog fire.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(uploadSignal?.aborted).toBe(true);

      await waitFor(() => {
        expect(screen.getByText(/Upload timed out after 2 minutes/)).toBeInTheDocument();
      });
      // A timeout is not a user cancel — and not the browser's abort boilerplate.
      expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
      expect(screen.queryByText('The user aborted a request.')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FileManager directory load errors', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it('translates a stable error code from the API instead of showing the raw English string', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'The device is offline.', code: 'DEVICE_OFFLINE' }),
    });

    render(
      <FileManager
        deviceId="device-1"
        deviceHostname="workstation-1"
        initialPath="/"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('The device is offline')).toBeInTheDocument();
    });
    expect(screen.queryByText('The device is offline.')).not.toBeInTheDocument();
  });

  it('falls back to the raw error string when the code has no translation', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Something unexpected happened.', code: 'SOME_UNKNOWN_CODE' }),
    });

    render(
      <FileManager
        deviceId="device-1"
        deviceHostname="workstation-1"
        initialPath="/"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Something unexpected happened.')).toBeInTheDocument();
    });
  });
});
