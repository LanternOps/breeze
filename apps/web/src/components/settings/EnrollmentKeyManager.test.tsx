import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/orgStore', () => {
  const state: Record<string, unknown> = {
    currentOrgId: 'org-1',
    currentSiteId: null,
    sites: [],
    organizations: [],
    isLoading: false,
  };
  const useOrgStore = Object.assign(() => state, { getState: () => state });
  return { useOrgStore };
});
// Pass-through runAction so the request fn (and thus fetchWithAuth) actually runs.
vi.mock('../../lib/runAction', () => ({
  ActionError: class ActionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  runAction: async (o: {
    request: () => Promise<Response>;
    parseSuccess?: (d: unknown) => unknown;
  }) => {
    const r = await o.request();
    const data = await r.json().catch(() => null);
    return o.parseSuccess ? o.parseSuccess(data) : data;
  },
}));

import EnrollmentKeyManager from './EnrollmentKeyManager';
// The store is mocked above; importing it here yields the mock so tests can seed
// currentOrgId / sites / organizations before rendering.
import { useOrgStore } from '../../stores/orgStore';

const orgState = () => (useOrgStore as unknown as { getState: () => Record<string, unknown> }).getState();

function seedOrgState(partial: Record<string, unknown>) {
  Object.assign(orgState(), partial);
}

interface StoreSite {
  id: string;
  orgId: string;
  name: string;
  address?: string;
  deviceCount: number;
  createdAt: string;
}

function makeSite(overrides: Partial<StoreSite> = {}): StoreSite {
  return { id: 'site-a', orgId: 'org-1', name: 'Site A', deviceCount: 0, createdAt: new Date().toISOString(), ...overrides };
}

function makeOrg(id: string, name: string) {
  return { id, partnerId: 'p-1', name, status: 'active' as const, createdAt: new Date().toISOString() };
}

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

interface Row {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string;
  shortCode?: string | null;
  usageCount: number;
  maxUsage: number | null;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

const PAST = new Date(Date.now() - 86_400_000).toISOString();
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'k-1',
    orgId: 'org-1',
    siteId: null,
    name: 'Prod key',
    shortCode: 'ABC123XYZ0',
    usageCount: 0,
    maxUsage: null,
    expiresAt: FUTURE,
    createdBy: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Route all fetches; returns the recorded call list (with parsed body) for assertions. */
function routeFetch(list: Row[], sites: StoreSite[] = []) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  fetchWithAuth.mockImplementation((rawUrl: unknown, opts?: { method?: string; body?: string }) => {
    const url = String(rawUrl ?? '');
    const method = opts?.method ?? 'GET';
    let body: Record<string, unknown> | undefined;
    if (typeof opts?.body === 'string') {
      try { body = JSON.parse(opts.body); } catch { /* non-JSON body */ }
    }
    calls.push({ url, method, body });
    if (url.startsWith('/enrollment-keys/purge-expired') && method === 'POST') {
      return Promise.resolve(jsonRes({ success: true, deletedCount: 2 }));
    }
    // Create: exact path (the list GET carries a `?...` query, so it won't match).
    if (url === '/enrollment-keys' && method === 'POST') {
      return Promise.resolve(jsonRes({ key: 'NEWKEY-123' }));
    }
    if (url.startsWith('/enrollment-keys?')) {
      return Promise.resolve(
        jsonRes({ data: list, pagination: { page: 1, limit: 50, total: list.length } }),
      );
    }
    // The create form always fetches its site list for the selected org (the
    // org switcher no longer preloads a shared site cache).
    if (url.startsWith('/orgs/sites?')) {
      return Promise.resolve(jsonRes({ data: sites }));
    }
    return Promise.resolve(jsonRes({ data: [], pagination: { page: 1, limit: 50, total: 0 } }));
  });
  return calls;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  // Reset the store mock to the default single-org shape between tests.
  seedOrgState({ currentOrgId: 'org-1', currentSiteId: null, sites: [], organizations: [], isLoading: false });
});

describe('EnrollmentKeyManager — short code column', () => {
  it('renders the short code in the row and no legacy "Hidden" text', async () => {
    routeFetch([makeRow({ shortCode: 'ABC123XYZ0' })]);
    render(<EnrollmentKeyManager />);
    expect(await screen.findByText('ABC123XYZ0')).toBeTruthy();
    expect(screen.getByText('Short code')).toBeTruthy();
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('renders a dash when short code is absent', async () => {
    routeFetch([makeRow({ shortCode: null })]);
    render(<EnrollmentKeyManager />);
    await screen.findByText('Prod key');
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('Hidden')).toBeNull();
  });
});

describe('EnrollmentKeyManager — hide expired toggle', () => {
  it('refetches with expired=false when toggled on', async () => {
    const calls = routeFetch([makeRow()]);
    render(<EnrollmentKeyManager />);
    await screen.findByText('Prod key');

    fireEvent.click(screen.getByTestId('hide-expired-toggle'));

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'GET' && c.url.includes('expired=false'))).toBe(true);
    });
    // Initial load must NOT carry the filter.
    expect(calls[0].url.includes('expired=false')).toBe(false);
  });
});

describe('EnrollmentKeyManager — delete expired', () => {
  it('keeps the button enabled even when no listed key is expired', async () => {
    // The button must stay enabled regardless of what's on the current page/filter,
    // since expired keys may exist off-page or be hidden by the "Hide expired" toggle.
    routeFetch([makeRow({ expiresAt: FUTURE })]);
    render(<EnrollmentKeyManager />);
    await screen.findByText('Prod key');
    expect((screen.getByTestId('delete-expired-keys') as HTMLButtonElement).disabled).toBe(false);
  });

  it('purges via POST and refetches page 1 when an expired key is present', async () => {
    const calls = routeFetch([makeRow({ id: 'k-exp', name: 'Old key', expiresAt: PAST })]);
    render(<EnrollmentKeyManager />);
    await screen.findByText('Old key');

    const btn = screen.getByTestId('delete-expired-keys') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    // ConfirmDialog appears; confirm it.
    fireEvent.click(await screen.findByTestId('confirm-delete-expired-keys'));

    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'POST' && c.url.startsWith('/enrollment-keys/purge-expired')),
      ).toBe(true);
    });
    // A refetch (GET) happens after the purge.
    const postIdx = calls.findIndex((c) => c.method === 'POST');
    expect(calls.slice(postIdx + 1).some((c) => c.method === 'GET')).toBe(true);
  });
});

describe('EnrollmentKeyManager — create form site selector', () => {
  const EMPTY = 'No enrollment keys found. Create one to get started.';

  it('submits the selected siteId (and orgId) in the create POST body', async () => {
    seedOrgState({
      currentOrgId: 'org-1',
      organizations: [makeOrg('org-1', 'Org One'), makeOrg('org-2', 'Org Two')],
    });
    const calls = routeFetch([], [
      makeSite({ id: 'site-a', name: 'Site A' }),
      makeSite({ id: 'site-b', name: 'Site B' }),
    ]);
    render(<EnrollmentKeyManager />);
    await screen.findByText(EMPTY);

    fireEvent.click(screen.getByText('Create Key'));
    fireEvent.change(screen.getByPlaceholderText('e.g., Production servers'), {
      target: { value: 'CI key' },
    });

    // Pick a specific site — proves the selection flows into the request body.
    // The site list loads async (fetched per selected org): the select exists
    // in a disabled/placeholder state during the load, so wait for the option.
    await screen.findByRole('option', { name: 'Site B' });
    fireEvent.change(screen.getByTestId('enrollment-key-site-select'), {
      target: { value: 'site-b' },
    });

    const submit = document.querySelector('form button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/enrollment-keys' && c.method === 'POST')).toBe(true);
    });
    const post = calls.find((c) => c.url === '/enrollment-keys' && c.method === 'POST');
    expect(post?.body?.siteId).toBe('site-b');
    expect(post?.body?.orgId).toBe('org-1');
  });

  it('blocks submit and hides the site dropdown when the org has no sites', async () => {
    seedOrgState({
      currentOrgId: 'org-1',
      organizations: [makeOrg('org-1', 'Org One')],
    });
    routeFetch([]);
    render(<EnrollmentKeyManager />);
    await screen.findByText(EMPTY);

    fireEvent.click(screen.getByText('Create Key'));
    // Fill the name so the only thing blocking submit is the missing site.
    fireEvent.change(screen.getByPlaceholderText('e.g., Production servers'), {
      target: { value: 'CI key' },
    });

    // The amber "no sites yet" guidance replaces the dropdown once the async
    // site load resolves empty.
    expect(await screen.findByText('This organization has no sites yet.')).toBeTruthy();
    const submit = document.querySelector('form button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.queryByTestId('enrollment-key-site-select')).toBeNull();
  });

  it('renders the organization select only when more than one org is visible', async () => {
    // Single org → no org selector.
    seedOrgState({
      currentOrgId: 'org-1',
      organizations: [makeOrg('org-1', 'Org One')],
    });
    routeFetch([], [makeSite({ id: 'site-a' })]);
    const { unmount } = render(<EnrollmentKeyManager />);
    await screen.findByText(EMPTY);
    fireEvent.click(screen.getByText('Create Key'));
    expect(screen.queryByTestId('enrollment-key-org-select')).toBeNull();
    unmount();

    // Multiple orgs → org selector present.
    seedOrgState({
      currentOrgId: 'org-1',
      organizations: [makeOrg('org-1', 'Org One'), makeOrg('org-2', 'Org Two')],
    });
    routeFetch([], [makeSite({ id: 'site-a' })]);
    render(<EnrollmentKeyManager />);
    await screen.findByText(EMPTY);
    fireEvent.click(screen.getByText('Create Key'));
    expect(screen.getByTestId('enrollment-key-org-select')).toBeTruthy();
  });
});
