import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DiscoveryPage from './DiscoveryPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: () => ({
    currentOrgId: 'org-1',
    currentSiteId: 'site-1',
    sites: []
  })
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
    window.history.pushState({}, '', '/discovery?tab=profiles');
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

    await screen.findByText('HQ sweep');

    fireEvent.click(screen.getByLabelText('Run HQ sweep'));

    expect(screen.getByLabelText('Running HQ sweep')).toBeDisabled();
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
    await screen.findByText('HQ sweep');

    fireEvent.click(screen.getByLabelText('Run HQ sweep'));

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
    const runButton = await screen.findByLabelText('Run HQ sweep');
    expect(runButton).not.toBeDisabled();

    // A failed queue must NOT navigate the user to an empty jobs view.
    expect(screen.queryByTestId('jobs-filter')).not.toBeInTheDocument();
  });

  it('treats an HTTP-200 {success:false} body as a failure', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(profilesPayload));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ success: false, error: 'Agent offline' })
    );

    render(<DiscoveryPage />);
    await screen.findByText('HQ sweep');

    fireEvent.click(screen.getByLabelText('Run HQ sweep'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith({
        message: 'Agent offline',
        type: 'error'
      });
    });
    expect(screen.queryByTestId('jobs-filter')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Run HQ sweep')).not.toBeDisabled();
  });

  it('redirects to login on 401 without showing an inline error or switching tabs', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse(profilesPayload));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'Unauthorized' }, false, 401)
    );

    render(<DiscoveryPage />);
    await screen.findByText('HQ sweep');

    fireEvent.click(screen.getByLabelText('Run HQ sweep'));

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
    expect(await screen.findByLabelText('Run HQ sweep')).not.toBeDisabled();
  });
});
