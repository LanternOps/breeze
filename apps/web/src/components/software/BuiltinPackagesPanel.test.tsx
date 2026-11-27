import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import BuiltinPackagesPanel, { type BuiltinPackageRow } from './BuiltinPackagesPanel';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const res = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ 'content-type': 'application/json' }),
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    clone() { return this; },
  }) as unknown as Response;

const CONTROLD: BuiltinPackageRow = {
  key: 'controld_windows',
  name: 'Control D (Windows)',
  vendor: 'Control D',
  os: 'windows',
  version: '1.5.8',
  fileType: 'zip',
  requiredVars: ['controld_provisioning_code'],
  uninstallCommand: 'C:\\ControlD\\ctrld.exe uninstall',
  catalogId: null,
  archived: false,
};
const NEXTDNS: BuiltinPackageRow = {
  key: 'nextdns_windows',
  name: 'NextDNS CLI (Windows)',
  vendor: 'NextDNS',
  os: 'windows',
  version: '1.47.3',
  fileType: 'zip',
  requiredVars: ['nextdns_profile_id'],
  uninstallCommand: '"C:\\Program Files\\nextdns\\nextdns.exe" uninstall',
  catalogId: 'cat-nextdns',
  archived: false,
};

function serve(list: BuiltinPackageRow[], postStatus = 201) {
  const posts: string[] = [];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(url);
      return Promise.resolve(
        res(postStatus, postStatus === 201 ? { catalogId: 'cat-new', versionId: 'ver-new' } : { error: 'Permission denied' }),
      );
    }
    return Promise.resolve(res(200, { data: list }));
  });
  return posts;
}

describe('BuiltinPackagesPanel (#6958)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists each package not yet in the catalog with what it needs, and leaves out the ones already there', async () => {
    serve([CONTROLD, NEXTDNS]);
    render(<BuiltinPackagesPanel />);
    await waitFor(() => expect(screen.getByTestId('builtin-package-row-controld_windows')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/software/builtin-packages');

    const row = screen.getByTestId('builtin-package-row-controld_windows');
    expect(row.textContent).toContain('Control D (Windows)');
    expect(row.textContent).toContain('1.5.8');
    expect(row.textContent).toContain('controld_provisioning_code');
    const varsLink = screen.getByTestId('builtin-package-vars-link-controld_windows') as HTMLAnchorElement;
    expect(varsLink.getAttribute('href')).toBe('/settings/variables');
    expect(screen.getByTestId('builtin-package-add-controld_windows')).toBeInTheDocument();

    // Already in the catalog: its card in the library is its home, not a second row here.
    expect(screen.queryByTestId('builtin-package-row-nextdns_windows')).not.toBeInTheDocument();
    // One list for every built-in; the uninstall command lives on the package's detail.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(row.textContent).not.toContain('uninstall');
  });

  it('offers an integration built-in that is not in the catalog yet, with a link to connect it', async () => {
    serve([CONTROLD]);
    render(<BuiltinPackagesPanel providersInCatalog={[]} />);
    const huntress = await screen.findByTestId('builtin-package-row-huntress');
    expect(huntress.textContent).toContain('Huntress');
    expect(screen.getByTestId('builtin-package-connect-huntress').getAttribute('href')).toBe('/integrations#huntress');
    expect(screen.getByTestId('builtin-package-connect-sentinelone').getAttribute('href')).toBe('/integrations#sentinelone');
  });

  it('leaves out an integration built-in whose package is already in the catalog', async () => {
    serve([CONTROLD]);
    render(<BuiltinPackagesPanel providersInCatalog={['huntress']} />);
    expect(await screen.findByTestId('builtin-package-row-sentinelone')).toBeInTheDocument();
    expect(screen.queryByTestId('builtin-package-row-huntress')).not.toBeInTheDocument();
  });

  it('does not offer integration built-ins before the catalog has loaded', async () => {
    serve([CONTROLD]);
    render(<BuiltinPackagesPanel />);
    await screen.findByTestId('builtin-package-row-controld_windows');
    expect(screen.queryByTestId('builtin-package-row-huntress')).not.toBeInTheDocument();
    expect(screen.queryByTestId('builtin-package-row-sentinelone')).not.toBeInTheDocument();
  });

  it('renders nothing once every built-in is in the catalog', async () => {
    serve([NEXTDNS]);
    const onPackagesLoaded = vi.fn();
    render(<BuiltinPackagesPanel providersInCatalog={['huntress', 'sentinelone']} onPackagesLoaded={onPackagesLoaded} />);
    await waitFor(() => expect(onPackagesLoaded).toHaveBeenCalled());
    expect(screen.queryByTestId('builtin-packages-panel')).not.toBeInTheDocument();
  });

  it('Add to catalog POSTs through runAction, toasts success, refreshes the list and the parent', async () => {
    const posts = serve([CONTROLD]);
    const onProvisioned = vi.fn();
    render(<BuiltinPackagesPanel onProvisioned={onProvisioned} />);
    fireEvent.click(await screen.findByTestId('builtin-package-add-controld_windows'));

    await waitFor(() => expect(onProvisioned).toHaveBeenCalledWith('cat-new'));
    expect(posts).toEqual(['/software/builtin-packages/controld_windows']);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    // initial GET + POST + re-fetch GET
    expect(fetchMock.mock.calls.filter(([, init]) => !init || (init as RequestInit).method !== 'POST')).toHaveLength(2);
  });

  it('an archived row offers Restore, which re-provisions', async () => {
    const posts = serve([{ ...CONTROLD, catalogId: 'cat-old', archived: true }]);
    render(<BuiltinPackagesPanel />);
    expect((await screen.findByTestId('builtin-package-row-controld_windows')).textContent).toContain('Archived');
    fireEvent.click(screen.getByTestId('builtin-package-restore-controld_windows'));
    await waitFor(() => expect(posts).toEqual(['/software/builtin-packages/controld_windows']));
  });

  it('a 403 (e.g. missing devices.execute) is toasted by runAction and nothing refreshes', async () => {
    serve([CONTROLD], 403);
    const onProvisioned = vi.fn();
    render(<BuiltinPackagesPanel onProvisioned={onProvisioned} />);
    fireEvent.click(await screen.findByTestId('builtin-package-add-controld_windows'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(onProvisioned).not.toHaveBeenCalled();
  });

  it('a 401 is silent (the auth redirect handles it)', async () => {
    serve([CONTROLD], 401);
    const onProvisioned = vi.fn();
    render(<BuiltinPackagesPanel onProvisioned={onProvisioned} />);
    fireEvent.click(await screen.findByTestId('builtin-package-add-controld_windows'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(toastMock).not.toHaveBeenCalled();
    expect(onProvisioned).not.toHaveBeenCalled();
  });

  it('reports the loaded packages to the parent', async () => {
    serve([CONTROLD, NEXTDNS]);
    const onPackagesLoaded = vi.fn();
    render(<BuiltinPackagesPanel onPackagesLoaded={onPackagesLoaded} />);
    await waitFor(() => expect(onPackagesLoaded).toHaveBeenCalledWith([CONTROLD, NEXTDNS]));
  });

  it('treats a payload whose rows all fail the shape check as a load failure (never silently hides)', async () => {
    fetchMock.mockResolvedValue(res(200, { data: [{ unexpected: true }] }));
    render(<BuiltinPackagesPanel />);
    expect(await screen.findByTestId('builtin-packages-error')).toBeInTheDocument();
  });

  it('disables the button while the POST is in flight (no double submit)', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>((r) => { release = r; })
        : Promise.resolve(res(200, { data: [CONTROLD] })),
    );
    render(<BuiltinPackagesPanel />);
    const button = await screen.findByTestId('builtin-package-add-controld_windows');
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);
    release(res(201, { catalogId: 'cat-new', versionId: 'ver-new' }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('shows an inline error when the list cannot load', async () => {
    fetchMock.mockResolvedValue(res(500, { error: 'boom' }));
    render(<BuiltinPackagesPanel />);
    expect(await screen.findByTestId('builtin-packages-error')).toBeInTheDocument();
  });
});
