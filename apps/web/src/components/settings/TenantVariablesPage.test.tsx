import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TenantVariablesPage from './TenantVariablesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', async (importOriginal) => {
  // applyOrgId is a pure URL-building helper (no network/state) — keep the
  // real implementation so the coalescing cache key matches production
  // exactly; only fetchWithAuth needs mocking.
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: vi.fn() };
});
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const scopeState = { isPartnerScope: true, orgId: 'org-a' as string | null };
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({
    isPartnerScope: scopeState.isPartnerScope,
    defaultOwnerScope: scopeState.isPartnerScope ? 'partner' : 'organization'
  })
}));
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => ({
    ready: true,
    status: 'resolved',
    scope: scopeState.orgId ? 'org' : 'all',
    orgId: scopeState.orgId,
    org: null,
    error: null
  })
}));

const fetchMock = vi.mocked(fetchWithAuth);
const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG_VAR = {
  id: 'v-1',
  key: 'syslog_host',
  value: 'logs.example.net',
  isSecret: false,
  description: 'Collector address',
  ownerScope: 'organization' as const,
  orgId: 'org-a',
  orgName: 'Acme North',
  partnerId: null,
  version: 1,
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z'
};

const SECRET_VAR = {
  ...ORG_VAR,
  id: 'v-2',
  key: 's1_site_token',
  value: null,
  isSecret: true,
  description: 'SentinelOne site token',
  ownerScope: 'partner' as const,
  orgId: null,
  partnerId: 'p-1'
};

beforeEach(() => {
  vi.clearAllMocks();
  scopeState.isPartnerScope = true;
  scopeState.orgId = 'org-a';
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/tenant-variables?scope=partner' && (!init || !init.method)) {
      return makeJsonResponse({ data: [SECRET_VAR] });
    }
    if (url === '/tenant-variables' && (!init || !init.method)) {
      return makeJsonResponse({ data: [ORG_VAR, SECRET_VAR] });
    }
    if (url === '/tenant-variables' && init?.method === 'POST') {
      return makeJsonResponse({ data: { ...ORG_VAR, id: 'v-3' } }, true, 201);
    }
    if (url.startsWith('/tenant-variables/') && init?.method === 'PUT') {
      return makeJsonResponse({ data: ORG_VAR });
    }
    if (url.startsWith('/tenant-variables/') && init?.method === 'DELETE') {
      return makeJsonResponse({ success: true });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
});

describe('TenantVariablesPage', () => {
  it('requests only partner-wide variables in All Organizations and explains where org rows live', async () => {
    scopeState.orgId = null;
    render(<TenantVariablesPage />);

    await screen.findByTestId('tenant-variable-row-s1_site_token');
    expect(fetchMock).toHaveBeenCalledWith('/tenant-variables?scope=partner');
    expect(screen.queryByTestId('tenant-variable-row-syslog_host')).toBeNull();
    expect(screen.getByTestId('tenant-variables-org-note').textContent).toBe(
      'Organization-owned variables are listed under each organization.'
    );
    expect(screen.queryByTestId('tenant-variable-filter-scope-organization')).toBeNull();
  });

  it('keeps inherited rows with an org selected and labels its own rows with the org name', async () => {
    render(<TenantVariablesPage />);

    const row = await screen.findByTestId('tenant-variable-row-syslog_host');
    expect(fetchMock).toHaveBeenCalledWith('/tenant-variables');
    expect(row.textContent).toContain('Acme North');
    expect(screen.getByTestId('tenant-variable-row-s1_site_token')).toBeTruthy();
    expect(screen.queryByTestId('tenant-variables-org-note')).toBeNull();
  });

  it('does not apply an organization filter when switching to the partner-wide view', async () => {
    const { rerender } = render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    fireEvent.click(screen.getByTestId('tenant-variable-filter-scope-organization'));

    scopeState.orgId = null;
    rerender(<TenantVariablesPage />);

    await screen.findByTestId('tenant-variable-row-s1_site_token');
    expect(fetchMock).toHaveBeenLastCalledWith('/tenant-variables?scope=partner');
    expect(screen.queryByTestId('tenant-variable-row-syslog_host')).toBeNull();

    scopeState.orgId = 'org-a';
    rerender(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    expect(fetchMock).toHaveBeenLastCalledWith('/tenant-variables');
  });

  it('coalesces the outgoing page instance\'s org-switch refetch with the freshly-mounted instance\'s mount fetch (#6103)', async () => {
    // Models Astro's real navigation lifecycle for a same-URL org switch:
    // the org store updates (and the STILL-MOUNTED old page instance reacts
    // and starts refetching) before the soft navigation tears that instance
    // down and mounts a fresh one, which immediately fetches again on mount.
    // Without coalescing that is two network requests for data the old
    // instance's fetch result is thrown away.
    let resolveSwitchFetch: ((r: Response) => void) | undefined;
    const deferred = new Promise<Response>((resolve) => {
      resolveSwitchFetch = resolve;
    });
    const baseImpl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tenant-variables?scope=partner' && (!init || !init.method)) {
        return deferred;
      }
      return baseImpl(input, init);
    });

    const { unmount, rerender } = render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    fetchMock.mockClear();

    // Org store flips to All-orgs; the still-mounted old instance's effect
    // reacts and kicks off its own (soon-to-be-discarded) fetch.
    scopeState.orgId = null;
    rerender(<TenantVariablesPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Astro's remount: old instance torn down, brand-new instance mounted —
    // in the browser this happens while the first request above is still
    // in flight.
    unmount();
    render(<TenantVariablesPage />);
    await new Promise((r) => setTimeout(r, 0));

    // Only ONE network request should have gone out for the partner-scope
    // query across both instances.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveSwitchFetch!(makeJsonResponse({ data: [SECRET_VAR] }));
    await screen.findByTestId('tenant-variable-row-s1_site_token');
  });

  it('lets two concurrently-coalesced callers both read the shared response without throwing (#6103)', async () => {
    // A real Response body can only be read once — a second `.json()` call
    // throws "body stream already read". makeJsonResponse's mocked `.json()`
    // doesn't model that (it can be called any number of times), so this
    // double reads once and throws on the second, exactly like the real
    // fetch API. If two coalesced instances both stay mounted (not
    // guaranteed the outgoing one unmounts before the shared request
    // resolves) and both `await response.json()` on the same raw Response,
    // the second read throws as an unhandled rejection with no user-visible
    // error. The fix caches the PARSED result, not the raw Response, so this
    // must not happen.
    let bodyRead = false;
    const singleReadResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockImplementation(async () => {
        if (bodyRead) throw new TypeError('Body is unusable: body stream already read');
        bodyRead = true;
        return { data: [ORG_VAR, SECRET_VAR] };
      })
    } as unknown as Response;

    let resolveFetch: ((r: Response) => void) | undefined;
    const deferred = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    fetchMock.mockImplementation(async () => deferred);

    render(<TenantVariablesPage />);
    const second = render(<TenantVariablesPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    resolveFetch!(singleReadResponse);

    // Both mounted instances must resolve successfully (no unhandled
    // rejection — vitest fails the run on one, which is the regression guard).
    // Wait on EACH instance: `findAllByTestId` resolves as soon as the first
    // instance has painted, and on a loaded runner the second is a tick
    // behind, so a synchronous `getByTestId` on it flaked three merge-queue
    // entries on 2026-09-18 (#5793, #6075, #6297).
    await screen.findAllByTestId('tenant-variable-row-syslog_host');
    await within(second.container).findByTestId('tenant-variable-row-syslog_host');
  });

  it('reloads with its own request after a delete instead of joining a list GET that was already in flight (#6103)', async () => {
    // A GET that started BEFORE the mutation committed would repaint the
    // pre-mutation list if the post-mutation reload coalesced into it.
    const first = render(<TenantVariablesPage />);
    await within(first.container).findByTestId('tenant-variable-row-syslog_host');

    const baseImpl = fetchMock.getMockImplementation()!;
    // Settled at the end: the in-flight slot is module-level, so a request
    // left hanging here would be joined by the next test.
    const hung: Array<(r: Response) => void> = [];
    const isListGet = (input: unknown, init?: RequestInit) =>
      String(input).startsWith('/tenant-variables') && !String(input).includes('/tenant-variables/') && (!init || !init.method);
    fetchMock.mockImplementation(async (input, init) => {
      if (isListGet(input, init as RequestInit | undefined)) {
        return new Promise<Response>((resolve) => hung.push(resolve));
      }
      return baseImpl(input, init);
    });
    fetchMock.mockClear();

    // A second instance mounts; its list GET hangs in flight.
    render(<TenantVariablesPage />);
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => isListGet(c[0], c[1] as RequestInit | undefined))).toHaveLength(1)
    );

    const row = within(first.container);
    fireEvent.click(row.getByTestId('tenant-variable-delete-syslog_host'));
    fireEvent.click(row.getByTestId('tenant-variable-delete-syslog_host'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => isListGet(c[0], c[1] as RequestInit | undefined))).toHaveLength(2)
    );

    hung.forEach((resolve) => resolve(makeJsonResponse({ data: [] })));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('does not coalesce requests for the same path across different orgs (#6103)', async () => {
    // A rapid org switch landing mid-flight must never let a second caller
    // silently receive the FIRST org's in-flight (and possibly wrong-tenant)
    // response just because the raw path string matches. Neither request
    // needs to resolve for this assertion — only the call count matters.
    const neverResolves = new Promise<Response>(() => {});
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tenant-variables' && (!init || !init.method)) {
        return neverResolves;
      }
      return makeJsonResponse({ data: [] });
    });

    scopeState.isPartnerScope = false;
    scopeState.orgId = 'org-a';
    const { unmount, rerender } = render(<TenantVariablesPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Org switches to a different org before the first request resolves; the
    // still-mounted instance's effect fires a second request for the SAME
    // raw path but a DIFFERENT ambient org.
    scopeState.orgId = 'org-b';
    rerender(<TenantVariablesPage />);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not request partner scope for an organization-scoped caller', async () => {
    scopeState.isPartnerScope = false;
    scopeState.orgId = null;
    render(<TenantVariablesPage />);

    await screen.findByTestId('tenant-variable-row-syslog_host');
    expect(fetchMock).toHaveBeenCalledWith('/tenant-variables');
    expect(screen.queryByTestId('tenant-variables-org-note')).toBeNull();
  });

  it('lists variables and badges the partner-wide row', async () => {
    render(<TenantVariablesPage />);
    expect(await screen.findByTestId('tenant-variable-row-syslog_host')).toBeTruthy();
    const partnerRow = screen.getByTestId('tenant-variable-row-s1_site_token');
    expect(partnerRow.textContent).toContain('All organizations');
  });

  it('masks a secret and never renders its value', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-s1_site_token');
    const row = screen.getByTestId('tenant-variable-row-s1_site_token');
    expect(row.querySelector('[data-testid="tenant-variable-secret-mask"]')).toBeTruthy();
    expect(screen.getByTestId('tenant-variable-row-syslog_host').textContent).toContain('logs.example.net');
  });

  it('creates a partner-wide variable with the ownerScope in the body', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    fireEvent.click(screen.getByTestId('tenant-variable-owner-partner'));
    fireEvent.change(screen.getByTestId('tenant-variable-key-input'), { target: { value: 's1_site_token' } });
    fireEvent.change(screen.getByTestId('tenant-variable-value-input'), { target: { value: 'tok-123' } });
    fireEvent.click(screen.getByTestId('tenant-variable-secret-toggle'));
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
        ownerScope: 'partner',
        key: 's1_site_token',
        value: 'tok-123',
        isSecret: true
      });
    });
  });

  it('sends the selected orgId when creating an org-scoped variable', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    fireEvent.click(screen.getByTestId('tenant-variable-owner-org'));
    fireEvent.change(screen.getByTestId('tenant-variable-key-input'), { target: { value: 'repo_url' } });
    fireEvent.change(screen.getByTestId('tenant-variable-value-input'), { target: { value: 'https://pkg' } });
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
        ownerScope: 'organization',
        orgId: 'org-a'
      });
    });
  });

  it('hides the scope selector for an org-scoped session', async () => {
    scopeState.isPartnerScope = false;
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    expect(screen.queryByTestId('tenant-variable-owner-scope')).toBeNull();
  });

  it('hides edit and delete on an inherited partner-wide row for an org-scoped session', async () => {
    scopeState.isPartnerScope = false;
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-s1_site_token');
    expect(screen.queryByTestId('tenant-variable-edit-s1_site_token')).toBeNull();
    expect(screen.queryByTestId('tenant-variable-delete-s1_site_token')).toBeNull();
    // ...but its own org row stays editable.
    expect(screen.getByTestId('tenant-variable-edit-syslog_host')).toBeTruthy();
  });

  it('rejects an invalid key before issuing a request', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    fireEvent.change(screen.getByTestId('tenant-variable-key-input'), { target: { value: 'Not A Key' } });
    fireEvent.change(screen.getByTestId('tenant-variable-value-input'), { target: { value: 'v' } });
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    expect(await screen.findByTestId('tenant-variable-issues')).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('omits value on edit when the field is left blank, so a secret is not clobbered', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-s1_site_token');

    fireEvent.click(screen.getByTestId('tenant-variable-edit-s1_site_token'));
    expect((screen.getByTestId('tenant-variable-value-input') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByTestId('tenant-variable-description-input'), { target: { value: 'rotated Q3' } });
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body).not.toHaveProperty('value');
      expect(body).toMatchObject({ description: 'rotated Q3' });
    });
  });

  it('blocks un-secreting without a replacement value', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-s1_site_token');

    fireEvent.click(screen.getByTestId('tenant-variable-edit-s1_site_token'));
    fireEvent.click(screen.getByTestId('tenant-variable-secret-toggle'));
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    expect(await screen.findByTestId('tenant-variable-issues')).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('requires a second click to delete, then issues the DELETE', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-delete-syslog_host'));
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByTestId('tenant-variable-delete-syslog_host'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
    });
  });

  it('filters the list by a key substring', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    await screen.findByTestId('tenant-variable-row-s1_site_token');

    fireEvent.change(screen.getByTestId('tenant-variable-search'), { target: { value: 'syslog' } });

    expect(screen.getByTestId('tenant-variable-row-syslog_host')).toBeTruthy();
    expect(screen.queryByTestId('tenant-variable-row-s1_site_token')).toBeNull();
  });

  it('filters the list by a description substring', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    await screen.findByTestId('tenant-variable-row-s1_site_token');

    fireEvent.change(screen.getByTestId('tenant-variable-search'), { target: { value: 'SentinelOne' } });

    expect(screen.getByTestId('tenant-variable-row-s1_site_token')).toBeTruthy();
    expect(screen.queryByTestId('tenant-variable-row-syslog_host')).toBeNull();
  });

  it('shows a no-matches state when the search excludes every row', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.change(screen.getByTestId('tenant-variable-search'), { target: { value: 'no-such-key' } });

    expect(await screen.findByTestId('tenant-variables-no-matches')).toBeTruthy();
    expect(screen.queryByTestId('tenant-variable-row-syslog_host')).toBeNull();
  });

  it('filters the list to organization-scoped rows only', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    await screen.findByTestId('tenant-variable-row-s1_site_token');

    fireEvent.click(screen.getByTestId('tenant-variable-filter-scope-organization'));

    expect(screen.getByTestId('tenant-variable-row-syslog_host')).toBeTruthy();
    expect(screen.queryByTestId('tenant-variable-row-s1_site_token')).toBeNull();
  });

  it('filters the list to partner-wide rows only', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    await screen.findByTestId('tenant-variable-row-s1_site_token');

    fireEvent.click(screen.getByTestId('tenant-variable-filter-scope-partner'));

    expect(screen.getByTestId('tenant-variable-row-s1_site_token')).toBeTruthy();
    expect(screen.queryByTestId('tenant-variable-row-syslog_host')).toBeNull();
  });

  it('refetches when the org switcher changes, and replaces the displayed rows', async () => {
    const ORG_B_VAR = { ...ORG_VAR, id: 'v-9', key: 'repo_url', description: 'Org B package repo', orgId: 'org-b' };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tenant-variables' && (!init || !init.method)) {
        return makeJsonResponse({ data: scopeState.orgId === 'org-b' ? [ORG_B_VAR] : [ORG_VAR, SECRET_VAR] });
      }
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });

    const { rerender } = render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    const getCalls = () =>
      fetchMock.mock.calls.filter((call) => call[0] === '/tenant-variables' && !(call[1] as RequestInit | undefined)?.method);
    expect(getCalls()).toHaveLength(1);

    scopeState.orgId = 'org-b';
    rerender(<TenantVariablesPage />);

    await waitFor(() => expect(getCalls()).toHaveLength(2));
    // The previous org's rows are gone, not just appended to — a stale list
    // left on screen after switching orgs is exactly the #5354 regression.
    await waitFor(() => expect(screen.getByTestId('tenant-variable-row-repo_url')).toBeTruthy());
    expect(screen.queryByTestId('tenant-variable-row-syslog_host')).toBeNull();
  });

  it('surfaces a failed save as an error toast', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tenant-variables' && (!init || !init.method)) return makeJsonResponse({ data: [ORG_VAR] });
      return makeJsonResponse({ error: 'A variable named "repo_url" already exists in this scope' }, false, 409);
    });

    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    fireEvent.change(screen.getByTestId('tenant-variable-key-input'), { target: { value: 'repo_url' } });
    fireEvent.change(screen.getByTestId('tenant-variable-value-input'), { target: { value: 'https://pkg' } });
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    // The editor stays open so the tech can fix the key.
    expect(screen.getByTestId('tenant-variable-editor')).toBeTruthy();
  });
});
