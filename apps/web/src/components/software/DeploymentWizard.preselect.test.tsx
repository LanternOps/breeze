import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeploymentWizard from './DeploymentWizard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn(), useAuthStore: { getState: () => ({ tokens: null }) } }));
vi.mock('../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: () => null }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const ok = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function route(url: string) {
  if (url.startsWith('/devices/options?')) {
    const includeIds = new URL(`https://example.test${url}`).searchParams.get('includeIds')?.split(',').filter(Boolean) ?? [];
    return ok({
      data: includeIds.map((id, index) => ({ id, hostname: `seeded-${index + 1}`, displayName: null, osType: 'windows', status: 'online', siteId: null, siteName: null })),
      page: { nextCursor: null, returned: includeIds.length, total: includeIds.length, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
    });
  }
  if (url === '/software/catalog')
    return ok({ data: [{ id: 'cat-9', name: 'Huntress EDR Agent', vendor: 'Huntress', category: 'security' }] });
  if (url === '/software/catalog/cat-9/versions')
    return ok({ data: [{ id: 'ver-1', version: 'latest', isLatest: true }] });
  return ok({ data: [] }); // /devices, /orgs/sites, /device-groups
}

describe('DeploymentWizard preselect (initialCatalogId)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => Promise.resolve(route(url)));
  });

  it('starts with the preselected package selected', async () => {
    render(<DeploymentWizard initialCatalogId="cat-9" />);
    // Once the catalog loads, the preselected package's name appears in the
    // step-1 selection UI (invariant: preselect → non-empty selectedSoftwareId).
    await waitFor(() =>
      expect(screen.getAllByText('Huntress EDR Agent').length).toBeGreaterThan(0),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/devices/options?'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
  });

  it('preselects a package-manager item that has no uploaded versions', async () => {
    // cat-m has zero versions but one enabled winget method — deployable via the
    // manager path, so preselect must not fall through to "no deployable item".
    fetchMock.mockImplementation((url: string) => {
      if (url === '/software/catalog')
        return Promise.resolve(
          ok({
            data: [
              { id: 'cat-9', name: 'Huntress EDR Agent', vendor: 'Huntress', category: 'security' },
              { id: 'cat-m', name: 'VLC Media Player', vendor: 'VideoLAN', category: 'media' },
            ],
          }),
        );
      if (url === '/software/catalog/cat-m/versions') return Promise.resolve(ok({ data: [] }));
      if (url === '/software/catalog/cat-m/install-methods')
        return Promise.resolve(
          ok({
            data: [
              {
                id: 'm-win',
                catalogId: 'cat-m',
                platform: 'windows',
                kind: 'winget',
                packageId: 'VideoLAN.VLC',
                enabled: true,
              },
            ],
          }),
        );
      return Promise.resolve(route(url));
    });

    render(<DeploymentWizard initialCatalogId="cat-m" />);
    await waitFor(() =>
      // Both the list row and the "Selected software" panel show the name.
      expect(screen.getAllByText('VLC Media Player').length).toBeGreaterThan(1),
    );
  });
});

/** Walk the wizard: software → targets → configure → review. */
async function advanceToReview() {
  for (let i = 0; i < 3; i++) {
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
  }
}

describe('DeploymentWizard preselect (initialDeviceIds, #2866)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => Promise.resolve(route(url)));
  });

  it('carries the seeded devices through to the created deployment payload', async () => {
    render(
      <DeploymentWizard
        initialCatalogId="cat-9"
        initialDeviceIds={['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByText('Huntress EDR Agent').length).toBeGreaterThan(0),
    );

    // The seeded selection satisfies the targets-step gate (selectedDevices
    // non-empty in tree mode), so Next is never disabled on the walk to review.
    await advanceToReview();
    fireEvent.click(screen.getByRole('button', { name: 'Create Deployment' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u === '/software/deployments');
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string) as {
        targetType: string;
        targetIds: string[];
      };
      expect(body.targetType).toBe('devices');
      expect(body.targetIds).toEqual(
        expect.arrayContaining([
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ]),
      );
    });
  });

  it('without seeded devices the targets step still gates on an empty selection', async () => {
    render(<DeploymentWizard initialCatalogId="cat-9" />);
    await waitFor(() =>
      expect(screen.getAllByText('Huntress EDR Agent').length).toBeGreaterThan(0),
    );

    // software → targets works (package preselected)…
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // …but with no devices selected, targets → configure must be blocked.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('offers "View deployment" on success and routes through onViewDeployment', async () => {
    const onViewDeployment = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/software/deployments' && init?.method === 'POST') {
        return Promise.resolve(ok({ data: { id: 'dep-42' } }));
      }
      return Promise.resolve(route(url));
    });

    render(
      <DeploymentWizard
        initialCatalogId="cat-9"
        initialDeviceIds={['11111111-1111-4111-8111-111111111111']}
        onViewDeployment={onViewDeployment}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByText('Huntress EDR Agent').length).toBeGreaterThan(0),
    );

    await advanceToReview();
    fireEvent.click(screen.getByRole('button', { name: 'Create Deployment' }));

    const viewButton = await screen.findByTestId('view-deployment-button');
    fireEvent.click(viewButton);
    expect(onViewDeployment).toHaveBeenCalledWith('dep-42');
  });
});
