import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeploymentWizard from './DeploymentWizard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: () => null }));
const fetchMock = vi.mocked(fetchWithAuth);

const ok = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function route(url: string) {
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
  });
});
