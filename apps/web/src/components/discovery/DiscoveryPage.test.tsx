import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DiscoveryPage from './DiscoveryPage';
import { fetchWithAuth } from '../../stores/auth';
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
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [{
          id: 'profile-1',
          name: 'HQ sweep',
          siteId: 'site-1',
          subnets: ['10.0.0.0/24'],
          methods: ['icmp'],
          schedule: { type: 'manual' },
          lastRunAt: null
        }]
      })
    );

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
});
