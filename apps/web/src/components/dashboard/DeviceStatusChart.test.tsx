import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceStatusChart from './DeviceStatusChart';
import { fetchWithAuth } from '../../stores/auth';

// The global Current/All-orgs pill is modeled by currentOrgId: a concrete id
// means "this org", and null means the explicit All-orgs scope (see orgStore).
let mockOrgState: { currentOrgId: string | null };

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  // Selector-aware mock: the component calls useOrgStore((s) => s.currentOrgId).
  useOrgStore: Object.assign(
    (selector?: (s: typeof mockOrgState) => unknown) =>
      selector ? selector(mockOrgState) : mockOrgState,
    { getState: () => mockOrgState },
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const devicesResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      devices: [
        { id: 'd1', name: 'alpha', status: 'online' },
        { id: 'd2', name: 'bravo', status: 'offline' },
      ],
    }),
  }) as unknown as Response;

beforeEach(() => {
  mockOrgState = { currentOrgId: 'org-1' };
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue(devicesResponse());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DeviceStatusChart — honors the global org-scope toggle', () => {
  it('refetches /devices when the scope flips Current -> All orgs', async () => {
    const { rerender } = render(<DeviceStatusChart />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(fetchWithAuthMock).toHaveBeenLastCalledWith('/devices');

    // Flipping the top-bar pill to All orgs clears currentOrgId to null. The
    // fetch effect depends on currentOrgId, so it must refire — guarding the
    // regression where the widget kept showing the previously-scoped fleet.
    mockOrgState.currentOrgId = null;
    rerender(<DeviceStatusChart />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
  });

  it('refetches when the selected org changes within Current scope', async () => {
    const { rerender } = render(<DeviceStatusChart />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    mockOrgState.currentOrgId = 'org-2';
    rerender(<DeviceStatusChart />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
  });

  it('does not refetch on an unrelated re-render (deps unchanged)', async () => {
    const { rerender } = render(<DeviceStatusChart />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    rerender(<DeviceStatusChart />);
    // Give any erroneous effect a chance to fire before asserting stability.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});
