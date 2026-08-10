import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CisBaselinesTab from './CisBaselinesTab';
import { fetchWithAuth } from '../../stores/auth';
import type { Baseline } from './types';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

// runAction's feedback channel. Same resolved module the component's
// runAction import pulls in, so this captures the real toast calls.
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const orgStoreState: {
  currentOrgId: string | null;
  organizations: unknown[];
  organizationsLoaded: boolean;
  allOrgs: boolean;
  error: string | null;
} = {
  currentOrgId: 'org-1',
  organizations: [{ id: 'org-1', name: 'Acme' }],
  organizationsLoaded: true,
  allOrgs: false,
  error: null
};

// useOrgScope imports the same module, so this mock covers the create gate too.
// Note it exposes no `.getState()`, so the non-hook `getOrgScope()` variant is
// NOT covered — move an org read into an event handler and this will throw.
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector?: (s: typeof orgStoreState) => unknown) =>
    selector ? selector(orgStoreState) : orgStoreState
}));

vi.mock('./CisBaselineForm', () => ({
  default: () => null
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function listUrl(): string {
  const [url] = fetchWithAuthMock.mock.calls[0] as [string];
  return url;
}

const TWO_ORGS = [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Globex' }];

const baseline: Baseline = {
  id: 'baseline-1',
  orgId: 'org-1',
  name: 'CIS Windows L1',
  osType: 'windows',
  level: 'l1',
  benchmarkVersion: '3.0.0',
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
};

/** Lists one active baseline, then answers POST /cis/scan with `scan`
 *  (the route's real success is a 202 with no row-visible effect). */
function mockScanFlow(scan: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 202,
  body: { message: 'CIS scan queued', jobId: 'job-1', baselineId: 'baseline-1' }
}): void {
  fetchWithAuthMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.startsWith('/cis/scan')
        ? ({ ok: scan.ok, status: scan.status, json: async () => scan.body } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({ data: [baseline] }) } as unknown as Response)
    )
  );
}

describe('CisBaselinesTab org scoping', () => {
  beforeEach(() => {
    orgStoreState.currentOrgId = 'org-1';
    orgStoreState.allOrgs = false;
    orgStoreState.organizations = [{ id: 'org-1', name: 'Acme' }];
    orgStoreState.organizationsLoaded = true;
    showToast.mockClear();
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] })
    } as unknown as Response);
  });

  it('scopes the baseline list to the selected org', async () => {
    render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(new URL(listUrl(), 'http://x').searchParams.get('orgId')).toBe('org-1');
  });

  it('refetches when the org selection changes', async () => {
    const { rerender } = render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    orgStoreState.currentOrgId = 'org-2';
    rerender(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const [url] = fetchWithAuthMock.mock.calls[1] as [string];
    expect(new URL(url, 'http://x').searchParams.get('orgId')).toBe('org-2');
  });

  // The aborted request's `finally` still runs. If it cleared the loading flag,
  // the table would render "No baselines configured." over a pending load —
  // telling a user with data that they have none, until the refetch lands.
  it('keeps the spinner up when a superseded request aborts', async () => {
    // Honour the abort signal the way real fetch does. A mock that resolves
    // regardless never reaches the AbortError branch, so the test would pass
    // against the bug it is meant to catch.
    fetchWithAuthMock.mockImplementation((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      })
    );

    const { rerender } = render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    // Switching org aborts request #1 and issues #2, which never settles — so
    // the window where #1's `finally` could wrongly clear the flag stays open.
    orgStoreState.currentOrgId = 'org-2';
    rerender(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));

    // Let #1's rejection run its catch/finally and React flush any state it set.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(screen.queryByText('No baselines configured.')).not.toBeInTheDocument();
    expect(screen.getByText('Loading baselines...')).toBeInTheDocument();
  });

  // Negative control for the test above: pins the refetch to the org CHANGING,
  // rather than leaning on the call count to catch an over-firing effect.
  it('does not refetch when re-rendered with the same org', async () => {
    const { rerender } = render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    rerender(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
  });

  // `orgId=` (empty) fails the API's z.string().guid() and 400s the whole list,
  // so the param must be absent rather than blank when there is no org.
  it('omits orgId entirely in fleet view rather than sending a blank one', async () => {
    orgStoreState.currentOrgId = null;
    orgStoreState.allOrgs = true;
    orgStoreState.organizations = TWO_ORGS;

    render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(new URL(listUrl(), 'http://x').searchParams.has('orgId')).toBe(false);
  });

  it('enables New Baseline when one org is in context', async () => {
    render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /new baseline/i })).toBeEnabled();
  });

  // A partner with a real choice to make has to make it — the baseline's owner
  // must not be a surprise.
  it('disables New Baseline in fleet view for a multi-org partner', async () => {
    orgStoreState.currentOrgId = null;
    orgStoreState.allOrgs = true;
    orgStoreState.organizations = TWO_ORGS;

    render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /new baseline/i })).toBeDisabled();
  });

  // But a single-org partner in fleet view has no ambiguity — the API resolves
  // their one org server-side, so gating them out would block a create the
  // server would have accepted.
  it('keeps New Baseline enabled in fleet view for a single-org partner', async () => {
    orgStoreState.currentOrgId = null;
    orgStoreState.allOrgs = true;
    orgStoreState.organizations = [{ id: 'org-1', name: 'Acme' }];

    render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /new baseline/i })).toBeEnabled();
  });

  // The org context is not resolved on the first frame of a cold session.
  // Disabled is right, but "Select an organization" is not actionable yet.
  // Queuing a scan changes nothing on this row — the results land minutes later
  // on the Compliance tab — so without a toast the spinner stopping is the only
  // signal, and it looks exactly like a no-op.
  it('toasts a confirmation when a scan is queued', async () => {
    mockScanFlow();

    render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('CIS Windows L1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /trigger scan/i }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringContaining('CIS Windows L1') })
      )
    );
  });

  // Negative control: the confirmation must be tied to the response, not fired
  // optimistically on click.
  it('does not claim success when the scan request fails', async () => {
    mockScanFlow({ ok: false, status: 400, body: { error: 'Baseline is inactive' } });

    render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('CIS Windows L1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /trigger scan/i }));

    await waitFor(() => expect(screen.getByText('Baseline is inactive')).toBeInTheDocument());
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('disables New Baseline without an org-required hint while context loads', async () => {
    orgStoreState.currentOrgId = null;
    orgStoreState.allOrgs = false;
    orgStoreState.organizationsLoaded = false;
    orgStoreState.organizations = [];

    render(<CisBaselinesTab refreshKey={0} onMutate={vi.fn()} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const button = screen.getByRole('button', { name: /new baseline/i });
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute('title');
  });
});
