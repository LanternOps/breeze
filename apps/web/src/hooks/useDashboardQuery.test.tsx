import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDashboardQuery, type DashboardQueryState } from './useDashboardQuery';
import { fetchWithAuth } from '../stores/auth';

// The global Current/All-orgs pill is modeled by currentOrgId: a concrete id
// means "this org", and null means the explicit All-orgs scope (see orgStore).
let mockOrgState: { currentOrgId: string | null };

vi.mock('../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: typeof mockOrgState) => unknown) =>
      selector ? selector(mockOrgState) : mockOrgState,
    { getState: () => mockOrgState },
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as Response;

let lastState: DashboardQueryState<number> | null = null;

function Probe({ token }: { token: number }) {
  lastState = useDashboardQuery<number>('/devices/stats', token, (j: any) => j.data.total);
  return null;
}

beforeEach(() => {
  mockOrgState = { currentOrgId: 'org-1' };
  lastState = null;
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue(jsonResponse({ data: { total: 7 } }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDashboardQuery', () => {
  it('fetches once and exposes the selected data', async () => {
    render(<Probe token={0} />);

    await waitFor(() => expect(lastState?.data).toBe(7));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenLastCalledWith('/devices/stats');
    expect(lastState?.isLoading).toBe(false);
    expect(lastState?.unavailable).toBe(false);
  });

  it('refetches when the org scope flips Current -> All orgs', async () => {
    const { rerender } = render(<Probe token={0} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    mockOrgState.currentOrgId = null;
    rerender(<Probe token={0} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
  });

  it('refetches when the refresh token bumps, not on unrelated re-renders', async () => {
    const { rerender } = render(<Probe token={0} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    rerender(<Probe token={0} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);

    rerender(<Probe token={1} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
  });

  it('marks 403 responses unavailable instead of erroring', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));
    render(<Probe token={0} />);

    await waitFor(() => expect(lastState?.unavailable).toBe(true));
    expect(lastState?.error).toBeNull();
    expect(lastState?.data).toBeNull();
    expect(lastState?.isLoading).toBe(false);
  });

  it('discards a slow stale-scope response that resolves after a newer one', async () => {
    // org-1's response is deliberately slow; org-2's is instant. If the
    // sequence guard is removed, org-1's data (7) overwrites org-2's (99)
    // after the scope change — the cross-org data flash this test pins.
    let resolveSlow!: (r: Response) => void;
    const slow = new Promise<Response>((r) => (resolveSlow = r));
    fetchWithAuthMock.mockReturnValueOnce(slow as any);
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: { total: 99 } }));

    const { rerender } = render(<Probe token={0} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    mockOrgState.currentOrgId = 'org-2';
    rerender(<Probe token={0} />);
    await waitFor(() => expect(lastState?.data).toBe(99));

    await act(async () => {
      resolveSlow(jsonResponse({ data: { total: 7 } }));
      await Promise.resolve();
    });

    expect(lastState?.data).toBe(99);
  });

  it('keeps stale data visible when a background poll fails', async () => {
    const { rerender } = render(<Probe token={0} />);
    await waitFor(() => expect(lastState?.data).toBe(7));

    fetchWithAuthMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    await act(async () => {
      rerender(<Probe token={1} />);
    });

    await waitFor(() => expect(lastState?.error).not.toBeNull());
    expect(lastState?.data).toBe(7);
  });
});

// `staleScope` exists so a widget that draws a conclusion from ANOTHER
// widget's data (fleetPresence, #3613) can tell "the count I'm holding
// belongs to the org you just switched away from" apart from "the count is
// current". Widgets rendering their own numbers keep ignoring it.
describe('useDashboardQuery staleScope', () => {
  it('stays false through a settled load and a same-scope refresh poll', async () => {
    const { rerender } = render(<Probe token={0} />);
    await waitFor(() => expect(lastState?.data).toBe(7));
    expect(lastState?.staleScope).toBe(false);

    rerender(<Probe token={1} />);
    expect(lastState?.staleScope).toBe(false);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    expect(lastState?.staleScope).toBe(false);
  });

  it('flags the cached value while an org switch is in flight, and clears it on arrival', async () => {
    const { rerender } = render(<Probe token={0} />);
    await waitFor(() => expect(lastState?.data).toBe(7));

    // org-2's response is held open: the old org's count is still on screen.
    let resolvePending!: (r: Response) => void;
    fetchWithAuthMock.mockReturnValueOnce(
      new Promise<Response>((r) => (resolvePending = r)) as any
    );
    mockOrgState.currentOrgId = 'org-2';
    rerender(<Probe token={0} />);

    expect(lastState?.data).toBe(7);
    expect(lastState?.staleScope).toBe(true);

    await act(async () => {
      resolvePending(jsonResponse({ data: { total: 0 } }));
      await Promise.resolve();
    });
    await waitFor(() => expect(lastState?.data).toBe(0));
    expect(lastState?.staleScope).toBe(false);
  });

  it('keeps the flag set when the post-switch refetch fails', async () => {
    const { rerender } = render(<Probe token={0} />);
    await waitFor(() => expect(lastState?.data).toBe(7));

    fetchWithAuthMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    mockOrgState.currentOrgId = 'org-2';
    await act(async () => {
      rerender(<Probe token={0} />);
    });

    await waitFor(() => expect(lastState?.error).not.toBeNull());
    // Stale data survives the failure (deliberate) but must stay untrusted —
    // a failed refetch does not make old-scope data current.
    expect(lastState?.data).toBe(7);
    expect(lastState?.staleScope).toBe(true);
  });

  it('clears the flag when the post-switch request is permission-hidden', async () => {
    const { rerender } = render(<Probe token={0} />);
    await waitFor(() => expect(lastState?.data).toBe(7));

    fetchWithAuthMock.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));
    mockOrgState.currentOrgId = 'org-2';
    await act(async () => {
      rerender(<Probe token={0} />);
    });

    await waitFor(() => expect(lastState?.unavailable).toBe(true));
    // A 403 clears `data` outright, so no stale value is left to flag.
    expect(lastState?.data).toBeNull();
    expect(lastState?.staleScope).toBe(false);
  });
});
