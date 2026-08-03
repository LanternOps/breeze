import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const EXISTING_VERSION = {
  id: 'ver-1',
  version: '1.0.0',
  releaseDate: '2026-01-01T00:00:00Z',
  architecture: 'x64',
  fileType: 'msi',
  isLatest: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Open the add-version form, type a version, and attach a file. */
function fillUploadForm(): HTMLInputElement {
  fireEvent.click(screen.getByRole('button', { name: /add version/i }));
  fireEvent.change(screen.getByPlaceholderText('e.g. 1.0.0'), {
    target: { value: '2.0.0' },
  });
  const file = new File([new Uint8Array(16)], 'installer.msi');
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [file] } });
  return fileInput;
}

const submit = (fileInput: HTMLInputElement) =>
  fireEvent.submit(fileInput.closest('form')!);

async function renderLoaded() {
  render(<SoftwareVersionManager catalogId="cat-1" embedded />);
  await waitFor(() =>
    expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
  );
}

describe('SoftwareVersionManager chunked upload path', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/custom-fields')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.resolve(jsonResponse({ data: [EXISTING_VERSION] }));
    });
  });

  it('routes a file submission through uploadPackageVersion with the form metadata', async () => {
    uploadMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: 'ver-9', version: '2.0.0', isLatest: true } }, true, 201),
    );

    await renderLoaded();
    const fileInput = fillUploadForm();
    submit(fileInput);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'cat-1',
        file: expect.any(File),
        metadata: expect.objectContaining({ version: '2.0.0', architecture: 'x64' }),
        onProgress: expect.any(Function),
      }),
    );
    // The legacy single-request multipart endpoint is no longer called.
    const legacyCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/versions/upload'),
    );
    expect(legacyCall).toBeUndefined();
  });

  it('drives the progress bar from real acknowledged bytes', async () => {
    const gate = deferred<Response>();
    let report: ((sent: number, total: number) => void) | undefined;
    uploadMock.mockImplementation((opts) => {
      report = opts.onProgress;
      return gate.promise;
    });

    await renderLoaded();
    const fileInput = fillUploadForm();
    submit(fileInput);

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

    const label = () => screen.getByTestId('version-upload-progress').textContent ?? '';
    const width = () => screen.getByTestId('version-upload-progress-bar').style.width;

    act(() => report!(0, 1000));
    expect(label()).toContain('0%');
    expect(width()).toBe('0%');

    act(() => report!(250, 1000));
    expect(label()).toContain('25%');
    expect(width()).toBe('25%');

    act(() => report!(750, 1000));
    expect(label()).toContain('75%');
    expect(width()).toBe('75%');

    await act(async () => {
      gate.resolve(
        jsonResponse({ data: { id: 'ver-9', version: '2.0.0', isLatest: true } }, true, 201),
      );
      await gate.promise;
    });
    await waitFor(() =>
      expect(screen.queryByTestId('version-upload-progress')).not.toBeInTheDocument(),
    );
  });

  it('renders a progress regression (lost-state resync to 0 bytes) without breaking', async () => {
    const gate = deferred<Response>();
    let report: ((sent: number, total: number) => void) | undefined;
    uploadMock.mockImplementation((opts) => {
      report = opts.onProgress;
      return gate.promise;
    });

    await renderLoaded();
    const fileInput = fillUploadForm();
    submit(fileInput);
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

    const width = () => screen.getByTestId('version-upload-progress-bar').style.width;

    act(() => report!(800, 1000));
    expect(width()).toBe('80%');

    // Server lost the session state and restarts from zero. The bar must show
    // the restart, stay mounted, and never render a negative width.
    act(() => report!(0, 1000));
    expect(screen.getByTestId('version-upload-progress')).toBeInTheDocument();
    expect(width()).toBe('0%');
    expect(
      screen.getByTestId('version-upload-progress').textContent,
    ).toContain('0%');

    // …and it keeps climbing afterwards.
    act(() => report!(400, 1000));
    expect(width()).toBe('40%');

    // A zero/absent total must not produce NaN%.
    act(() => report!(0, 0));
    expect(width()).toBe('0%');

    await act(async () => {
      gate.resolve(jsonResponse({ data: { id: 'ver-9', version: '2.0.0' } }, true, 201));
      await gate.promise;
    });
  });

  it('surfaces a failing upload Response as the inline error', async () => {
    uploadMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Object storage rejected the upload' }, false, 502),
    );

    await renderLoaded();
    const fileInput = fillUploadForm();
    submit(fileInput);

    await waitFor(() =>
      expect(
        screen.getByText(/Object storage rejected the upload \(HTTP 502\)/),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces the operator-actionable upload_instance_mismatch message verbatim', async () => {
    const message =
      'Upload cannot continue: it was started on a different API server instance ' +
      '(the API restarted, or requests are load-balanced across replicas without ' +
      'session affinity). Enable sticky sessions for the API — or run a single ' +
      'replica — then start the upload again.';
    uploadMock.mockResolvedValueOnce(
      jsonResponse({ error: message, code: 'upload_instance_mismatch' }, false, 409),
    );

    await renderLoaded();
    const fileInput = fillUploadForm();
    submit(fileInput);

    await waitFor(() =>
      expect(screen.getByText(new RegExp('Enable sticky sessions for the API'))).
        toBeInTheDocument(),
    );
    expect(screen.getByText(/session affinity/)).toHaveTextContent('(HTTP 409)');
  });

  describe('cancelling an in-flight upload', () => {
    /** Start an upload and hand back the pieces needed to drive it. */
    async function startUpload() {
      const gate = deferred<Response>();
      let signal: AbortSignal | undefined;
      uploadMock.mockImplementation((opts) => {
        signal = opts.signal;
        return gate.promise;
      });

      await renderLoaded();
      const fileInput = fillUploadForm();
      submit(fileInput);
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
      return { gate, signal: signal! };
    }

    it('aborts the uploader signal when Cancel is pressed mid-upload', async () => {
      const { signal } = await startUpload();

      fireEvent.click(screen.getByTestId('version-form-cancel'));

      expect(signal.aborted).toBe(true);
      expect(screen.queryByTestId('version-upload-progress')).not.toBeInTheDocument();
    });

    it('shows no error banner when the abort rejection arrives', async () => {
      const { gate, signal } = await startUpload();
      fireEvent.click(screen.getByTestId('version-form-cancel'));
      expect(signal.aborted).toBe(true);

      // uploadPackageVersion rejects on abort.
      await act(async () => {
        gate.resolve(
          Promise.reject(
            new DOMException('The operation was aborted.', 'AbortError'),
          ) as unknown as Response,
        );
        await Promise.resolve();
      });

      expect(screen.queryByText(/aborted/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/failed to create version/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/failed to upload version/i)).not.toBeInTheDocument();
      expect(document.querySelector('.text-destructive')).toBeNull();
    });

    it('does not add a version when a completion lands after Cancel', async () => {
      const { gate } = await startUpload();
      fireEvent.click(screen.getByTestId('version-form-cancel'));

      // The chunk loop had already finished; /complete resolves 201 anyway.
      await act(async () => {
        gate.resolve(
          jsonResponse({ data: { id: 'ver-9', version: '2.0.0', isLatest: true } }, true, 201),
        );
        await gate.promise;
      });

      // The version-history table still lists only the pre-existing row.
      expect(screen.queryByRole('button', { name: 'v2.0.0' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'v1.0.0' })).toBeInTheDocument();
      expect(document.querySelector('.text-destructive')).toBeNull();
    });

    it('aborts the upload when the component unmounts', async () => {
      const gate = deferred<Response>();
      let signal: AbortSignal | undefined;
      uploadMock.mockImplementation((opts) => {
        signal = opts.signal;
        return gate.promise;
      });

      const view = render(<SoftwareVersionManager catalogId="cat-1" embedded />);
      await waitFor(() =>
        expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
      );
      const fileInput = fillUploadForm();
      submit(fileInput);
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

      view.unmount();

      expect(signal!.aborted).toBe(true);
      await act(async () => {
        gate.resolve(jsonResponse({ data: { id: 'ver-9' } }, true, 201));
        await gate.promise;
      });
    });

    it('still reports a genuine failure after a previous upload was cancelled', async () => {
      const { signal } = await startUpload();
      fireEvent.click(screen.getByTestId('version-form-cancel'));
      expect(signal.aborted).toBe(true);

      // A fresh submission gets a fresh controller — the stale aborted one must
      // not swallow a real error.
      uploadMock.mockReset();
      uploadMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Object storage rejected the upload' }, false, 502),
      );
      const fileInput = fillUploadForm();
      submit(fileInput);

      await waitFor(() =>
        expect(
          screen.getByText(/Object storage rejected the upload \(HTTP 502\)/),
        ).toBeInTheDocument(),
      );
    });
  });

  it('leaves the metadata-only branch on the plain JSON endpoint', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).startsWith('/custom-fields')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      if (init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ data: { id: 'ver-9', version: '2.0.0' } }, true, 201),
        );
      }
      return Promise.resolve(jsonResponse({ data: [EXISTING_VERSION] }));
    });

    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /add version/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.0.0'), {
      target: { value: '2.0.0' },
    });
    fireEvent.submit(
      (document.querySelector('input[type="file"]') as HTMLInputElement).closest('form')!,
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, init]) =>
            String(u) === '/software/catalog/cat-1/versions' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
