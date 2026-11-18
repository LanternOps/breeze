import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #9605: pending CIS remediations had no approve/reject control anywhere in the UI.

const fetchWithAuth = vi.hoisted(() => vi.fn());
const currentUser = vi.hoisted(() => ({ id: 'user-checker' }));
vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: typeof currentUser }) => unknown) => selector({ user: currentUser }),
  registerOrgIdProvider: vi.fn(),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

const granted = vi.hoisted(() => new Set<string>(['devices:read', 'devices:execute']));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => granted.has(`${r}:${a}`) }),
}));

import CisRemediationsTab from './CisRemediationsTab';

const PENDING = {
  id: '11111111-1111-4111-8111-111111111111',
  checkId: '1.1.1',
  deviceId: 'dev-1',
  baselineId: null,
  action: 'apply',
  status: 'pending_approval',
  approvalStatus: 'pending',
  requestedBy: 'user-maker',
  createdAt: '2026-10-01T00:00:00.000Z',
  executedAt: null,
  deviceHostname: 'host-pending',
  baselineName: null,
};
const OWN_PENDING = {
  ...PENDING,
  id: '22222222-2222-4222-8222-222222222222',
  checkId: '2.2.2',
  deviceHostname: 'host-own',
  requestedBy: 'user-checker',
};
const QUEUED = {
  ...PENDING,
  id: '33333333-3333-4333-8333-333333333333',
  checkId: '3.3.3',
  status: 'queued',
  approvalStatus: 'approved',
  deviceHostname: 'host-queued',
};

function json(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'X',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function mockApi(approveResponse: () => Response = () => json({ approved: true, queued: 1, actionIds: [PENDING.id], skippedIds: [] })) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith('/cis/remediate/approve') && init?.method === 'POST') return Promise.resolve(approveResponse());
    if (url.startsWith('/cis/remediations')) return Promise.resolve(json({ data: [PENDING, OWN_PENDING, QUEUED] }));
    return Promise.resolve(json({}));
  });
}

function approveCalls() {
  return fetchWithAuth.mock.calls.filter(([url, init]) => String(url).startsWith('/cis/remediate/approve') && (init as RequestInit)?.method === 'POST');
}

function row(hostname: string) {
  return screen.getByText(hostname).closest('tr') as HTMLElement;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
  granted.clear();
  granted.add('devices:read');
  granted.add('devices:execute');
});

describe('CisRemediationsTab approve/reject (#9605)', () => {
  it('shows Approve and Reject only on pending_approval rows', async () => {
    mockApi();
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-pending');

    expect(within(row('host-pending')).getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(within(row('host-pending')).getByRole('button', { name: /reject/i })).toBeInTheDocument();
    expect(within(row('host-queued')).queryByRole('button', { name: /approve/i })).toBeNull();
    expect(within(row('host-queued')).queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('hides the actions from a user without devices:execute', async () => {
    granted.delete('devices:execute');
    mockApi();
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-pending');

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('disables Approve on the caller\'s own request (maker/checker) but still allows Reject', async () => {
    mockApi();
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-own');

    expect(within(row('host-own')).getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(within(row('host-own')).getByRole('button', { name: /reject/i })).toBeEnabled();
  });

  it('approves through POST /cis/remediate/approve after confirmation, with the note, and refetches', async () => {
    const onMutate = vi.fn();
    mockApi();
    render(<CisRemediationsTab refreshKey={0} onMutate={onMutate} />);
    await screen.findByText('host-pending');

    fireEvent.click(within(row('host-pending')).getByRole('button', { name: /approve/i }));
    expect(approveCalls()).toHaveLength(0);

    fireEvent.change(await screen.findByTestId('cis-remediation-decision-note'), { target: { value: 'ok by me' } });
    fireEvent.click(screen.getByTestId('cis-remediation-decision-confirm'));

    await waitFor(() => expect(approveCalls()).toHaveLength(1));
    const [, init] = approveCalls()[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      actionIds: [PENDING.id],
      approved: true,
      note: 'ok by me',
    });
    await waitFor(() => expect(onMutate).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: expect.stringMatching(/1\.1\.1.*approved/i) }),
    );
    await waitFor(() => expect(screen.queryByTestId('cis-remediation-decision-confirm')).toBeNull());
  });

  it('refetches the table itself when no onMutate is wired', async () => {
    mockApi();
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-pending');
    const listCalls = () => fetchWithAuth.mock.calls.filter(([url]) => String(url).startsWith('/cis/remediations')).length;
    const before = listCalls();

    fireEvent.click(within(row('host-pending')).getByRole('button', { name: /approve/i }));
    fireEvent.click(await screen.findByTestId('cis-remediation-decision-confirm'));

    await waitFor(() => expect(listCalls()).toBe(before + 1));
  });

  it('keeps the dialog and note open after a server error so the user can retry', async () => {
    mockApi(() => json({ error: 'Failed to queue remediation actions, approval rolled back' }, 500));
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-pending');

    fireEvent.click(within(row('host-pending')).getByRole('button', { name: /approve/i }));
    fireEvent.change(await screen.findByTestId('cis-remediation-decision-note'), { target: { value: 'retry me' } });
    fireEvent.click(screen.getByTestId('cis-remediation-decision-confirm'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/rolled back/) })),
    );
    expect(screen.getByTestId('cis-remediation-decision-note')).toHaveValue('retry me');
  });

  it('closes the dialog when the row was already decided elsewhere (non-retryable 400)', async () => {
    mockApi(() => json({ error: 'No pending remediation actions eligible for approval update', skippedIds: [PENDING.id] }, 400));
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-pending');

    fireEvent.click(within(row('host-pending')).getByRole('button', { name: /approve/i }));
    fireEvent.click(await screen.findByTestId('cis-remediation-decision-confirm'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(screen.queryByTestId('cis-remediation-decision-confirm')).toBeNull());
  });

  it('rejects with approved:false and omits an empty note', async () => {
    mockApi(() => json({ approved: false, rejected: 1, actionIds: [OWN_PENDING.id], skippedIds: [] }));
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-own');

    fireEvent.click(within(row('host-own')).getByRole('button', { name: /reject/i }));
    fireEvent.click(await screen.findByTestId('cis-remediation-decision-confirm'));

    await waitFor(() => expect(approveCalls()).toHaveLength(1));
    const [, init] = approveCalls()[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      actionIds: [OWN_PENDING.id],
      approved: false,
    });
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringMatching(/2\.2\.2.*rejected/i) }),
      ),
    );
  });

  it('surfaces the MFA requirement instead of a generic failure', async () => {
    mockApi(() => json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403));
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-pending');

    fireEvent.click(within(row('host-pending')).getByRole('button', { name: /approve/i }));
    fireEvent.click(await screen.findByTestId('cis-remediation-decision-confirm'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringMatching(/multi-factor/i) }),
      ),
    );
    // Retryable once the user signs in with MFA: the dialog stays open.
    expect(screen.getByTestId('cis-remediation-decision-confirm')).toBeInTheDocument();
  });

  it('warns when the approval was accepted but the action could not be queued', async () => {
    mockApi(() => json({ approved: true, queued: 0, actionIds: [], skippedIds: [], failedActionIds: [PENDING.id] }));
    render(<CisRemediationsTab refreshKey={0} />);
    await screen.findByText('host-pending');

    fireEvent.click(within(row('host-pending')).getByRole('button', { name: /approve/i }));
    fireEvent.click(await screen.findByTestId('cis-remediation-decision-confirm'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});
