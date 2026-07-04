import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: { getState: () => ({ currentOrgId: 'org-1' }) },
}));
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

/** Route all fetches; returns the recorded call list for assertions. */
function routeFetch(list: Row[]) {
  const calls: Array<{ url: string; method: string }> = [];
  fetchWithAuth.mockImplementation((rawUrl: unknown, opts?: { method?: string }) => {
    const url = String(rawUrl ?? '');
    const method = opts?.method ?? 'GET';
    calls.push({ url, method });
    if (url.startsWith('/enrollment-keys/purge-expired') && method === 'POST') {
      return Promise.resolve(jsonRes({ success: true, deletedCount: 2 }));
    }
    if (url.startsWith('/enrollment-keys?')) {
      return Promise.resolve(
        jsonRes({ data: list, pagination: { page: 1, limit: 50, total: list.length } }),
      );
    }
    return Promise.resolve(jsonRes({ data: [], pagination: { page: 1, limit: 50, total: 0 } }));
  });
  return calls;
}

beforeEach(() => fetchWithAuth.mockReset());

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
  it('disables the button when no listed key is expired', async () => {
    routeFetch([makeRow({ expiresAt: FUTURE })]);
    render(<EnrollmentKeyManager />);
    await screen.findByText('Prod key');
    expect((screen.getByTestId('delete-expired-keys') as HTMLButtonElement).disabled).toBe(true);
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
