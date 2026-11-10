import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// #9791 C: the Patches page reads its tab through the shared hash grammar
// (parseHashGrammar), and the compliance status filter lives in the hash:
// `#compliance&status=…` ≡ `#status=…`. Legacy tab hashes keep resolving (RF4).

vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => {
  const read = () => ({ currentOrgId: null, organizations: [{ id: 'org-1', name: 'Acme Corp' }] });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});
vi.mock('../../lib/authScope', () => {
  const claims = () => ({ scope: 'partner', partnerId: 'p1', orgId: null });
  return { getJwtClaims: claims, useJwtClaims: () => ({ status: 'resolved' as const, claims: claims() }) };
});

import PatchesPage from './PatchesPage';
import { fetchWithAuth } from '../../stores/auth';
import { orgSwitchKeptHash } from '../../lib/orgSwitch';
import { useFeaturesStore } from '../../stores/featuresStore';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500) =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const complianceCalls = () =>
  fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith('/patches/compliance') && !u.startsWith('/patches/compliance/report'));

const activeTabText = () =>
  screen.getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page')?.textContent ?? '';

describe('PatchesPage hash grammar (#9791 C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFeaturesStore.setState({
      loaded: false,
      configOk: false,
      features: { ...useFeaturesStore.getState().features, vendorUpdates: false },
    });
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/config') return json({ features: { vendorUpdates: false } });
      if (url === '/update-rings') return json({ data: [] });
      if (url.startsWith('/patches?')) return json({ data: [] });
      if (url.startsWith('/patches/compliance')) {
        return json({ data: { totalDevices: 0, compliantDevices: 0, devicesNeedingPatches: [], devices: [] } });
      }
      if (url.startsWith('/patches/jobs')) return json({ data: [] });
      return json({ data: [] });
    });
  });

  it.each([
    ['#compliance&status=failed', 'failed'],
    ['#status=failed', 'failed'],
    ['#compliance&status=critical', 'critical'],
    ['#compliance&status=compliant', 'compliant'],
    ['#compliance&status=needs-patches', 'needs-patches'],
  ])('%s opens the compliance tab with the %s filter and fetches it', async (hash, status) => {
    window.history.replaceState({}, '', `/patches${hash}`);
    render(<PatchesPage />);
    const select = await screen.findByRole('combobox', { name: 'Compliance status filter' });
    await waitFor(() => expect(select).toHaveValue(status));
    expect(activeTabText()).toMatch(/compliance/i);
    await waitFor(() =>
      expect(complianceCalls().some((u) => new URL(u, 'http://x').searchParams.get('status') === status)).toBe(true),
    );
    // the page never rewrites a status deep link away
    expect(window.location.hash).toBe(hash);
  });

  it('an empty hash is the compliance tab with no status filter', async () => {
    window.history.replaceState({}, '', '/patches');
    render(<PatchesPage />);
    const select = await screen.findByRole('combobox', { name: 'Compliance status filter' });
    expect(select).toHaveValue('all');
    await waitFor(() => expect(complianceCalls().length).toBeGreaterThan(0));
    expect(complianceCalls().every((u) => !u.includes('status='))).toBe(true);
  });

  it('an unknown status falls back to all', async () => {
    window.history.replaceState({}, '', '/patches#compliance&status=bogus');
    render(<PatchesPage />);
    expect(await screen.findByRole('combobox', { name: 'Compliance status filter' })).toHaveValue('all');
  });

  it.each([
    ['#patches', /^patches$/i],
    ['#rings', /rings/i],
    ['#jobs', /jobs/i],
  ])('legacy %s still selects its tab (RF4)', async (hash, label) => {
    window.history.replaceState({}, '', `/patches${hash}`);
    render(<PatchesPage />);
    await waitFor(() => expect(activeTabText().trim()).toMatch(label));
    expect(screen.queryByRole('combobox', { name: 'Compliance status filter' })).toBeNull();
  });

  // #10083: a header org switch re-renders the page in place. The page keeps
  // its tab and status filter (org-agnostic) and drops a selected patch id.
  it('offers its tab and status filter to an org switch, and withdraws on unmount (#10083)', async () => {
    window.history.replaceState({}, '', '/patches#compliance&status=critical');
    const { unmount } = render(<PatchesPage />);
    await screen.findByRole('combobox', { name: 'Compliance status filter' });
    expect(orgSwitchKeptHash()).toBe('compliance&status=critical');

    // Asked at switch time: follows the URL the user has moved to since mount.
    window.history.replaceState({}, '', '/patches#rings');
    expect(orgSwitchKeptHash()).toBe('rings');

    unmount();
    expect(orgSwitchKeptHash()).toBeNull();
  });

  it('offers the patches tab, not the patch a details drawer selected (#10083)', async () => {
    window.history.replaceState({}, '', '/patches#patches/abc-123');
    render(<PatchesPage />);
    await waitFor(() => expect(activeTabText().trim()).toMatch(/^patches$/i));
    expect(orgSwitchKeptHash()).toBe('patches');
  });

  describe('the Vendor updates tab (#11074)', () => {
    const fleetCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/oem-updates/fleet'));

    beforeEach(() => {
      const compliance = fetchMock.getMockImplementation();
      fetchMock.mockImplementation(async (input, init) => (String(input) === '/config'
        ? json({ features: { vendorUpdates: true } })
        : String(input).startsWith('/oem-updates/fleet')
        ? json({
            counts: { up_to_date: 0, overdue: 0, failing: 0, not_supported: 0, not_managed: 2, waiting_for_reboot: 0, reboot_overdue: 0 },
            total: 0,
            devices: [],
          })
        : compliance!(input, init)));
    });

    it('#vendor-updates selects the tab and loads the fleet', async () => {
      window.history.replaceState({}, '', '/patches#vendor-updates');
      render(<PatchesPage />);
      await waitFor(() => expect(activeTabText().trim()).toMatch(/vendor updates/i));
      await waitFor(() => expect(fleetCalls().length).toBeGreaterThan(0));
      expect(screen.queryByRole('combobox', { name: 'Compliance status filter' })).toBeNull();
      expect(window.location.hash).toBe('#vendor-updates');
    });

    it('a deep link keeps its filter, and the page does not rewrite it away', async () => {
      window.history.replaceState({}, '', '/patches#vendor-updates&state=overdue');
      render(<PatchesPage />);
      await waitFor(() => expect(fleetCalls().some((u) => u.includes('state=overdue'))).toBe(true));
      expect(window.location.hash).toBe('#vendor-updates&state=overdue');
    });

    it('offers the tab and its filter to an org switch', async () => {
      window.history.replaceState({}, '', '/patches#vendor-updates&state=failing');
      render(<PatchesPage />);
      await waitFor(() => expect(activeTabText().trim()).toMatch(/vendor updates/i));
      expect(orgSwitchKeptHash()).toBe('vendor-updates&state=failing');
    });

    it('a deep link survives /config still being in flight, then selects the tab (#11249)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === '/config') { await gate; return json({ features: { vendorUpdates: true } }); }
        return base(input, init);
      });
      window.history.replaceState({}, '', '/patches#vendor-updates&state=overdue');
      render(<PatchesPage />);
      await screen.findByRole('combobox', { name: 'Compliance status filter' });
      expect(activeTabText()).toMatch(/compliance/i);
      expect(window.location.hash).toBe('#vendor-updates&state=overdue');
      expect(fleetCalls()).toEqual([]);

      release();
      await waitFor(() => expect(activeTabText().trim()).toMatch(/vendor updates/i));
      await waitFor(() => expect(fleetCalls().some((u) => u.includes('state=overdue'))).toBe(true));
      expect(window.location.hash).toBe('#vendor-updates&state=overdue');
    });

    it('does not load the fleet on the other tabs', async () => {
      window.history.replaceState({}, '', '/patches');
      render(<PatchesPage />);
      await screen.findByRole('combobox', { name: 'Compliance status filter' });
      expect(fleetCalls()).toEqual([]);
    });

    it('clicking the tab writes the hash', async () => {
      window.history.replaceState({}, '', '/patches');
      render(<PatchesPage />);
      await screen.findByRole('combobox', { name: 'Compliance status filter' });
      fireEvent.click(await screen.findByRole('button', { name: /vendor updates/i }));
      await waitFor(() => expect(window.location.hash).toBe('#vendor-updates'));
    });
  });

  describe('the Vendor updates tab with the feature off (#11249)', () => {
    const fleetCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/oem-updates/fleet'));
    const tabLabels = () => screen.getAllByRole('button').map((b) => b.textContent ?? '');

    it('renders no Vendor updates tab', async () => {
      window.history.replaceState({}, '', '/patches');
      render(<PatchesPage />);
      await screen.findByRole('combobox', { name: 'Compliance status filter' });
      await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
      expect(tabLabels().some((l) => /vendor updates/i.test(l))).toBe(false);
      expect(tabLabels().some((l) => /jobs/i.test(l))).toBe(true);
    });

    it('#vendor-updates falls back to the default tab, with no fleet query and no error', async () => {
      window.history.replaceState({}, '', '/patches#vendor-updates&state=overdue');
      render(<PatchesPage />);
      await screen.findByRole('combobox', { name: 'Compliance status filter' });
      await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
      expect(activeTabText()).toMatch(/compliance/i);
      expect(fleetCalls()).toEqual([]);
      expect(screen.queryByRole('alert')).toBeNull();
      // the page shows the default tab but never rewrites the URL
      expect(window.location.hash).toBe('#vendor-updates&state=overdue');
    });

    it('a failed /config also hides the tab and never reads the fleet', async () => {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => (String(input) === '/config' ? json({}, false, 500) : base(input, init)));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      window.history.replaceState({}, '', '/patches#vendor-updates');
      render(<PatchesPage />);
      await screen.findByRole('combobox', { name: 'Compliance status filter' });
      await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
      expect(tabLabels().some((l) => /vendor updates/i.test(l))).toBe(false);
      expect(fleetCalls()).toEqual([]);
      errSpy.mockRestore();
    });
  });

  it('legacy #patches/<id> still selects the patches tab (RF4)', async () => {
    window.history.replaceState({}, '', '/patches#patches/abc-123');
    render(<PatchesPage />);
    await waitFor(() => expect(activeTabText().trim()).toMatch(/^patches$/i));
  });
});
