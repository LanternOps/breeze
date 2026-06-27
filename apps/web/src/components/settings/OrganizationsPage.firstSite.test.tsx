import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrganizationsPage from './OrganizationsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

// useOrgStore.getState().fetchOrganizations() is called during refreshOrgs.
const storeFetchOrganizations = vi.fn().mockResolvedValue(undefined);
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: { getState: () => ({ fetchOrganizations: storeFetchOrganizations }) }
}));

const fetchMock = vi.mocked(fetchWithAuth);

const NEW_ORG_ID = '11111111-2222-4333-8444-555566667777';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

/**
 * Drive the create-organization flow. `sitesForNewOrg` is what the sites
 * endpoint returns for the freshly created org, letting each test simulate an
 * org with or without a pre-existing (default) site.
 */
function mockApi(sitesForNewOrg: unknown[]) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method;

    if (url === '/orgs/organizations' && method === 'POST') {
      return makeJsonResponse({ id: NEW_ORG_ID });
    }
    if (url === '/orgs/organizations' && !method) {
      return makeJsonResponse({ data: [] });
    }
    if (url === '/orgs/partners/me') {
      return makeJsonResponse({ settings: {} });
    }
    if (url.startsWith('/orgs/sites?organizationId=')) {
      return makeJsonResponse({ data: sitesForNewOrg });
    }
    return makeJsonResponse({ data: [] });
  });
}

async function submitNewOrg() {
  fireEvent.click(await screen.findByRole('button', { name: /add organization/i }));
  const nameInput = await screen.findByLabelText(/organization name/i);
  fireEvent.change(nameInput, { target: { value: 'Acme Corp' } });
  fireEvent.click(screen.getByRole('button', { name: /create organization/i }));
}

describe('OrganizationsPage — first-site guidance', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    navigateTo.mockReset();
    storeFetchOrganizations.mockClear();
    window.location.hash = '';
  });

  it('shows the "Add the first site" nag when the new org has no sites', async () => {
    mockApi([]);
    render(<OrganizationsPage />);

    await submitNewOrg();

    expect(
      await screen.findByText(`Add the first site for Acme Corp`)
    ).toBeInTheDocument();
  });

  it('does NOT show the first-site nag when the new org already has a default site', async () => {
    mockApi([{ id: 'site-1', name: 'Main Office', orgId: NEW_ORG_ID }]);
    render(<OrganizationsPage />);

    await submitNewOrg();

    // The org-create POST resolved and sites were fetched; give the guidance
    // branch a chance to (not) fire.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).startsWith(`/orgs/sites?organizationId=${NEW_ORG_ID}`)
        )
      ).toBe(true);
    });

    expect(screen.queryByText(/Add the first site for/i)).not.toBeInTheDocument();
  });
});
