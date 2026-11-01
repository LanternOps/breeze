/**
 * #10037: the version manager's own form reaches parity with AddPackageModal —
 * pre/post-install script fields on add (validated client-side with the shared
 * install-spec rules), zip offered, no silent-install args for pkg/dmg/deb/zip
 * (the API rejects new ones), and an existing version's scripts visible when
 * editing it (read-only: the PATCH route keeps scripts immutable).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SoftwareVersionManager from './SoftwareVersionManager';
import { fetchWithAuth } from '../../stores/auth';
import { uploadPackageVersion } from '../../lib/softwarePackageUpload';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('../../stores/featuresStore', () => ({
  usePackageUploadsGate: () => ({ enabled: true }),
}));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const uploadMock = vi.mocked(uploadPackageVersion);
const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const base = { releaseDate: '2026-01-01T00:00:00Z', architecture: 'x64', isLatest: false };
const ZIP_VERSION = {
  ...base,
  id: 'v-zip',
  version: '1.1.0',
  fileType: 'zip',
  downloadUrl: 'https://cdn.example/tool-1.1.0.zip',
  supportedOs: ['windows'],
  silentInstallArgs: null,
  preInstallScript: 'Stop-Service tool',
  postInstallScript: 'Copy-Item "{{install.dir}}\\tool.exe" C:\\Tools',
  installScriptsEnabled: true,
  isLatest: true,
};
const PKG_LEGACY_ARGS = {
  ...base,
  id: 'v-pkg',
  version: '2.0.0',
  fileType: 'pkg',
  downloadUrl: 'https://cdn.example/app.pkg',
  supportedOs: ['macos'],
  silentInstallArgs: '-legacy',
  preInstallScript: null,
  postInstallScript: null,
  installScriptsEnabled: false,
};

function serve(versions: unknown[]) {
  fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
    if (String(url).startsWith('/custom-fields')) return Promise.resolve(jsonResponse({ data: [] }));
    if (opts?.method === 'POST' || opts?.method === 'PATCH') {
      return Promise.resolve(jsonResponse({ data: { ...base, id: 'v-new', version: '9.9.9', fileType: 'zip' } }));
    }
    return Promise.resolve(jsonResponse({ data: versions }));
  });
}

async function renderLoaded() {
  render(<SoftwareVersionManager catalogId="cat-1" embedded />);
  await waitFor(() => expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument());
}

const openAdd = () => fireEvent.click(screen.getByRole('button', { name: /add version/i }));
const urlInput = () => screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi');
const versionInput = () => screen.getByPlaceholderText('e.g. 1.0.0');
const argsInput = () => screen.queryByPlaceholderText(/msiexec \/i/i);
const submitButton = () => screen.getByRole('button', { name: /save version|upload & save/i });
// Sets the OS checkboxes outright: a URL or filename may already have
// pre-checked one (applyOsHint).
const onlyOs = (target: RegExp) => {
  for (const name of [/windows/i, /macos/i, /linux/i]) {
    const box = screen.getByRole('checkbox', { name }) as HTMLInputElement;
    if (box.checked !== (name.source === target.source)) fireEvent.click(box);
  }
};
const checkOs = (name: RegExp) => fireEvent.click(screen.getByRole('checkbox', { name }));

const requestBody = (method: string) => {
  const call = fetchMock.mock.calls.find(([, o]) => (o as RequestInit)?.method === method);
  return JSON.parse((call?.[1] as RequestInit).body as string);
};

describe('SoftwareVersionManager script fields and args (#10037)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    serve([]);
  });

  it('offers zip on the add form with no "use Add Package" detour', async () => {
    await renderLoaded();
    openAdd();
    const select = (await screen.findByTestId('version-file-type')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('zip');
    expect(screen.queryByText('Add zip packages from Add Package.')).toBeNull();
  });

  it('sends typed pre/post-install scripts on add', async () => {
    await renderLoaded();
    openAdd();
    fireEvent.change(versionInput(), { target: { value: '3.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/setup.exe' } });
    onlyOs(/windows/i);
    fireEvent.change(screen.getByTestId('pre-install-script'), { target: { value: 'echo pre' } });
    fireEvent.change(screen.getByTestId('post-install-script'), { target: { value: 'echo post' } });

    fireEvent.click(submitButton());

    await waitFor(() => expect(requestBody('POST').preInstallScript).toBe('echo pre'));
    expect(requestBody('POST').postInstallScript).toBe('echo post');
  });

  it('blocks a zip without a post-install script, client-side', async () => {
    await renderLoaded();
    openAdd();
    fireEvent.change(versionInput(), { target: { value: '3.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/tool.zip' } });
    onlyOs(/windows/i);

    expect(await screen.findByTestId('install-spec-issue-zip_requires_post_install_script')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();

    fireEvent.change(screen.getByTestId('post-install-script'), { target: { value: 'echo post' } });
    await waitFor(() => expect(submitButton()).not.toBeDisabled());
  });

  it('flags scripts that do not target exactly one OS', async () => {
    await renderLoaded();
    openAdd();
    fireEvent.change(versionInput(), { target: { value: '3.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/setup.exe' } });
    onlyOs(/windows/i);
    checkOs(/linux/i);
    fireEvent.change(screen.getByTestId('post-install-script'), { target: { value: 'echo post' } });

    expect(await screen.findByTestId('install-spec-issue-scripts_require_single_os')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();

    checkOs(/linux/i);
    await waitFor(() =>
      expect(screen.queryByTestId('install-spec-issue-scripts_require_single_os')).toBeNull(),
    );
    expect(submitButton()).not.toBeDisabled();
  });

  it.each(['pkg', 'dmg', 'deb', 'zip'])('hides silent-install args for %s and never sends them', async (type) => {
    await renderLoaded();
    openAdd();
    fireEvent.change(versionInput(), { target: { value: '3.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/setup.exe' } });
    expect(argsInput()).not.toBeNull();
    fireEvent.change(argsInput()!, { target: { value: '/S' } });

    fireEvent.change(screen.getByTestId('version-file-type'), { target: { value: type } });
    await waitFor(() => expect(argsInput()).toBeNull());
    expect(screen.getByText(/not used for pkg, dmg, deb or zip installers/i)).toBeInTheDocument();
    onlyOs(/linux/i);
    if (type === 'zip') {
      fireEvent.change(screen.getByTestId('post-install-script'), { target: { value: 'echo post' } });
    }

    fireEvent.click(submitButton());
    await waitFor(() => expect(requestBody('POST').fileType).toBe(type));
    expect(requestBody('POST')).not.toHaveProperty('silentInstallArgs');
  });

  it('passes scripts through the upload path', async () => {
    uploadMock.mockResolvedValue(jsonResponse({ data: { ...base, id: 'v-up', version: '3.0.0', fileType: 'zip' } }));
    await renderLoaded();
    openAdd();
    fireEvent.change(versionInput(), { target: { value: '3.0.0' } });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.accept).toContain('.zip');
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'tool.zip')] } });
    onlyOs(/windows/i);
    fireEvent.change(screen.getByTestId('post-install-script'), { target: { value: 'echo post' } });
    // Whitespace-only counts as absent: not sent.
    fireEvent.change(screen.getByTestId('pre-install-script'), { target: { value: '   ' } });

    fireEvent.click(submitButton());

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    const metadata = uploadMock.mock.calls[0]![0].metadata;
    expect(metadata.postInstallScript).toBe('echo post');
    expect(metadata.preInstallScript).toBeUndefined();
  });

  it.each([
    ['tool.zip', /windows/i],
    ['app.pkg', /macos/i],
  ])('an upload of %s drops args typed earlier (type from the filename)', async (fileName, os) => {
    uploadMock.mockResolvedValue(jsonResponse({ data: { ...base, id: 'v-up', version: '3.0.0', fileType: 'zip' } }));
    await renderLoaded();
    openAdd();
    fireEvent.change(versionInput(), { target: { value: '3.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/setup.exe' } });
    fireEvent.change(argsInput()!, { target: { value: '/S' } });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File(['x'], fileName)] },
    });
    await waitFor(() => expect(argsInput()).toBeNull());
    onlyOs(os);
    if (fileName.endsWith('.zip')) {
      fireEvent.change(screen.getByTestId('post-install-script'), { target: { value: 'echo post' } });
    }

    fireEvent.click(submitButton());

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(uploadMock.mock.calls[0]![0].metadata.silentInstallArgs).toBeUndefined();
  });

  it('a whitespace-only post-install script does not satisfy the zip rule', async () => {
    await renderLoaded();
    openAdd();
    fireEvent.change(versionInput(), { target: { value: '3.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/tool.zip' } });
    onlyOs(/windows/i);
    fireEvent.change(screen.getByTestId('post-install-script'), { target: { value: '  \n ' } });
    expect(await screen.findByTestId('install-spec-issue-zip_requires_post_install_script')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('editing a version with inactive scripts shows them but leaves the OS editable', async () => {
    serve([{ ...ZIP_VERSION, id: 'v-dormant', fileType: 'exe', installScriptsEnabled: false }]);
    await renderLoaded();
    fireEvent.click(await screen.findByTestId('version-edit-v-dormant'));
    expect((screen.getByTestId('post-install-script') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByRole('checkbox', { name: /windows/i })).not.toBeDisabled();
  });

  it('does not seed a new version with dormant (inactive) scripts', async () => {
    serve([{ ...ZIP_VERSION, id: 'v-dormant', fileType: 'exe', installScriptsEnabled: false }]);
    await renderLoaded();
    openAdd();
    expect(await screen.findByTestId('pre-install-script')).toHaveValue('');
    expect(screen.getByTestId('post-install-script')).toHaveValue('');
  });

  it('in edit mode, args follow the stored type and the type cannot be changed', async () => {
    serve([{ ...PKG_LEGACY_ARGS, id: 'v-exe', fileType: 'exe', silentInstallArgs: '/S', supportedOs: ['windows'] }]);
    await renderLoaded();
    fireEvent.click(await screen.findByTestId('version-edit-v-exe'));
    const select = screen.getByTestId('version-file-type') as HTMLSelectElement;
    expect(select).toBeDisabled();
    fireEvent.change(select, { target: { value: 'pkg' } });
    expect(screen.getByDisplayValue('/S')).toBeInTheDocument();
  });

  it('shows the server\'s refusal when a metadata-only create fails', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (String(url).startsWith('/custom-fields')) return Promise.resolve(jsonResponse({ data: [] }));
      if (opts?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: vi.fn().mockResolvedValue({ error: 'Install scripts require devices.execute' }),
        } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    await renderLoaded();
    openAdd();
    fireEvent.change(versionInput(), { target: { value: '3.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/setup.exe' } });
    onlyOs(/windows/i);
    fireEvent.change(screen.getByTestId('post-install-script'), { target: { value: 'echo post' } });
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Install scripts require devices\.execute/)).toBeInTheDocument();
  });

  it('editing a legacy zip version with no scripts is not blocked by the zip rule', async () => {
    serve([{ ...ZIP_VERSION, id: 'v-old-zip', preInstallScript: null, postInstallScript: null, installScriptsEnabled: false }]);
    await renderLoaded();
    fireEvent.click(await screen.findByTestId('version-edit-v-old-zip'));
    expect(screen.queryByTestId('install-spec-issue-zip_requires_post_install_script')).toBeNull();
    expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled();
  });

  it('opening Add after an edit starts from the latest version, not the edited one', async () => {
    serve([ZIP_VERSION, { ...PKG_LEGACY_ARGS, isLatest: false }]);
    await renderLoaded();
    fireEvent.click(await screen.findByTestId('version-edit-v-pkg'));
    fireEvent.click(screen.getByTestId('version-form-cancel'));
    openAdd();
    const pre = (await screen.findByTestId('pre-install-script')) as HTMLTextAreaElement;
    expect(pre.readOnly).toBe(false);
    expect(pre).toHaveValue('Stop-Service tool');
  });

  it('seeds a new version with the latest version\'s scripts', async () => {
    serve([ZIP_VERSION]);
    await renderLoaded();
    openAdd();
    expect(await screen.findByTestId('pre-install-script')).toHaveValue('Stop-Service tool');
    expect(screen.getByTestId('post-install-script')).toHaveValue(ZIP_VERSION.postInstallScript);
    expect(screen.getByTestId('version-file-type')).toHaveValue('zip');
  });

  it('editing a zip version shows its scripts read-only, hides args and the zip hint', async () => {
    serve([ZIP_VERSION]);
    await renderLoaded();
    fireEvent.click(await screen.findByTestId('version-edit-v-zip'));

    expect(screen.queryByText('Add zip packages from Add Package.')).toBeNull();
    const post = screen.getByTestId('post-install-script') as HTMLTextAreaElement;
    expect(post).toHaveValue(ZIP_VERSION.postInstallScript);
    expect(post.readOnly).toBe(true);
    expect((screen.getByTestId('pre-install-script') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByTestId('install-scripts-readonly')).toBeInTheDocument();
    expect(argsInput()).toBeNull();
    // Active scripts bind the version to its OS; the API rejects a change.
    expect(screen.getByRole('checkbox', { name: /windows/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => (o as RequestInit)?.method === 'PATCH')).toBe(true));
    const body = requestBody('PATCH');
    expect(body).not.toHaveProperty('silentInstallArgs');
    expect(body).not.toHaveProperty('preInstallScript');
    expect(body).not.toHaveProperty('postInstallScript');
    expect(body.supportedOs).toEqual(['windows']);
  });

  it('editing a pkg version with legacy args leaves them untouched', async () => {
    serve([PKG_LEGACY_ARGS]);
    await renderLoaded();
    fireEvent.click(await screen.findByTestId('version-edit-v-pkg'));
    expect(argsInput()).toBeNull();
    // No stored scripts: the read-only scripts block stays out of the way.
    expect(screen.queryByTestId('install-scripts')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /macos/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => (o as RequestInit)?.method === 'PATCH')).toBe(true));
    expect(requestBody('PATCH')).not.toHaveProperty('silentInstallArgs');
  });

  it('an msi version keeps its silent-install args editable', async () => {
    serve([{ ...PKG_LEGACY_ARGS, id: 'v-msi', fileType: 'msi', silentInstallArgs: '/qn', supportedOs: ['windows'] }]);
    await renderLoaded();
    fireEvent.click(await screen.findByTestId('version-edit-v-msi'));
    const form = screen.getByTestId('version-form-editing').closest('form')!;
    expect(within(form).getByDisplayValue('/qn')).toBeInTheDocument();
  });
});
