import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeploymentWizard from './DeploymentWizard';
import { fetchWithAuth } from '../../stores/auth';

// orgStore calls registerOrgIdProvider at module scope, and useOrgScope pulls
// orgStore in, so the mock has to expose it or the whole suite fails to import.
// Same shape as the sibling DeploymentWizard.preselect.test.tsx.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
vi.mock('../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: () => null }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const ok = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const WIN_DEVICE = '11111111-1111-4111-8111-111111111111';
const LINUX_DEVICE_A = '22222222-2222-4222-8222-222222222222';
const LINUX_DEVICE_B = '33333333-3333-4333-8333-333333333333';

const WINGET_METHOD = {
  id: 'm-win',
  catalogId: 'cat-m',
  platform: 'windows',
  kind: 'winget',
  packageId: 'VideoLAN.VLC',
  enabled: true,
  createdAt: '2026-08-15T00:00:00.000Z',
};
const BREW_METHOD = {
  id: 'm-mac',
  catalogId: 'cat-m',
  platform: 'macos',
  kind: 'homebrew_cask',
  packageId: 'vlc',
  enabled: true,
  createdAt: '2026-08-15T00:00:00.000Z',
};

/**
 * Catalog with a single package-manager-only item: zero uploaded versions,
 * install methods supplied by `methods`.
 */
function makeRoute(methods: unknown[]) {
  return (url: string): Response => {
    if (url === '/software/catalog')
      return ok({
        data: [{ id: 'cat-m', name: 'VLC Media Player', vendor: 'VideoLAN', category: 'media' }],
      });
    if (url === '/software/catalog/cat-m/versions') return ok({ data: [] });
    if (url === '/software/catalog/cat-m/install-methods') return ok({ data: methods });
    if (url.startsWith('/devices/options?'))
      return ok({
        data: [
          { id: WIN_DEVICE, hostname: 'win-1', displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null },
          { id: LINUX_DEVICE_A, hostname: 'lin-1', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null },
          { id: LINUX_DEVICE_B, hostname: 'lin-2', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null },
        ],
        page: { nextCursor: null, returned: 3, total: 3, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
      });
    return ok({ data: [] }); // /orgs/sites, /device-groups
  };
}

function mountWizard(methods: unknown[], deviceIds?: string[]) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/software/deployments' && init?.method === 'POST') {
      return Promise.resolve(ok({ data: { id: 'dep-77' } }));
    }
    return Promise.resolve(makeRoute(methods)(url));
  });
  return render(<DeploymentWizard initialCatalogId="cat-m" initialDeviceIds={deviceIds} />);
}

const waitForLoad = () =>
  waitFor(() => expect(screen.getAllByText('VLC Media Player').length).toBeGreaterThan(0));

function deployBody() {
  const call = fetchMock.mock.calls.find(([u]) => u === '/software/deployments');
  expect(call).toBeTruthy();
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
}

describe('DeploymentWizard — package-manager deploys', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('fetches install methods for every catalog item alongside versions', async () => {
    mountWizard([WINGET_METHOD]);
    await waitForLoad();
    expect(fetchMock).toHaveBeenCalledWith('/software/catalog/cat-m/versions');
    expect(fetchMock).toHaveBeenCalledWith('/software/catalog/cat-m/install-methods');
  });

  it('makes a zero-version item with an enabled method selectable', async () => {
    mountWizard([WINGET_METHOD]);
    await waitForLoad();
    // The row is not disabled and step 1 lets the user continue.
    const row = screen.getByRole('button', { name: /VLC Media Player/ });
    expect(row).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();
    // No "cannot be deployed until at least one version" warning.
    expect(
      screen.queryByText(/cannot be deployed until at least one version/i),
    ).not.toBeInTheDocument();
  });

  it('leaves an item with no enabled method undeployable', async () => {
    mountWizard([{ ...WINGET_METHOD, enabled: false }]);
    await waitForLoad();
    expect(screen.getByRole('button', { name: /VLC Media Player/ })).toBeDisabled();
  });

  it('offers Latest/Exact version modes when a winget method exists', async () => {
    mountWizard([WINGET_METHOD]);
    await waitForLoad();
    expect(await screen.findByRole('radio', { name: /Latest \(recommended\)/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Exact version/ })).toBeInTheDocument();
    // The uploaded-version <select> is replaced by the mode radios.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('hides the Exact option for a Homebrew-only item', async () => {
    mountWizard([BREW_METHOD]);
    await waitForLoad();
    expect(await screen.findByRole('radio', { name: /Latest \(recommended\)/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Exact version/ })).not.toBeInTheDocument();
  });

  it('posts catalogId + versionMode latest and never softwareVersionId', async () => {
    mountWizard([WINGET_METHOD], [WIN_DEVICE]);
    await waitForLoad();
    // The mode radios only render once the install-methods fetch resolves;
    // waitForLoad covers the catalog fetch alone, so gate on them explicitly.
    await screen.findByRole('radio', { name: /Latest \(recommended\)/ });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Deployment' }));

    await waitFor(() => {
      const body = deployBody();
      expect(body.catalogId).toBe('cat-m');
      expect(body.versionMode).toBe('latest');
      expect(body).not.toHaveProperty('softwareVersionId');
      expect(body).not.toHaveProperty('requestedVersion');
      expect(body.deploymentType).toBe('install');
      expect(body.targetIds).toEqual([WIN_DEVICE]);
    });
  });

  it('posts versionMode exact with the typed requestedVersion', async () => {
    mountWizard([WINGET_METHOD], [WIN_DEVICE]);
    await waitForLoad();

    fireEvent.click(await screen.findByRole('radio', { name: /Exact version/ }));
    const input = await screen.findByTestId('manager-exact-version');
    // The step gate blocks an empty exact version.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '3.0.20' } });
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();

    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Deployment' }));

    await waitFor(() => {
      const body = deployBody();
      expect(body.catalogId).toBe('cat-m');
      expect(body.versionMode).toBe('exact');
      expect(body.requestedVersion).toBe('3.0.20');
      expect(body).not.toHaveProperty('softwareVersionId');
    });
  });

  it('reflects a split (Windows+macOS) deployment response in the confirmation summary and toast', async () => {
    const { showToast } = await import('../shared/Toast');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/software/deployments' && init?.method === 'POST') {
        return Promise.resolve(
          ok({
            data: { id: 'dep-win', name: 'VLC Media Player (Windows)' },
            deployments: [
              { id: 'dep-win', name: 'VLC Media Player (Windows)' },
              { id: 'dep-mac', name: 'VLC Media Player (macOS)' },
            ],
          }),
        );
      }
      return Promise.resolve(makeRoute([WINGET_METHOD, BREW_METHOD])(url));
    });

    render(
      <DeploymentWizard initialCatalogId="cat-m" initialDeviceIds={[WIN_DEVICE]} />,
    );
    await waitForLoad();
    await screen.findByRole('radio', { name: /Latest \(recommended\)/ });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Deployment' }));

    const summary = await screen.findByTestId('deployment-summary');
    expect(summary.textContent).toMatch(/2/);
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/2/), type: 'success' }),
      );
    });
  });

  it('warns on the targets step about selected devices with no install method', async () => {
    mountWizard([WINGET_METHOD], [WIN_DEVICE, LINUX_DEVICE_A, LINUX_DEVICE_B]);
    await waitForLoad();
    await screen.findByRole('radio', { name: /Latest \(recommended\)/ });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    const callout = await screen.findByTestId('manager-os-coverage');
    expect(callout.textContent).toMatch(/2 selected Linux devices/);
    expect(callout.textContent).toMatch(/no install method/i);
    // Windows is covered by the winget method, so it must not be listed.
    expect(callout.textContent).not.toMatch(/Windows/);
  });

  it('shows no coverage callout when every selected device is covered', async () => {
    mountWizard([WINGET_METHOD], [WIN_DEVICE]);
    await waitForLoad();
    await screen.findByRole('radio', { name: /Latest \(recommended\)/ });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // Assert we actually reached the targets step — otherwise the negative
    // assertion below would pass vacuously on a wizard still stuck on step 1.
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.queryByTestId('manager-os-coverage')).not.toBeInTheDocument();
  });
});
