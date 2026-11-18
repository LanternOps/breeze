import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SitesPage from './SitesPage';
import { decodeFilterFromHash } from '../devices/filterUrl';
import { readDeviceClassFromHash } from '../devices/deviceClassFilter';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore, type Organization } from '../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const granted = vi.hoisted(() => new Set<string>());
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => granted.has(`${r}:${a}`) }),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));

// A real zustand store with only the two fields the page reads, so a test can
// switch the org mid-flow and the page re-renders like it does in the app.
vi.mock('../../stores/orgStore', async () => {
  const { create } = await import('zustand');
  const useOrgStore = create<{ currentOrgId: string | null; organizations: Array<{ id: string; name: string }> }>(() => ({
    currentOrgId: null,
    organizations: [],
  }));
  return { useOrgStore };
});

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SITE_A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', orgId: ORG_A, orgName: 'Alpha Co', name: 'Alpha HQ', timezone: 'UTC', deviceCount: 3 };
const SITE_B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', orgId: ORG_B, orgName: 'Bravo Ltd', name: 'Bravo Depot', timezone: 'UTC', deviceCount: 5 };
const org = (id: string, name: string): Organization => ({ id, name, partnerId: 'partner-1', status: 'active', createdAt: '2026-01-01T00:00:00Z' });
const ORGS = [org(ORG_A, 'Alpha Co'), org(ORG_B, 'Bravo Ltd')];

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** Serves the sites list the way the API scopes it: by organizationId when given, else every site. */
function serveSites(all: Array<typeof SITE_A>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if ((init as RequestInit | undefined)?.method === 'POST') return jsonResponse({ id: 'new' }, 201);
    if (url.startsWith('/orgs/sites')) {
      const org = new URLSearchParams(url.split('?')[1] ?? '').get('organizationId');
      return jsonResponse({ data: org ? all.filter((s) => s.orgId === org) : all });
    }
    return jsonResponse({});
  });
}

const listCalls = () => fetchMock.mock.calls.filter(([u, i]) => String(u).startsWith('/orgs/sites') && !(i as RequestInit | undefined)?.method);

describe('SitesPage (#9794)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.mocked(navigateTo).mockClear();
    granted.clear();
    granted.add('sites:read');
    useOrgStore.setState({ currentOrgId: null, organizations: ORGS });
  });

  it('fleet view lists sites across orgs with an Organization column, from a request with no organizationId (RF2)', async () => {
    serveSites([SITE_A, SITE_B]);
    render(<SitesPage />);

    expect(await screen.findByTestId(`sites-row-${SITE_A.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('sites-page')).toBeInTheDocument();
    expect(screen.getByTestId(`sites-row-${SITE_B.id}`)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Organization' })).toBeInTheDocument();
    expect(within(screen.getByTestId(`sites-row-${SITE_B.id}`)).getByText('Bravo Ltd')).toBeInTheDocument();

    // Org-less: no organizationId and no org pinned — the request neither 400s nor blocks.
    const [url, init] = listCalls()[0]!;
    expect(String(url)).not.toContain('organizationId');
    expect((init as { orgIdOverride?: string | null }).orgIdOverride).toBeNull();
  });

  it('with an org selected lists that org only and drops the Organization column', async () => {
    useOrgStore.setState({ currentOrgId: ORG_A });
    serveSites([SITE_A, SITE_B]);
    render(<SitesPage />);

    expect(await screen.findByTestId(`sites-row-${SITE_A.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`sites-row-${SITE_B.id}`)).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Organization' })).toBeNull();
    expect(String(listCalls().at(-1)![0])).toContain(`organizationId=${ORG_A}`);
  });

  it('an org-scoped session (one org, nothing selected yet) sees its own sites without an Organization column', async () => {
    useOrgStore.setState({ currentOrgId: null, organizations: [ORGS[0]!] });
    // The server scopes an org user's org-less listing to their org.
    serveSites([SITE_A]);
    render(<SitesPage />);

    expect(await screen.findByTestId(`sites-row-${SITE_A.id}`)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Organization' })).toBeNull();
  });

  it('a site-scoped session renders exactly the server-narrowed sites and never widens the request (RF1)', async () => {
    // The API applies allowedSiteIds; the page must show what came back and ask for nothing broader.
    serveSites([SITE_A]);
    render(<SitesPage />);

    expect(await screen.findByTestId(`sites-row-${SITE_A.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`sites-row-${SITE_B.id}`)).toBeNull();
    expect(listCalls()).toHaveLength(1);
    // Exactly the plain listing — no extra params that could ask for more.
    expect(String(listCalls()[0]![0])).toBe('/orgs/sites?page=1&limit=100');
  });

  it('Edit in fleet view writes to the row\'s own org, not the (null) ambient scope', async () => {
    granted.add('sites:write');
    serveSites([SITE_A, SITE_B]);
    fetchMock.mockImplementation(async (input, init) => {
      const method = (init as RequestInit | undefined)?.method;
      if (method === 'PATCH') return jsonResponse({});
      return jsonResponse({ data: [SITE_A, SITE_B] });
    });
    render(<SitesPage />);
    await screen.findByTestId(`sites-row-${SITE_B.id}`);

    fireEvent.click(screen.getByTestId(`site-${SITE_B.id}-menu`));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Site name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')!;
    expect(patch[0]).toBe(`/orgs/sites/${SITE_B.id}`);
    expect((patch[1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_B);
  });

  it('hides Add site, Edit and Delete without sites:write', async () => {
    serveSites([SITE_A]);
    render(<SitesPage />);
    await screen.findByTestId(`sites-row-${SITE_A.id}`);

    expect(screen.queryByTestId('sites-add-button')).toBeNull();
    expect(screen.queryByTestId(`site-${SITE_A.id}-menu`)).toBeNull();
  });

  it('fleet add requires an org pick before it writes, then writes to the picked org', async () => {
    granted.add('sites:write');
    serveSites([SITE_A, SITE_B]);
    render(<SitesPage />);
    await screen.findByTestId(`sites-row-${SITE_A.id}`);

    fireEvent.click(screen.getByTestId('sites-add-button'));
    const picker = await screen.findByTestId('sites-org-picker');
    expect((picker as HTMLSelectElement).value).toBe('');

    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'New Site' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create site' }));
    expect(await screen.findByText('Choose the organization this site belongs to.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(false);

    fireEvent.change(picker, { target: { value: ORG_B } });
    fireEvent.click(screen.getByRole('button', { name: 'Create site' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string).orgId).toBe(ORG_B);
  });

  it('with an org selected, add is pre-filled and an org switch mid-add does not retarget the write', async () => {
    granted.add('sites:write');
    useOrgStore.setState({ currentOrgId: ORG_A });
    serveSites([SITE_A, SITE_B]);
    render(<SitesPage />);
    await screen.findByTestId(`sites-row-${SITE_A.id}`);

    fireEvent.click(screen.getByTestId('sites-add-button'));
    await screen.findByLabelText('Site name');
    expect(screen.queryByTestId('sites-org-picker')).toBeNull();

    act(() => useOrgStore.setState({ currentOrgId: ORG_B }));
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'New Site' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create site' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string).orgId).toBe(ORG_A);
    expect((post[1] as { orgIdOverride?: string }).orgIdOverride).toBe(ORG_A);
  });

  it("links each device count to that site's agents in its own org", async () => {
    serveSites([SITE_A, SITE_B]);
    render(<SitesPage />);

    const link = (await screen.findAllByTestId(`sites-device-count-link-${SITE_B.id}`))[0]!;
    expect(link).toHaveTextContent('5');
    const href = link.getAttribute('href')!;
    expect(href.startsWith(`/devices#orgId=${ORG_B}&deviceClass=agent&filtersV2=`)).toBe(true);
    const hash = href.slice(href.indexOf('#'));
    expect(decodeFilterFromHash(hash)).toEqual({
      operator: 'AND',
      conditions: [{ field: 'siteId', operator: 'equals', value: SITE_B.id }],
    });
    expect(readDeviceClassFromHash(hash)).toBe('agent');
  });

  it('renders a non-uuid site count as plain text, not a link', async () => {
    serveSites([{ ...SITE_A, id: 'legacy-site' }]);
    render(<SitesPage />);

    await screen.findByTestId('sites-row-legacy-site');
    expect(screen.queryByTestId('sites-device-count-link-legacy-site')).toBeNull();
  });

  it('opens the site detail page on a row click', async () => {
    serveSites([SITE_A]);
    render(<SitesPage />);

    fireEvent.click(within(await screen.findByTestId(`sites-row-${SITE_A.id}`)).getByText('Alpha HQ'));
    expect(navigateTo).toHaveBeenCalledWith(`/settings/sites/${SITE_A.id}`);
  });

  it('shows a retryable error, not an empty list, when the load fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    render(<SitesPage />);

    expect(await screen.findByTestId('sites-load-error')).toBeInTheDocument();
    expect(screen.queryByText('No sites yet. Add a site to an organization to get started.')).toBeNull();
  });
});
