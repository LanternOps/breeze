import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import OrgSitesTab from './OrgSitesTab';
import { fetchWithAuth } from '@/stores/auth';
import { useOrgStore } from '@/stores/orgStore';

vi.mock('@/stores/auth', async () => {
  const actual = await vi.importActual<typeof import('@/stores/auth')>('@/stores/auth');
  return { ...actual, fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() };
});

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const RECORD_ORG = 'org-record-1';
const OTHER_ORG = 'org-other-2';
const SITE = { id: 'site-1', name: 'Downtown Office', timezone: 'UTC', deviceCount: 5 };

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('OrgSitesTab', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // The switcher points at a DIFFERENT org than the record — every request
    // this tab issues must still carry the record's own org.
    useOrgStore.setState({ currentOrgId: OTHER_ORG, allOrgs: false } as never);
  });

  it('loads and renders the record org sites, pinned via orgIdOverride while the store points elsewhere', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [SITE] }));
    render(<OrgSitesTab orgId={RECORD_ORG} orgName="Acme Dental" />);

    // SiteList renders the name in both its desktop and mobile layouts.
    await waitFor(() => expect(screen.getAllByText('Downtown Office').length).toBeGreaterThan(0));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`/orgs/sites?organizationId=${RECORD_ORG}`);
    expect((init as { orgIdOverride?: string })?.orgIdOverride).toBe(RECORD_ORG);
  });

  it('the add flow POSTs a site scoped to the record org, then refreshes the list', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === '/orgs/sites' && init?.method === 'POST') return jsonResponse({ id: 'new-site' });
      if (u.startsWith('/orgs/sites?organizationId=')) return jsonResponse({ data: [SITE] });
      return jsonResponse({ data: [] });
    });
    const user = userEvent.setup();
    render(<OrgSitesTab orgId={RECORD_ORG} orgName="Acme Dental" />);

    await waitFor(() => expect(screen.getAllByText('Downtown Office').length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: /add site/i }));

    const nameInput = await screen.findByLabelText(/site name/i);
    await user.type(nameInput, 'New Branch');
    await user.click(screen.getByRole('button', { name: /create site/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === '/orgs/sites' && (init as RequestInit)?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.orgId).toBe(RECORD_ORG);
    });
  });

  it('shows a real error state on a failed load, not "no sites" (#5075 W02 review)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500));
    render(<OrgSitesTab orgId={RECORD_ORG} orgName="Acme Dental" />);

    await waitFor(() => expect(screen.getByTestId('org-sites-load-error')).toBeTruthy());
    expect(screen.queryByText(/no sites/i)).toBeNull();
  });

  it('shows the error state on a malformed 200 body too, and retry re-issues the request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    render(<OrgSitesTab orgId={RECORD_ORG} orgName="Acme Dental" />);

    await waitFor(() => expect(screen.getByTestId('org-sites-load-error')).toBeTruthy());

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [SITE] }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getAllByText('Downtown Office').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('org-sites-load-error')).toBeNull();
  });
});
