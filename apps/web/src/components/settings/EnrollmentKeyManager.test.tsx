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
  installerTokens?: {
    consumed: number;
    max: number;
    liveConsumed?: number;
    liveMax?: number;
  } | null;
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
    // The site list loads async (fetched per selected org). Waiting for the
    // option alone is racy: options commit one render before sitesLoading flips
    // false (separate .then/.finally state updates), and the default-site
    // effect runs after that commit — a change fired inside that window is
    // lost and the default (site-a) wins. Wait for the settled state instead:
    // select enabled AND defaulted to the first site.
    const siteSelect = screen.getByTestId('enrollment-key-site-select');
    await waitFor(() => {
      expect(siteSelect).toBeEnabled();
      expect(siteSelect).toHaveValue('site-a');
    });
    fireEvent.change(siteSelect, { target: { value: 'site-b' } });

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

  it('leaving the device-limit field blank sends the 50-device default, not a single-use maxUsage (#4126 paper cut #31)', async () => {
    seedOrgState({
      currentOrgId: 'org-1',
      organizations: [makeOrg('org-1', 'Org One')],
    });
    const calls = routeFetch([], [makeSite({ id: 'site-a', name: 'Site A' })]);
    render(<EnrollmentKeyManager />);
    await screen.findByText(EMPTY);

    fireEvent.click(screen.getByText('Create Key'));
    fireEvent.change(screen.getByPlaceholderText('e.g., Production servers'), {
      target: { value: 'CI key' },
    });

    const siteSelect = screen.getByTestId('enrollment-key-site-select');
    await waitFor(() => {
      expect(siteSelect).toBeEnabled();
      expect(siteSelect).toHaveValue('site-a');
    });

    // The max-uses field is left untouched (blank) — the placeholder promises
    // a sane default, not a single-use key.
    const submit = document.querySelector('form button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/enrollment-keys' && c.method === 'POST')).toBe(true);
    });
    const post = calls.find((c) => c.url === '/enrollment-keys' && c.method === 'POST');
    expect(post?.body?.maxUsage).toBe(50);
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

  // ------------------------------------------------------------------
  // #2992 — installer capacity in the usage cell.
  //
  // The Add-Device / guided-setup download paths mint no child enrollment key,
  // so the device count the operator chose lives only on the bootstrap token.
  // The key's own usage_count is inert on that path, which is why the row read
  // "0 / 1" for an installer built for 7 devices.
  // ------------------------------------------------------------------
  describe('installer usage (#2992)', () => {
    it('shows the installer device budget alongside the key\'s own counters', async () => {
      routeFetch([
        makeRow({
          id: 'k-installer',
          usageCount: 0,
          maxUsage: 1,
          installerTokens: { consumed: 0, max: 7 },
        }),
      ]);
      render(<EnrollmentKeyManager />);

      const installerCell = await screen.findByTestId('key-installer-usage-k-installer');
      expect(installerCell.textContent).toContain('0');
      expect(installerCell.textContent).toContain('7');

      // The key's own budget is still rendered — it is a real, separately
      // enforced counter, not something the installer figure replaces.
      expect(screen.getByTestId('key-usage-k-installer').textContent).toContain('0 / 1');
    });

    it('counts up as devices redeem the installer', async () => {
      routeFetch([
        makeRow({
          id: 'k-partial',
          usageCount: 0,
          maxUsage: 1,
          installerTokens: { consumed: 3, max: 7 },
        }),
      ]);
      render(<EnrollmentKeyManager />);

      const cell = await screen.findByTestId('key-installer-usage-k-partial');
      expect(cell.textContent).toContain('3');
      expect(cell.textContent).toContain('7');
    });

    // The design's justification for TWO lines rather than a replacement: some
    // keys carry both counters live (an installer-link child key accrues
    // usage_count from direct enrollments AND parents bootstrap tokens issued
    // by the one-time public-download route). Collapsing them would hide a real
    // budget, so both must render with their own numbers.
    it('renders both counters when a key has real usage AND installers', async () => {
      routeFetch([
        makeRow({
          id: 'k-both',
          usageCount: 4,
          maxUsage: 10,
          installerTokens: { consumed: 2, max: 3 },
        }),
      ]);
      render(<EnrollmentKeyManager />);

      expect((await screen.findByTestId('key-usage-k-both')).textContent).toContain('4 / 10');
      const installer = screen.getByTestId('key-installer-usage-k-both');
      expect(installer.textContent).toContain('2');
      expect(installer.textContent).toContain('3');
      // The two must stay distinct — neither folded into nor replacing the other.
      expect(installer.textContent).not.toContain('10');
    });

    it('renders nothing extra for a key that never minted an installer', async () => {
      routeFetch([makeRow({ id: 'k-plain', usageCount: 2, maxUsage: 10, installerTokens: null })]);
      render(<EnrollmentKeyManager />);

      await screen.findByTestId('key-usage-k-plain');
      expect(screen.queryByTestId('key-installer-usage-k-plain')).toBeNull();
      expect(screen.getByTestId('key-usage-k-plain').textContent).toContain('2 / 10');
    });

    // A response from an API that predates this field must not crash or render
    // a bare "/" — the property is optional on the wire.
    it('tolerates a list response with no installerTokens field at all', async () => {
      routeFetch([makeRow({ id: 'k-legacy', usageCount: 1, maxUsage: 5 })]);
      render(<EnrollmentKeyManager />);

      await screen.findByTestId('key-usage-k-legacy');
      expect(screen.queryByTestId('key-installer-usage-k-legacy')).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // #3039 — live vs expired installer capacity, and token-derived row status.
  //
  // The Add-Device parent key is a 60-minute container while the bootstrap
  // token minted from it can live a year, so neither the parent's expiry nor
  // the all-token capacity sum tells the truth on its own: a fully-expired
  // installer rendered "0 / 7" (reads as seven usable slots), and the badge
  // said Expired while the installer was still enrolling devices.
  // ------------------------------------------------------------------
  describe('installer capacity liveness (#3039)', () => {
    it('marks a fully-expired installer instead of rendering its slots as usable', async () => {
      routeFetch([
        makeRow({
          id: 'k-dead',
          usageCount: 0,
          maxUsage: 1,
          expiresAt: FUTURE,
          installerTokens: { consumed: 0, max: 7, liveConsumed: 0, liveMax: 0 },
        }),
      ]);
      render(<EnrollmentKeyManager />);

      const cell = await screen.findByTestId('key-installer-usage-k-dead');
      // Totals stay (stable historical figure) but the expired marker
      // withdraws the capacity claim.
      expect(cell.textContent).toContain('0 / 7');
      expect(cell.textContent?.toLowerCase()).toContain('expired');
    });

    it('splits live and expired slots when only some installers are still redeemable', async () => {
      routeFetch([
        makeRow({
          id: 'k-mixed',
          usageCount: 0,
          maxUsage: 1,
          installerTokens: { consumed: 4, max: 12, liveConsumed: 1, liveMax: 7 },
        }),
      ]);
      render(<EnrollmentKeyManager />);

      const cell = await screen.findByTestId('key-installer-usage-k-mixed');
      expect(cell.textContent).toContain('1 / 7');
      expect(cell.textContent?.toLowerCase()).toContain('live');
      // 12 − 7 = 5 dead slots, called out rather than folded into capacity.
      expect(cell.textContent).toContain('5');
    });

    it('keeps the row Active when the parent expired but its installer is live', async () => {
      routeFetch([
        makeRow({
          id: 'k-outlives',
          usageCount: 0,
          maxUsage: 1,
          siteId: 'site-a', // the Download gate needs a site — without one the
          // button never renders and the assertion below would pass vacuously
          expiresAt: PAST, // transient Add-Device parent, long dead
          installerTokens: { consumed: 2, max: 7, liveConsumed: 2, liveMax: 7 },
        }),
        // Positive control: a live parent with a site DOES get the Download
        // action — proves the absence assertion below isn't a translation or
        // markup artifact.
        makeRow({ id: 'k-live-parent', siteId: 'site-a', expiresAt: FUTURE }),
      ]);
      render(<EnrollmentKeyManager />);

      await screen.findByTestId('key-installer-usage-k-outlives');
      expect(screen.getAllByText('Active').length).toBe(2);
      expect(screen.queryByText('Expired')).toBeNull();
      // But the Download action follows the PARENT key, which the installer
      // routes 410 on once expired — a live token must not re-enable it. Only
      // the control row (live parent) may offer it.
      expect(screen.getAllByText('Download')).toHaveLength(1);
    });

    it('shows Expired when both the parent and every installer token are dead', async () => {
      routeFetch([
        makeRow({
          id: 'k-all-dead',
          usageCount: 0,
          maxUsage: 1,
          expiresAt: PAST,
          installerTokens: { consumed: 3, max: 7, liveConsumed: 0, liveMax: 0 },
        }),
      ]);
      render(<EnrollmentKeyManager />);

      await screen.findByTestId('key-installer-usage-k-all-dead');
      expect(screen.getByText('Expired')).toBeTruthy();
      expect(screen.queryByText('Active')).toBeNull();
    });

    it('shows Exhausted when unexpired installers exist but every slot is claimed', async () => {
      routeFetch([
        makeRow({
          id: 'k-full',
          usageCount: 0,
          maxUsage: 1,
          expiresAt: PAST,
          installerTokens: { consumed: 7, max: 7, liveConsumed: 7, liveMax: 7 },
        }),
      ]);
      render(<EnrollmentKeyManager />);

      await screen.findByTestId('key-installer-usage-k-full');
      expect(screen.getByText('Exhausted')).toBeTruthy();
    });

    it('falls back to parent-based status when the API omits the live fields', async () => {
      // A legacy response must not have its expired badge flipped by guessing
      // every token alive.
      routeFetch([
        makeRow({
          id: 'k-legacy-status',
          usageCount: 0,
          maxUsage: 1,
          expiresAt: PAST,
          installerTokens: { consumed: 2, max: 7 },
        }),
      ]);
      render(<EnrollmentKeyManager />);

      await screen.findByTestId('key-installer-usage-k-legacy-status');
      expect(screen.getByText('Expired')).toBeTruthy();
      // The capacity line still renders in its pre-liveness form.
      expect(
        screen.getByTestId('key-installer-usage-k-legacy-status').textContent,
      ).toContain('2 / 7');
    });
  });
});

// #3964: the subtitle goes through <Trans>, whose markup parser used to escape
// the literal `<key>` in the locale value into the visible text "&lt;key>".
// Its `components={{ code }}` map was dead at the same time, because no locale
// variant carried a <code> tag for it to bind to.
describe('EnrollmentKeyManager — subtitle (#3964)', () => {
  it('renders the CLI placeholder as literal angle brackets, not an escaped entity', async () => {
    routeFetch([]);
    render(<EnrollmentKeyManager />);

    const subtitle = await screen.findByText(/Create and manage keys for agent enrollment/);
    expect(subtitle.textContent).toContain('breeze-agent enroll <key>');
    expect(subtitle.textContent).not.toContain('&lt;');
    expect(subtitle.textContent).not.toContain('&amp;');
  });

  it('binds the command to the styled <code> wrapper the components map provides', async () => {
    routeFetch([]);
    render(<EnrollmentKeyManager />);

    const subtitle = await screen.findByText(/Create and manage keys for agent enrollment/);
    const code = subtitle.querySelector('code');
    expect(code, 'the components={{ code }} map must actually bind').toBeTruthy();
    expect(code?.textContent).toBe('breeze-agent enroll <key>');
  });
});
