import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MonitoringIntegration from './MonitoringIntegration';
import { fetchWithAuth } from '../../stores/auth';

// All-orgs scope is modeled by currentOrgId === null (see orgStore): monitoring
// settings are per-org, so there is no single org to load under All orgs.
let mockOrgState: { currentOrgId: string | null };

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: typeof mockOrgState) => unknown) =>
      selector ? selector(mockOrgState) : mockOrgState,
    { getState: () => mockOrgState },
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const monitoringResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }) as unknown as Response;

beforeEach(() => {
  mockOrgState = { currentOrgId: 'org-1' };
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue(monitoringResponse());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('MonitoringIntegration — per-org page under All-orgs scope', () => {
  it('shows the switch-to-a-single-org prompt and fires no doomed request under All orgs', async () => {
    mockOrgState.currentOrgId = null;
    render(<MonitoringIntegration />);

    expect(
      screen.getByText(/configured per organization/i),
    ).toBeInTheDocument();

    // The whole point of the skip-and-prompt shape: never call the API that
    // would 400 without a single org in context.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('loads settings normally when scoped to a single org', async () => {
    mockOrgState.currentOrgId = 'org-1';
    render(<MonitoringIntegration />);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/integrations/monitoring'),
    );
    expect(
      screen.queryByText(/configured per organization/i),
    ).not.toBeInTheDocument();
  });

  it('starts fetching after flipping back from All orgs to a single org', async () => {
    mockOrgState.currentOrgId = null;
    const { rerender } = render(<MonitoringIntegration />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).not.toHaveBeenCalled();

    mockOrgState.currentOrgId = 'org-1';
    rerender(<MonitoringIntegration />);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/integrations/monitoring'),
    );
  });
});
