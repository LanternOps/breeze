import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddPackageModal from './AddPackageModal';
import { fetchWithAuth } from '../../stores/auth';
import { uploadPackageVersion } from '../../lib/softwarePackageUpload';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn(), useAuthStore: { getState: () => ({ tokens: null }) } }));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// DetectionRulesEditor is exercised elsewhere; it lives behind the Advanced
// disclosure and isn't needed for the create-flow assertions here.
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const uploadMock = vi.mocked(uploadPackageVersion);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

/** Route mock keyed by URL + method so effect-order doesn't matter. */
function routeMock(handlers: {
  customFields?: unknown;
  createCatalog?: () => Response;
  createVersion?: () => Response;
}) {
  fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
    if (url.startsWith('/custom-fields')) {
      return Promise.resolve(jsonResponse({ data: handlers.customFields ?? [] }));
    }
    if (url === '/software/catalog' && opts?.method === 'POST') {
      return Promise.resolve((handlers.createCatalog ?? (() => jsonResponse({ data: { id: 'cat-1' } })))());
    }
    if (/\/software\/catalog\/.+\/versions$/.test(url) && opts?.method === 'POST') {
      return Promise.resolve((handlers.createVersion ?? (() => jsonResponse({ data: { id: 'ver-1' } })))());
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

const fillMinimum = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Google Chrome' } });
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } });
  fireEvent.change(screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'), {
    target: { value: 'https://dl.example.com/chrome.msi' },
  });
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Fill the form with a file source instead of a download URL. */
const fillFileForm = (): File => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Big App' } });
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: '3.1.4' } });
  fireEvent.click(screen.getByRole('tab', { name: /upload file/i }));
  const file = new File([new Uint8Array(32)], 'bigapp.msi');
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [file] } });
  return file;
};

const submitCreate = async () =>
  fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

describe('AddPackageModal', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    showToast.mockReset();
  });

  it('keeps Create disabled until name, version and a source are present', async () => {
    routeMock({});
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

    const submit = screen.getByRole('button', { name: 'Create package' });
    expect(submit).toBeDisabled();

    fillMinimum();
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it('creates the catalog item then its first version and reports the new package', async () => {
    const onCreated = vi.fn();
    routeMock({});
    render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);

    fillMinimum();
    fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    const catalogCall = fetchMock.mock.calls.find(([u, o]) => u === '/software/catalog' && o?.method === 'POST');
    const versionCall = fetchMock.mock.calls.find(([u, o]) => /\/versions$/.test(u as string) && o?.method === 'POST');
    expect(catalogCall).toBeTruthy();
    expect(versionCall).toBeTruthy();

    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-1', name: 'Google Chrome', versionCount: 1 }),
    );
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  // A URL package used to carry no installer type at all, so the agent saved the
  // MSI as package.exe and exec'd it directly — ERROR_BAD_EXE_FORMAT on Windows,
  // with the operator's msiexec command silently discarded.
  describe('installer type (URL source)', () => {
    const versionBody = () => {
      const call = fetchMock.mock.calls.find(
        ([u, o]) => /\/versions$/.test(u as string) && o?.method === 'POST',
      );
      return JSON.parse((call?.[1] as RequestInit).body as string);
    };

    it('prefills the msiexec commands from a .msi URL', async () => {
      routeMock({});
      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      fillMinimum();

      await waitFor(() =>
        expect(screen.getByLabelText('Silent install args')).toHaveValue(
          'msiexec /i "{file}" /qn /norestart',
        ),
      );
    });

    it('leaves the install command alone for a non-MSI URL', async () => {
      routeMock({});
      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      fireEvent.change(screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'), {
        target: { value: 'https://dl.example.com/setup.exe' },
      });

      // An EXE's silent switch is vendor-specific; guessing one would install
      // interactively (or not at all) on an unattended machine.
      expect(screen.getByLabelText('Silent install args')).toHaveValue('');
    });

    it('retracts the msiexec prefill when the URL is corrected to a non-MSI', async () => {
      routeMock({});
      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      const urlInput = screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi');

      fireEvent.change(urlInput, { target: { value: 'https://dl.example.com/acme.msi' } });
      await waitFor(() =>
        expect(screen.getByLabelText('Silent install args')).toHaveValue(
          'msiexec /i "{file}" /qn /norestart',
        ),
      );

      // Leaving msiexec behind would ship `setup.exe msiexec /i …` to the agent.
      fireEvent.change(urlInput, { target: { value: 'https://dl.example.com/setup.exe' } });
      await waitFor(() =>
        expect(screen.getByLabelText('Silent install args')).toHaveValue(''),
      );
    });

    it('keeps a hand-typed command across a URL change', async () => {
      routeMock({});
      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      const urlInput = screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi');

      fireEvent.change(screen.getByLabelText('Silent install args'), {
        target: { value: '/S /norestart' },
      });
      fireEvent.change(urlInput, { target: { value: 'https://dl.example.com/acme.msi' } });

      expect(screen.getByLabelText('Silent install args')).toHaveValue('/S /norestart');
    });

    it('retracts the prefill when the type selector is changed away from MSI', async () => {
      routeMock({});
      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      fireEvent.change(screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'), {
        target: { value: 'https://dl.example.com/acme.msi' },
      });
      await waitFor(() =>
        expect(screen.getByLabelText('Silent install args')).not.toHaveValue(''),
      );

      fireEvent.change(screen.getByTestId('package-file-type'), { target: { value: 'exe' } });
      expect(screen.getByLabelText('Silent install args')).toHaveValue('');
    });

    it('omits fileType when left on auto so the server infers it', async () => {
      const onCreated = vi.fn();
      routeMock({});
      render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);
      fillMinimum();
      await submitCreate();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());

      expect(versionBody()).not.toHaveProperty('fileType');
      expect(versionBody().downloadUrl).toBe('https://dl.example.com/chrome.msi');
    });

    it('sends an explicitly chosen fileType for a URL with no usable extension', async () => {
      const onCreated = vi.fn();
      routeMock({});
      render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme' } });
      fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } });
      fireEvent.change(screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'), {
        target: { value: 'https://vendor.example.com/download.php?product=acme' },
      });
      fireEvent.change(screen.getByTestId('package-file-type'), { target: { value: 'msi' } });

      await submitCreate();
      await waitFor(() => expect(onCreated).toHaveBeenCalled());

      expect(versionBody().fileType).toBe('msi');
    });
  });

  it('blocks submit when the URL contains an unknown variable', async () => {
    routeMock({});
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'App' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2.0' } });
    fireEvent.change(screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'), {
      target: { value: 'https://dl/{{org.bogus}}/app.msi' },
    });

    expect(await screen.findByText(/Unknown variable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create package' })).toBeDisabled();
  });

  it('on version-write failure keeps the created catalog id and retries only the version step', async () => {
    const onCreated = vi.fn();
    let versionAttempts = 0;
    routeMock({
      createVersion: () => {
        versionAttempts += 1;
        return versionAttempts === 1
          ? jsonResponse({ error: 'boom' }, false, 500)
          : jsonResponse({ data: { id: 'ver-1' } });
      },
    });
    render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);

    fillMinimum();
    fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

    // First attempt fails on the version write; onCreated must NOT fire and the
    // button flips to a retry label.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry adding version' })).toBeInTheDocument(),
    );
    expect(onCreated).not.toHaveBeenCalled();

    // Retry: succeeds, and the catalog item is NOT created a second time.
    fireEvent.click(screen.getByRole('button', { name: 'Retry adding version' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    const catalogPosts = fetchMock.mock.calls.filter(
      ([u, o]) => u === '/software/catalog' && o?.method === 'POST',
    );
    expect(catalogPosts).toHaveLength(1);
    expect(versionAttempts).toBe(2);
  });

  it('surfaces the created package (0 versions) if the user cancels after a version-write failure', async () => {
    const onCreated = vi.fn();
    routeMock({ createVersion: () => jsonResponse({ error: 'boom' }, false, 500) });
    render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);

    fillMinimum();
    fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

    // Version write failed → button flips to retry, catalog id retained.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry adding version' })).toBeInTheDocument(),
    );

    // Cancelling now must NOT leave an invisible orphan — the created package is
    // surfaced with versionCount 0 so it appears in the catalog.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-1', name: 'Google Chrome', versionCount: 0 }),
    );
  });

  describe('package-manager source', () => {
    const CHROME = {
      platform: 'windows',
      kind: 'winget',
      packageId: 'Google.Chrome',
      name: 'Google Chrome',
      vendor: 'Google',
    };

    /** Adds the package-search + import-package routes to the base mock. */
    function managerRouteMock(opts: { import?: () => Response } = {}) {
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url.startsWith('/custom-fields')) return Promise.resolve(jsonResponse({ data: [] }));
        if (url.startsWith('/software/package-search')) {
          return Promise.resolve(jsonResponse({ results: [CHROME] }));
        }
        if (url.startsWith('/software/catalog/import-package') && init?.method === 'POST') {
          return Promise.resolve(
            (opts.import ??
              (() => jsonResponse({ data: { catalogItem: { id: 'cat-9' }, methods: [] } }, true, 201)))(),
          );
        }
        return Promise.resolve(jsonResponse({}, false, 404));
      });
    }

    const pickChrome = async () => {
      fireEvent.click(screen.getByRole('tab', { name: /package manager/i }));
      fireEvent.change(screen.getByLabelText('Search packages'), {
        target: { value: 'chrome' },
      });
      fireEvent.click(await screen.findByRole('button', { name: /Google Chrome/ }));
    };

    it('hides the version, architecture and installer-arg fields', async () => {
      managerRouteMock();
      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

      expect(screen.getByLabelText('Version')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: /package manager/i }));

      expect(screen.queryByLabelText('Version')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Architecture')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Silent install args')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Advanced options/i }));
      expect(screen.queryByLabelText('Silent uninstall args')).not.toBeInTheDocument();
      // Description is package-level, so it stays.
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
    });

    it('requires at least one selected package before submitting', async () => {
      managerRouteMock();
      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

      fireEvent.click(screen.getByRole('tab', { name: /package manager/i }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chrome' } });

      expect(screen.getByText('Select at least one package')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create package' })).toBeDisabled();
    });

    it('prefills name and vendor from the first pick and imports in a single POST', async () => {
      const onCreated = vi.fn();
      const onClose = vi.fn();
      managerRouteMock();
      render(<AddPackageModal open onClose={onClose} onCreated={onCreated} />);

      await pickChrome();

      // Identity prefilled from the search result — no version required.
      await waitFor(() =>
        expect(screen.getByLabelText('Name')).toHaveValue('Google Chrome'),
      );
      expect(screen.getByLabelText('Vendor')).toHaveValue('Google');

      fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

      const imports = fetchMock.mock.calls.filter(
        ([u, o]) =>
          String(u).startsWith('/software/catalog/import-package') &&
          (o as RequestInit)?.method === 'POST',
      );
      expect(imports).toHaveLength(1);
      expect(JSON.parse(String((imports[0]![1] as RequestInit).body))).toMatchObject({
        name: 'Google Chrome',
        vendor: 'Google',
        methods: [{ platform: 'windows', kind: 'winget', packageId: 'Google.Chrome' }],
      });

      // The two-step catalog→version flow is NOT used on this path.
      expect(
        fetchMock.mock.calls.filter(([u]) => u === '/software/catalog'),
      ).toHaveLength(0);
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'cat-9' }));
      expect(onClose).toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });

    it('surfaces an import failure and keeps the modal open', async () => {
      const onCreated = vi.fn();
      const onClose = vi.fn();
      managerRouteMock({
        import: () => jsonResponse({ error: 'Duplicate platform and kind' }, false, 400),
      });
      render(<AddPackageModal open onClose={onClose} onCreated={onCreated} />);

      await pickChrome();
      fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: 'Duplicate platform and kind' }),
        ),
      );
      expect(onCreated).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      // No orphan catalog row to retry from — the import is one transaction.
      expect(
        screen.queryByRole('button', { name: 'Retry adding version' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('chunked upload (file source)', () => {
    it('routes the file source through the chunked uploader inside runAction', async () => {
      const onCreated = vi.fn();
      routeMock({});
      uploadMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));

      render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);
      const file = fillFileForm();
      await submitCreate();

      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(uploadMock).toHaveBeenCalledWith(
        expect.objectContaining({
          catalogId: 'cat-1',
          file,
          metadata: expect.objectContaining({ version: '3.1.4', architecture: 'x64' }),
          onProgress: expect.any(Function),
        }),
      );
      // The legacy single-request multipart endpoint is not used any more.
      const legacyCall = fetchMock.mock.calls.find(([u]) =>
        String(u).includes('/versions/upload'),
      );
      expect(legacyCall).toBeUndefined();
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });

    it('keeps the catalog id for retry when the chunked upload fails (runAction error path)', async () => {
      const onCreated = vi.fn();
      routeMock({});
      uploadMock.mockResolvedValueOnce(jsonResponse({ error: 'Upload is incomplete' }, false, 409));

      render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);
      fillFileForm();
      await submitCreate();

      // A resolved-but-failing Response is a FAILURE, not a silent success:
      // runAction parses the body and toasts the server's message.
      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: 'Upload is incomplete' }),
        ),
      );
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      expect(onCreated).not.toHaveBeenCalled();

      // Catalog item created exactly once; the retry resumes at the version step.
      const catalogCreates = fetchMock.mock.calls.filter(
        ([u, o]) => u === '/software/catalog' && (o as RequestInit)?.method === 'POST',
      );
      expect(catalogCreates).toHaveLength(1);

      uploadMock.mockResolvedValueOnce(jsonResponse({ data: { id: 'ver-1' } }, true, 201));
      fireEvent.click(await screen.findByRole('button', { name: 'Retry adding version' }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(
        fetchMock.mock.calls.filter(
          ([u, o]) => u === '/software/catalog' && (o as RequestInit)?.method === 'POST',
        ),
      ).toHaveLength(1);
      expect(uploadMock).toHaveBeenCalledTimes(2);
    });

    it('surfaces the operator-actionable upload_instance_mismatch message', async () => {
      const message =
        'Upload cannot continue: it was started on a different API server instance ' +
        '(the API restarted, or requests are load-balanced across replicas without ' +
        'session affinity). Enable sticky sessions for the API — or run a single ' +
        'replica — then start the upload again.';
      routeMock({});
      uploadMock.mockResolvedValueOnce(
        jsonResponse({ error: message, code: 'upload_instance_mismatch' }, false, 409),
      );

      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      fillFileForm();
      await submitCreate();

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message }),
        ),
      );
    });

    it('renders real progress, including a lost-state resync back to 0%', async () => {
      const gate = deferred<Response>();
      let report: ((sent: number, total: number) => void) | undefined;
      routeMock({});
      uploadMock.mockImplementation((opts) => {
        report = opts.onProgress;
        return gate.promise;
      });

      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      fillFileForm();
      await submitCreate();
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

      const label = () => screen.getByTestId('package-upload-progress').textContent ?? '';
      const width = () => screen.getByTestId('package-upload-progress-bar').style.width;

      // Visible from the start — never gated on `progress > 0`.
      expect(width()).toBe('0%');

      act(() => report!(250, 1000));
      expect(width()).toBe('25%');
      expect(label()).toContain('25%');

      act(() => report!(750, 1000));
      expect(width()).toBe('75%');

      // Lost-state resync: the server legitimately restarts from zero. The bar
      // must stay mounted, show the regression, and never go negative or NaN.
      act(() => report!(0, 1000));
      expect(screen.getByTestId('package-upload-progress')).toBeInTheDocument();
      expect(width()).toBe('0%');
      act(() => report!(400, 1000));
      expect(width()).toBe('40%');
      act(() => report!(5, 0));
      expect(width()).toBe('0%');

      await act(async () => {
        gate.resolve(jsonResponse({ data: { id: 'ver-1' } }, true, 201));
        await gate.promise;
      });
      await waitFor(() =>
        expect(screen.queryByTestId('package-upload-progress')).not.toBeInTheDocument(),
      );
    });

    it('aborts the in-flight upload on cancel and exits quietly (no error toast)', async () => {
      const onCreated = vi.fn();
      const onClose = vi.fn();
      const gate = deferred<Response>();
      let signal: AbortSignal | undefined;
      routeMock({});
      uploadMock.mockImplementation((opts) => {
        signal = opts.signal;
        return gate.promise;
      });

      render(<AddPackageModal open onClose={onClose} onCreated={onCreated} />);
      fillFileForm();
      await submitCreate();
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(signal!.aborted).toBe(true);
      expect(onClose).toHaveBeenCalled();

      // uploadPackageVersion REJECTS on abort — a cancel the user asked for must
      // not toast, and must not resurrect the version they abandoned.
      await act(async () => {
        gate.resolve(
          Promise.reject(
            new DOMException('The operation was aborted.', 'AbortError'),
          ) as unknown as Response,
        );
        await Promise.resolve();
      });

      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      // The catalog item WAS created, so it is surfaced as a 0-version package
      // rather than left as an invisible orphan.
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cat-1', versionCount: 0 }),
      );
    });

    it('does not report success when a completion lands after the cancel', async () => {
      const onCreated = vi.fn();
      const gate = deferred<Response>();
      routeMock({});
      uploadMock.mockImplementation(() => gate.promise);

      render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);
      fillFileForm();
      await submitCreate();
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      // The chunk loop had already finished; /complete resolves 201 anyway.
      await act(async () => {
        gate.resolve(jsonResponse({ data: { id: 'ver-1' } }, true, 201));
        await gate.promise;
      });

      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ versionCount: 0 }),
      );
    });

    it('aborts the upload when the modal unmounts', async () => {
      const gate = deferred<Response>();
      let signal: AbortSignal | undefined;
      routeMock({});
      uploadMock.mockImplementation((opts) => {
        signal = opts.signal;
        return gate.promise;
      });

      const view = render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      fillFileForm();
      await submitCreate();
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

      view.unmount();
      expect(signal!.aborted).toBe(true);

      await act(async () => {
        gate.resolve(jsonResponse({ data: { id: 'ver-1' } }, true, 201));
        await gate.promise;
      });
    });

    it('surfaces the created package (0 versions) when cancelled during the catalog create', async () => {
      // The cancel affordance opens with `saving`, i.e. BEFORE the transfer it
      // cancels — so a cancel can land while step 1 (catalog create) is still
      // in flight, when handleClose has no id to report yet. The catalog row
      // must still reach the user, or they re-create the same package by name.
      const onCreated = vi.fn();
      const catalogGate = deferred<Response>();
      fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
        if (url.startsWith('/custom-fields')) return Promise.resolve(jsonResponse({ data: [] }));
        if (url === '/software/catalog' && opts?.method === 'POST') return catalogGate.promise;
        return Promise.resolve(jsonResponse({}, false, 404));
      });

      render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);
      fillFileForm();
      await submitCreate();
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(
            ([u, o]) => u === '/software/catalog' && (o as RequestInit)?.method === 'POST',
          ),
        ).toBe(true),
      );

      // Cancel while the catalog item is still being created.
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await act(async () => {
        catalogGate.resolve(jsonResponse({ data: { id: 'cat-1' } }));
        await catalogGate.promise;
      });

      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cat-1', name: 'Big App', versionCount: 0 }),
      );
      // …and the upload the user walked away from is never started.
      expect(uploadMock).not.toHaveBeenCalled();
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });

    it('leaves Cancel and Esc disabled while the download-URL (metadata-only) save runs', async () => {
      // Nothing to abort on this path, so it must keep its previous
      // blocked-while-saving behaviour exactly.
      const onClose = vi.fn();
      const versionGate = deferred<Response>();
      fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
        if (url.startsWith('/custom-fields')) return Promise.resolve(jsonResponse({ data: [] }));
        if (url === '/software/catalog' && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse({ data: { id: 'cat-1' } }));
        }
        if (/\/versions$/.test(url) && opts?.method === 'POST') return versionGate.promise;
        return Promise.resolve(jsonResponse({}, false, 404));
      });

      render(<AddPackageModal open onClose={onClose} onCreated={() => {}} />);
      fillMinimum();
      await submitCreate();

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled(),
      );
      expect(screen.queryByTestId('package-upload-progress')).not.toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => {
        versionGate.resolve(jsonResponse({ data: { id: 'ver-1' } }));
        await versionGate.promise;
      });
      // Once the save finishes, closing works again.
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('still reports a genuine failure after an earlier upload was cancelled', async () => {
      const gate = deferred<Response>();
      routeMock({});
      uploadMock.mockImplementation(() => gate.promise);

      render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
      fillFileForm();
      await submitCreate();
      await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await act(async () => {
        gate.resolve(
          Promise.reject(
            new DOMException('The operation was aborted.', 'AbortError'),
          ) as unknown as Response,
        );
        await Promise.resolve();
      });

      // A fresh submit gets a FRESH controller — the stale aborted one must not
      // swallow the next real failure.
      uploadMock.mockReset();
      uploadMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Object storage rejected the upload' }, false, 502),
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Retry adding version' }));

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'error',
            message: 'Object storage rejected the upload',
          }),
        ),
      );
    });
  });
});
