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
function mockApi(sitesForNewOrg: unknown[] | 'fail' | 'malformed') {
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
      if (sitesForNewOrg === 'fail') return makeJsonResponse({ error: 'boom' }, false, 500);
      // 200 OK but the body is not a parseable array of sites.
      if (sitesForNewOrg === 'malformed') return makeJsonResponse({ data: null });
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

    // Wait for a post-decision signal: the fetched site rendering in the detail
    // panel proves fetchSites resolved AND its setState flushed, so the gating
    // branch has already run. Asserting on the bare fetch call would race the
    // (broken) nag's setState and could pass even with the regression present.
    // (SiteList renders the name in both desktop and mobile layouts.)
    expect((await screen.findAllByText('Main Office')).length).toBeGreaterThan(0);

    expect(screen.queryByText(/Add the first site for/i)).not.toBeInTheDocument();
  });

  it('does NOT show the first-site nag when the sites fetch fails (fail closed)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockApi('fail');
    render(<OrganizationsPage />);

    await submitNewOrg();

    // The sites fetch failed → fetchSites returns null and logs a warning. The
    // warn firing is the post-decision signal: it happens inside the catch,
    // immediately before fetchSites resolves null and the synchronous gating
    // branch runs. A guess-and-nag failure mode would re-introduce #1978.
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[OrganizationsPage] failed to fetch sites for org',
        NEW_ORG_ID,
        expect.anything()
      );
    });

    expect(screen.queryByText(/Add the first site for/i)).not.toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it('does NOT show the first-site nag on a malformed 200 sites body (fail closed)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 200 OK whose body is { data: null } — not a parseable array. This used to
    // fall through to [] and wrongly fire the nag (#1978); it must now fail closed.
    mockApi('malformed');
    render(<OrganizationsPage />);

    await submitNewOrg();

    // The malformed-body warning is the post-decision signal: it fires inside
    // fetchSites immediately before it resolves null and the synchronous gating
    // branch runs, so once we see it the nag decision has been made.
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[OrganizationsPage] sites response was ok but not a parseable array for org',
        NEW_ORG_ID,
        expect.anything()
      );
    });

    expect(screen.queryByText(/Add the first site for/i)).not.toBeInTheDocument();
    warnSpy.mockRestore();
  });
});
