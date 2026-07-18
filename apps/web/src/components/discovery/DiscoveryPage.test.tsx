import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DiscoveryPage from './DiscoveryPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const orgStoreState: {
  currentOrgId: string | null;
  sites: unknown[];
  organizations: unknown[];
  allOrgs: boolean;
  fetchSites: () => void;
} = {
  currentOrgId: 'org-1',
  sites: [],
  organizations: [],
  allOrgs: false,
  fetchSites: vi.fn()
};

// Selector-aware: OrgRequiredState reads useOrgStore((s) => s.organizations).
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector?: (s: typeof orgStoreState) => unknown) =>
    selector ? selector(orgStoreState) : orgStoreState
}));

vi.mock('../../lib/navigation', () => ({
  navigateTo: vi.fn()
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn()
}));

vi.mock('./DiscoveryProfileForm', () => ({
  defaultAlertSettings: {
    enabled: false,
    severity: 'warning',
    channels: []
  },
  default: () => null
}));

vi.mock('./DiscoveryJobList', () => ({
  default: ({ profileFilter }: { profileFilter: string | null }) => (
    <div data-testid="jobs-filter">{profileFilter}</div>
  )
}));

vi.mock('./DiscoveredAssetList', () => ({
  default: () => <div>Assets tab</div>
}));

vi.mock('./AssetDetailModal', () => ({
  default: () => null
}));

vi.mock('./NetworkTopologyMap', () => ({
  default: () => <div>Topology tab</div>
}));

vi.mock('./NetworkChangesPanel', () => ({
  default: () => <div>Changes tab</div>
}));

// The discovery profiles render through ResponsiveTable, which puts both a
// desktop <table> and a mobile card list in the DOM at once (the sm: breakpoint
// is CSS-only, invisible to jsdom). Scope row text/label queries to the desktop
// surface so duplicated content doesn't produce multiple-match errors.
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);
const navigateToMock = vi.mocked(navigateTo);

const profilesPayload = {
  data: [{
    id: 'profile-1',
    name: 'HQ sweep',
    siteId: 'site-1',
    subnets: ['10.0.0.0/24'],
    methods: ['icmp'],
    schedule: { type: 'manual' },
    lastRunAt: null
  }]
};

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  } as unknown as Response;
}

describe('DiscoveryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgStoreState.currentOrgId = 'org-1';
    orgStoreState.sites = [];
    orgStoreState.allOrgs = false;
    window.history.pushState({}, '', '/discovery#profiles');
  });

  it('derives the initial tab from window.location.hash', async () => {
    window.history.pushState({}, '', '/discovery#topology');
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

    render(<DiscoveryPage />);

    expect(await screen.findByText('Topology tab')).toBeInTheDocument();
  });

  it('defaults to the Assets tab when there is no hash', async () => {
    window.history.pushState({}, '', '/discovery');
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

    render(<DiscoveryPage />);

    expect(await screen.findByText('Assets tab')).toBeInTheDocument();
  });

  it('updates the hash when a tab is clicked', async () => {
    window.history.pushState({}, '', '/discovery');
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

    render(<DiscoveryPage />);
    await screen.findByText('Assets tab');

    fireEvent.click(screen.getByRole('button', { name: 'Topology' }));

    expect(window.location.hash).toBe('#topology');
    expect(await screen.findByText('Topology tab')).toBeInTheDocument();
  });

  it('toasts and shows a per-profile loading state while queuing a scan', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(profilesPayload));

    let resolveScan: (response: Response) => void = () => {};
    fetchWithAuthMock.mockImplementationOnce(
      () => new Promise<Response>(resolve => {
        resolveScan = resolve;
      })
    );

    render(<DiscoveryPage />);

    await screen.findAllByText('HQ sweep');

    fireEvent.click(desktop().getByLabelText('Run HQ sweep'));

    expect(desktop().getByLabelText('Running HQ sweep')).toBeDisabled();
    expect(fetchWithAuthMock).toHaveBeenLastCalledWith('/discovery/scan', {
      method: 'POST',
      body: JSON.stringify({ profileId: 'profile-1' })
    });

    resolveScan(makeJsonResponse({ success: true }));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith({
        message: 'Discovery scan queued for "HQ sweep"',
        type: 'success'
      });
    });
    expect(await screen.findByTestId('jobs-filter')).toHaveTextContent('profile-1');
  });

  it('surfaces an error toast and inline message, clears the spinner, and stays on the profiles tab when the scan fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(profilesPayload));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'Scan queue is full' }, false, 500)
    );

    render(<DiscoveryPage />);
    await screen.findAllByText('HQ sweep');

    fireEvent.click(desktop().getByLabelText('Run HQ sweep'));

    // Error toast fired (runAction surfaces non-401 ActionErrors).
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith({
        message: 'Scan queue is full',
        type: 'error'
      });
    });

    // Inline banner also rendered for the persistent failure signal.
    expect(await screen.findByText('Scan queue is full')).toBeInTheDocument();

    // Spinner cleared (finally ran) — button is back to its idle, enabled state.
    await waitFor(() => expect(desktop().getByLabelText('Run HQ sweep')).not.toBeDisabled());

    // A failed queue must NOT navigate the user to an empty jobs view.
    expect(screen.queryByTestId('jobs-filter')).not.toBeInTheDocument();
  });

  it('treats an HTTP-200 {success:false} body as a failure', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(profilesPayload));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ success: false, error: 'Agent offline' })
    );

    render(<DiscoveryPage />);
    await screen.findAllByText('HQ sweep');

    fireEvent.click(desktop().getByLabelText('Run HQ sweep'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith({
        message: 'Agent offline',
        type: 'error'
      });
    });
    expect(screen.queryByTestId('jobs-filter')).not.toBeInTheDocument();
    await waitFor(() => expect(desktop().getByLabelText('Run HQ sweep')).not.toBeDisabled());
  });

  it('redirects to login on 401 without showing an inline error or switching tabs', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(profilesPayload));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'Unauthorized' }, false, 401)
    );

    render(<DiscoveryPage />);
    await screen.findAllByText('HQ sweep');

    fireEvent.click(desktop().getByLabelText('Run HQ sweep'));

    await waitFor(() => {
      expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true });
    });

    // 401 is handled by the redirect: no error toast, no inline banner, no tab switch.
    expect(showToastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
    expect(screen.queryByText('Unauthorized')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jobs-filter')).not.toBeInTheDocument();

    // Spinner still cleared on the early-return path (finally ran).
    await waitFor(() => expect(desktop().getByLabelText('Run HQ sweep')).not.toBeDisabled());
  });

  describe('All-Orgs mode (explicit allOrgs scope, currentOrgId === null)', () => {
    beforeEach(() => {
      // Explicit All-Orgs scope: allOrgs flag set, not a transient hydration null.
      orgStoreState.currentOrgId = null;
      orgStoreState.allOrgs = true;
    });

    it('renders the select-an-organization prompt and does not fire org-scoped requests', async () => {
      window.history.pushState({}, '', '/discovery#assets');
      fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

      render(<DiscoveryPage />);

      // Prompt is shown instead of an error state.
      expect(
        await screen.findByTestId('org-required-state')
      ).toBeInTheDocument();

      // No tab content is rendered (none of the org-scoped tabs mount).
      expect(screen.queryByText('Assets tab')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Topology' })).not.toBeInTheDocument();

      // Crucially, the page never fires the org-scoped request that would 400.
      expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/discovery/profiles');
    });

    it('does not fire the org-scoped asset-detail fetch for an ?asset= deep link', async () => {
      // The `?asset=<id>` deep link sets topologyAssetId, which would otherwise
      // fetch the org-scoped /discovery/assets/<id> endpoint and 400 in All-Orgs
      // mode. The guard must suppress it.
      window.history.pushState({}, '', '/discovery?asset=asset-9#assets');
      fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

      render(<DiscoveryPage />);

      await screen.findByTestId('org-required-state');
      expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/discovery/assets/asset-9');
    });

    it('hides the New Profile action while in All-Orgs mode', async () => {
      window.history.pushState({}, '', '/discovery#profiles');
      fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

      render(<DiscoveryPage />);

      await screen.findByTestId('org-required-state');
      expect(screen.queryByRole('button', { name: /New Profile/ })).not.toBeInTheDocument();
    });

    it('restores normal behavior and fetches profiles when a single org is selected', async () => {
      window.history.pushState({}, '', '/discovery#profiles');
      fetchWithAuthMock.mockResolvedValue(makeJsonResponse(profilesPayload));

      const { rerender } = render(<DiscoveryPage />);

      // Starts on the prompt, no profiles request.
      await screen.findByTestId('org-required-state');
      expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/discovery/profiles');

      // User picks a concrete org via the switcher -> store updates, re-render.
      orgStoreState.currentOrgId = 'org-1';
      orgStoreState.allOrgs = false;
      rerender(<DiscoveryPage />);

      // Prompt is gone, the profiles tab mounts, and the org-scoped fetch fires.
      // 'HQ sweep' renders in BOTH the desktop table and the mobile cards
      // (ResponsiveTable, #1760), so wait for the async render then scope the
      // assertion to the desktop table — matches the sibling tests in this file
      // which use findAllByText + desktop(). A bare findByText sees 2 matches.
      await screen.findAllByText('HQ sweep');
      expect(desktop().getByText('HQ sweep')).toBeInTheDocument();
      expect(
        screen.queryByTestId('org-required-state')
      ).not.toBeInTheDocument();
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/discovery/profiles');
    });
  });

  it('renders neither the prompt nor the tab content on a transient pre-hydration null org', () => {
    // Before the persisted context rehydrates / the first org auto-selects,
    // currentOrgId is null and allOrgs is false. Single-org users must NOT see
    // the "select an organization" prompt in this window — and the tab content
    // must not mount either, since child components (assets list) would fire
    // org-less fetches that 400 before the context resolves.
    orgStoreState.currentOrgId = null;
    orgStoreState.allOrgs = false;
    window.history.pushState({}, '', '/discovery#assets');
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [] }));

    render(<DiscoveryPage />);

    expect(screen.queryByTestId('org-required-state')).not.toBeInTheDocument();
    expect(screen.queryByText('Assets tab')).not.toBeInTheDocument();
  });
});
import '@/lib/i18n';
