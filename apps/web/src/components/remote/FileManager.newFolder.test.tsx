import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileManager from './FileManager';

const mockFetchWithAuth = vi.fn();
const mockShowToast = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('@/components/shared/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shared/Toast')>();
  return { ...actual, showToast: (...args: unknown[]) => mockShowToast(...args) };
});

const MKDIR_URL = '/system-tools/devices/device-1/files/mkdir';

type Entry = { name: string; path: string; type: 'file' | 'directory' };

function mkdirResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Listing GETs answer with `entries`; the mkdir POST with `mkdir()`. */
function setup(opts: { path?: string; osType?: string; entries?: Entry[]; mkdir?: () => unknown } = {}) {
  const entries = opts.entries ?? [{ name: 'existing', path: '/data/existing', type: 'directory' as const }];
  const mkdir = opts.mkdir ?? (() => Promise.resolve(mkdirResponse(200, { success: true, data: { path: 'x' } })));
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url === MKDIR_URL) return mkdir();
    if (url.includes('/files/drives')) return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
    return Promise.resolve({ ok: true, json: async () => ({ data: entries }) });
  });
  return render(
    <FileManager
      deviceId="device-1"
      deviceHostname="workstation-1"
      initialPath={opts.path ?? '/data'}
      osType={opts.osType}
    />
  );
}

async function openDialog() {
  await screen.findByText('existing');
  fireEvent.click(screen.getByTestId('file-manager-new-folder'));
  return screen.findByTestId('new-folder-name');
}

function typeName(name: string) {
  fireEvent.change(screen.getByTestId('new-folder-name'), { target: { value: name } });
}

function mkdirCalls() {
  return mockFetchWithAuth.mock.calls.filter(([url]) => url === MKDIR_URL);
}

function listingCalls() {
  return mockFetchWithAuth.mock.calls.filter(([url]) => String(url).includes('/files?'));
}

function errorToasts() {
  return mockShowToast.mock.calls.map(([arg]) => arg).filter((arg) => arg.type === 'error');
}

describe('FileManager new folder', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowToast.mockReset();
  });

  it('posts the joined path, confirms, closes and refreshes the listing', async () => {
    setup();
    await openDialog();
    const listingsBefore = listingCalls().length;

    typeName('Reports');
    fireEvent.click(screen.getByTestId('new-folder-submit'));

    await waitFor(() => expect(screen.queryByTestId('new-folder-name')).not.toBeInTheDocument());
    expect(mkdirCalls()).toHaveLength(1);
    const [, init] = mkdirCalls()[0]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ path: '/data/Reports' });
    await waitFor(() => expect(listingCalls().length).toBe(listingsBefore + 1));
    expect(listingCalls().at(-1)![0]).toContain(`path=${encodeURIComponent('/data')}`);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: expect.stringContaining('Reports') })
    );
  });

  it('joins with a backslash on a Windows path', async () => {
    setup({ path: String.raw`C:\Users` });
    await openDialog();

    typeName('Reports');
    fireEvent.click(screen.getByTestId('new-folder-submit'));

    await waitFor(() => expect(mkdirCalls()).toHaveLength(1));
    expect(JSON.parse(mkdirCalls()[0]![1].body)).toEqual({ path: String.raw`C:\Users\Reports` });
  });

  it('submits on Enter and trims the name', async () => {
    setup();
    await openDialog();

    typeName('  Reports  ');
    fireEvent.submit(screen.getByTestId('new-folder-form'));

    await waitFor(() => expect(mkdirCalls()).toHaveLength(1));
    expect(JSON.parse(mkdirCalls()[0]![1].body)).toEqual({ path: '/data/Reports' });
  });

  it('records the creation in the activity panel', async () => {
    setup();
    await openDialog();

    typeName('Reports');
    fireEvent.click(screen.getByTestId('new-folder-submit'));
    await waitFor(() => expect(screen.queryByTestId('new-folder-name')).not.toBeInTheDocument());

    fireEvent.click(screen.getByText(/^Activity/));
    expect(await screen.findByText('/data/Reports')).toBeInTheDocument();
    // The toolbar button plus the activity row's action label.
    expect(screen.getAllByText('New folder')).toHaveLength(2);
  });

  it('cancel closes without posting', async () => {
    setup();
    await openDialog();

    typeName('Reports');
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.queryByTestId('new-folder-name')).not.toBeInTheDocument());
    expect(mkdirCalls()).toHaveLength(0);
  });

  it('starts empty when reopened after a cancel', async () => {
    setup();
    await openDialog();
    typeName('Reports');
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByTestId('new-folder-name')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('file-manager-new-folder'));

    expect(await screen.findByTestId('new-folder-name')).toHaveValue('');
  });

  describe('name validation', () => {
    it('keeps submit disabled while the name is blank', async () => {
      setup();
      await openDialog();

      expect(screen.getByTestId('new-folder-submit')).toBeDisabled();
      typeName('   ');
      expect(screen.getByTestId('new-folder-submit')).toBeDisabled();
      expect(screen.queryByTestId('new-folder-error')).not.toBeInTheDocument();

      fireEvent.submit(screen.getByTestId('new-folder-form'));
      expect(mkdirCalls()).toHaveLength(0);
    });

    it.each([
      ['a forward slash', 'a/b'],
      ['a backslash', String.raw`a\b`],
      ['a bare dot', '.'],
      ['a bare double dot', '..'],
    ])('refuses %s', async (_label, name) => {
      setup();
      await openDialog();

      typeName(name);

      expect(screen.getByTestId('new-folder-error')).toBeInTheDocument();
      expect(screen.getByTestId('new-folder-submit')).toBeDisabled();
      fireEvent.submit(screen.getByTestId('new-folder-form'));
      expect(mkdirCalls()).toHaveLength(0);
    });

    it('refuses a name already in the listing, because the agent would report success', async () => {
      setup();
      await openDialog();

      typeName('existing');

      expect(screen.getByTestId('new-folder-error')).toHaveTextContent(/already exists/i);
      fireEvent.submit(screen.getByTestId('new-folder-form'));
      expect(mkdirCalls()).toHaveLength(0);
    });

    it('passes the device OS through, so a case-only clash is caught on macOS', async () => {
      setup({ osType: 'macos' });
      await openDialog();

      typeName('EXISTING');

      expect(screen.getByTestId('new-folder-error')).toHaveTextContent(/already exists/i);
    });

    it('allows a case-only difference on Linux', async () => {
      setup({ osType: 'linux' });
      await openDialog();

      typeName('EXISTING');

      expect(screen.queryByTestId('new-folder-error')).not.toBeInTheDocument();
    });
  });

  it('disables New folder while the listing failed (agent not connected)', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/files/drives')) return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
      return Promise.resolve({ ok: false, status: 502, json: async () => ({ error: 'Agent is not currently connected' }) });
    });
    render(<FileManager deviceId="device-1" deviceHostname="workstation-1" initialPath="/data" />);
    await screen.findByText(/not currently connected/i);
    expect(screen.getByTestId('file-manager-new-folder')).toBeDisabled();
  });

  describe('failures', () => {
    it('toasts the agent refusal and keeps the dialog open with the name', async () => {
      setup({
        mkdir: () => Promise.resolve(mkdirResponse(422, {
          error: 'operation denied on system path: /proc/new',
          code: 'AGENT_COMMAND_REJECTED',
        })),
      });
      await openDialog();
      const listingsBefore = listingCalls().length;

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));

      await waitFor(() => expect(errorToasts()).toHaveLength(1));
      expect(errorToasts()[0].message).toBe('operation denied on system path: /proc/new');
      expect(screen.getByTestId('new-folder-name')).toHaveValue('new');
      expect(listingCalls().length).toBe(listingsBefore);
    });

    it('toasts the file system error instead of a generic agent-unreachable message', async () => {
      setup({
        mkdir: () => Promise.resolve(mkdirResponse(500, {
          error: 'failed to create directory: permission denied',
          code: 'AGENT_EXECUTION_FAILED',
        })),
      });
      await openDialog();

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));

      await waitFor(() => expect(errorToasts()).toHaveLength(1));
      expect(errorToasts()[0].message).toBe('failed to create directory: permission denied');
    });

    it('records a failure in the activity panel with its reason', async () => {
      setup({
        mkdir: () => Promise.resolve(mkdirResponse(500, {
          error: 'failed to create directory: permission denied',
          code: 'AGENT_EXECUTION_FAILED',
        })),
      });
      await openDialog();

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));
      await waitFor(() => expect(errorToasts()).toHaveLength(1));

      fireEvent.click(screen.getByText(/^Activity/));
      expect(await screen.findByText('/data/new')).toBeInTheDocument();
      expect(screen.getByText('failed to create directory: permission denied')).toBeInTheDocument();
    });

    it('keeps the localized copy for a device that is offline', async () => {
      setup({
        mkdir: () => Promise.resolve(mkdirResponse(503, {
          error: 'The device is offline.',
          code: 'DEVICE_OFFLINE',
        })),
      });
      await openDialog();

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));

      await waitFor(() => expect(errorToasts()).toHaveLength(1));
      // The errors:DEVICE_OFFLINE translation, not the API's text.
      expect(errorToasts()[0].message).toBe('The device is offline');
      expect(screen.getByTestId('new-folder-name')).toBeInTheDocument();
    });

    it.each(['quarantined', 'updating'])('names the real state of a device that is %s, not "offline"', async (state) => {
      const text = `The device is ${state} and cannot run commands.`;
      setup({
        mkdir: () => Promise.resolve(mkdirResponse(503, { error: text, code: 'DEVICE_OFFLINE' })),
      });
      await openDialog();

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));

      await waitFor(() => expect(errorToasts()).toHaveLength(1));
      expect(errorToasts()[0].message).toBe(text);
    });

    it('on an unverified timeout, warns that it may have completed, closes and refreshes', async () => {
      const unverified = "The device didn't respond in time. The operation may have completed — refresh to verify before retrying.";
      setup({
        mkdir: () => Promise.resolve(mkdirResponse(503, {
          error: unverified,
          code: 'AGENT_TIMEOUT',
          unverified: true,
        })),
      });
      await openDialog();
      const listingsBefore = listingCalls().length;

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));

      await waitFor(() => expect(errorToasts()).toHaveLength(1));
      expect(errorToasts()[0].message).toBe(unverified);
      await waitFor(() => expect(screen.queryByTestId('new-folder-name')).not.toBeInTheDocument());
      await waitFor(() => expect(listingCalls().length).toBe(listingsBefore + 1));

      fireEvent.click(screen.getByText(/^Activity/));
      expect(await screen.findByText('/data/new')).toBeInTheDocument();
      expect(screen.getByText(unverified)).toBeInTheDocument();
    });

    it('toasts the fallback when the request never reaches the API', async () => {
      setup({ mkdir: () => Promise.reject(new TypeError('network down')) });
      await openDialog();

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));

      await waitFor(() => expect(errorToasts()).toHaveLength(1));
      expect(errorToasts()[0].message).toBe('Failed to create folder');
      expect(screen.getByTestId('new-folder-name')).toBeInTheDocument();
    });

    it('stays silent on a 401, which the auth redirect handles', async () => {
      setup({ mkdir: () => Promise.resolve(mkdirResponse(401, { error: 'Unauthorized' })) });
      await openDialog();

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));

      await waitFor(() => expect(mkdirCalls()).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId('new-folder-submit')).not.toBeDisabled());
      expect(errorToasts()).toHaveLength(0);
    });

    it('re-enables submit after a failure so the user can retry', async () => {
      const responses = [
        () => Promise.resolve(mkdirResponse(500, { error: 'boom', code: 'AGENT_EXECUTION_FAILED' })),
        () => Promise.resolve(mkdirResponse(200, { success: true, data: { path: '/data/new' } })),
      ];
      setup({ mkdir: () => responses.shift()!() });
      await openDialog();

      typeName('new');
      fireEvent.click(screen.getByTestId('new-folder-submit'));
      await waitFor(() => expect(errorToasts()).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId('new-folder-submit')).not.toBeDisabled());

      fireEvent.click(screen.getByTestId('new-folder-submit'));
      await waitFor(() => expect(screen.queryByTestId('new-folder-name')).not.toBeInTheDocument());
      expect(mkdirCalls()).toHaveLength(2);
    });
  });
});
