import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddPackageModal from './AddPackageModal';
import { fetchWithAuth } from '../../stores/auth';
import { uploadPackageVersion } from '../../lib/softwarePackageUpload';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn(), useAuthStore: { getState: () => ({ tokens: null }) } }));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const uploadMock = vi.mocked(uploadPackageVersion);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function routeMock() {
  fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
    if (url.startsWith('/custom-fields')) return Promise.resolve(jsonResponse({ data: [] }));
    if (url === '/software/catalog' && opts?.method === 'POST') return Promise.resolve(jsonResponse({ data: { id: 'cat-1' } }));
    if (/\/software\/catalog\/.+\/versions$/.test(url) && opts?.method === 'POST') return Promise.resolve(jsonResponse({ data: { id: 'ver-1' } }));
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

const fillUrl = (url: string) => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tool' } });
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } });
  fireEvent.change(screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'), { target: { value: url } });
};

const selectFile = (name: string) => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tool' } });
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } });
  fireEvent.click(screen.getByRole('tab', { name: /upload file/i }));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([new Uint8Array(8)], name)] } });
};

const submit = () => screen.getByRole('button', { name: 'Create package' });
const setScript = (id: 'pre-install-script' | 'post-install-script', value: string) =>
  fireEvent.change(screen.getByTestId(id), { target: { value } });
// applyOsHint may pre-check an OS from the file name, so set state explicitly.
const toggleOs = (name: string) => {
  const box = screen.getByLabelText(name) as HTMLInputElement;
  if (!box.checked) fireEvent.click(box);
};

const renderModal = () => render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

const versionBody = () => {
  const call = fetchMock.mock.calls.find(([u, o]) => /\/versions$/.test(u as string) && o?.method === 'POST')!;
  return JSON.parse((call[1] as RequestInit).body as string);
};
const versionPosted = () =>
  fetchMock.mock.calls.some(([u, o]) => /\/versions$/.test(u as string) && o?.method === 'POST');

describe('AddPackageModal install scripts (#6958 PR D)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    uploadMock.mockReset();
    routeMock();
  });

  it('accepts .zip in the file input and infers zip from the file name', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('tab', { name: /upload file/i }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.getAttribute('accept')).toContain('.zip');
    selectFile('tool.zip');
    expect(await screen.findByTestId('install-spec-issue-zip_requires_post_install_script')).toBeInTheDocument();
  });

  it('blocks a zip without a post-install script and unblocks once one script and one OS are set', async () => {
    renderModal();
    fillUrl('https://dl.example.com/tool.zip');
    expect(await screen.findByTestId('install-spec-issue-zip_requires_post_install_script')).toBeInTheDocument();
    expect(submit()).toBeDisabled();

    setScript('post-install-script', 'echo done');
    expect(await screen.findByTestId('install-spec-issue-scripts_require_single_os')).toBeInTheDocument();
    expect(submit()).toBeDisabled();

    toggleOs('Windows');
    await waitFor(() => expect(submit()).toBeEnabled());
    expect(screen.queryByTestId('install-spec-issue-zip_requires_post_install_script')).not.toBeInTheDocument();
  });

  it('blocks two OSes with a script and shows the single-OS message', async () => {
    renderModal();
    fillUrl('https://dl.example.com/tool.msi');
    toggleOs('Windows');
    toggleOs('macOS');
    setScript('pre-install-script', 'echo hi');
    expect(await screen.findByTestId('install-spec-issue-scripts_require_single_os')).toHaveTextContent(
      'Install scripts need exactly one target OS.',
    );
    expect(submit()).toBeDisabled();
  });

  it('sends both scripts in the JSON versions body for a URL source', async () => {
    renderModal();
    fillUrl('https://dl.example.com/tool.zip');
    toggleOs('Windows');
    setScript('pre-install-script', 'echo pre');
    setScript('post-install-script', 'echo post');
    await waitFor(() => expect(submit()).toBeEnabled());
    fireEvent.click(submit());
    await waitFor(() => expect(versionPosted()).toBe(true));
    const body = versionBody();
    expect(body.preInstallScript).toBe('echo pre');
    expect(body.postInstallScript).toBe('echo post');
    expect(body.silentInstallArgs).toBeUndefined();
  });

  it('omits blank scripts from the JSON body', async () => {
    renderModal();
    fillUrl('https://dl.example.com/tool.msi');
    setScript('pre-install-script', '   ');
    await waitFor(() => expect(submit()).toBeEnabled());
    fireEvent.click(submit());
    await waitFor(() => expect(versionPosted()).toBe(true));
    const body = versionBody();
    expect(body.preInstallScript).toBeUndefined();
    expect(body.postInstallScript).toBeUndefined();
  });

  it('sends both scripts in the chunked-upload metadata for a file source', async () => {
    uploadMock.mockResolvedValue(jsonResponse({ data: { id: 'ver-1' } }));
    renderModal();
    selectFile('tool.zip');
    toggleOs('Linux');
    setScript('pre-install-script', 'echo pre');
    setScript('post-install-script', 'echo post');
    await waitFor(() => expect(submit()).toBeEnabled());
    fireEvent.click(submit());
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    const { metadata } = uploadMock.mock.calls[0][0];
    expect(metadata.preInstallScript).toBe('echo pre');
    expect(metadata.postInstallScript).toBe('echo post');
    expect(metadata.silentInstallArgs).toBeUndefined();
  });

  it.each(['zip', 'pkg', 'dmg', 'deb'])('hides the silent-args input for %s', async (type) => {
    renderModal();
    fillUrl(`https://dl.example.com/tool.${type}`);
    await waitFor(() => expect(screen.queryByLabelText('Silent install args')).not.toBeInTheDocument());
    expect(
      screen.getByText('Silent install arguments are not used for pkg, dmg, deb or zip installers.'),
    ).toBeInTheDocument();
  });

  it('shows the silent-args input for msi', async () => {
    renderModal();
    fillUrl('https://dl.example.com/tool.msi');
    expect(await screen.findByLabelText('Silent install args')).toBeInTheDocument();
  });

  it('renders the token chips as literal code', () => {
    renderModal();
    fillUrl('https://dl.example.com/tool.msi');
    for (const t of ['{{org.*}}', '{{site.*}}', '{{device.hostname}}', '{{device.customField.<key>}}', '{{var.<key>}}', '{{install.dir}}', '{{install.file}}']) {
      expect(screen.getByText(t, { selector: 'code' })).toBeInTheDocument();
    }
  });
});
