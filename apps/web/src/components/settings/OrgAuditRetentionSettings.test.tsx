import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgAuditRetentionSettings from './OrgAuditRetentionSettings';
import { fetchWithAuth } from '../../stores/auth';

const mocks = vi.hoisted(() => ({ can: vi.fn() }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: mocks.can }) }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '7c0a1f7e-3333-4555-9666-777788889999';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockApi(policy: unknown) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `/orgs/organizations/${ORG_ID}/audit-retention` && !init?.method) {
      return makeJsonResponse({ data: policy });
    }
    if (url === `/orgs/organizations/${ORG_ID}/audit-retention` && init?.method === 'PUT') {
      return makeJsonResponse({ data: policy });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('OrgAuditRetentionSettings', () => {
  const onDirty = vi.fn();
  const onSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockReturnValue(true);
  });

  it('loads and renders the fetched retention days', async () => {
    mockApi({ orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-settings')).toBeInTheDocument());
    expect((screen.getByTestId('org-audit-retention-days') as HTMLInputElement).value).toBe('90');
    expect(screen.queryByTestId('org-audit-retention-unconfigured')).toBeNull();
  });

  it('shows the unconfigured warning when no policy row exists yet', async () => {
    mockApi({ orgId: ORG_ID, configured: false, retentionDays: 365, lastCleanupAt: null });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-unconfigured')).toBeInTheDocument());
    // The default retentionDays is still pre-populated as the starting point for Save
    expect((screen.getByTestId('org-audit-retention-days') as HTMLInputElement).value).toBe('365');
  });

  it('shows a locale-formatted last cleanup timestamp when present', async () => {
    mockApi({ orgId: ORG_ID, configured: true, retentionDays: 30, lastCleanupAt: '2026-09-01T03:30:00.000Z' });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    // Formatted via formatDateTime (locale-aware), not the raw ISO string —
    // just assert the year shows up somewhere in a rendered date.
    await waitFor(() => expect(screen.getByText(/2026/)).toBeInTheDocument());
    expect(screen.queryByText('2026-09-01T03:30:00.000Z')).toBeNull();
  });

  it('saves the entered retentionDays as a number and fires onSave', async () => {
    mockApi({ orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-save')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('org-audit-retention-days'), { target: { value: '180' } });
    fireEvent.click(screen.getByTestId('org-audit-retention-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse(String(putCall![1]!.body));
    expect(body).toEqual({ retentionDays: 180 });
  });

  it('rejects an out-of-range value client-side without calling the API', async () => {
    mockApi({ orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-save')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('org-audit-retention-days'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('org-audit-retention-save'));

    await waitFor(() => expect(screen.getByTestId('org-audit-retention-issue')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('disables the input and hides Save when the caller lacks audit:manage', async () => {
    mocks.can.mockReturnValue(false);
    mockApi({ orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-days')).toBeInTheDocument());
    expect((screen.getByTestId('org-audit-retention-days') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('org-audit-retention-save')).toBeNull();
  });

  it('shows an error state with retry when the load fails', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-load-error')).toBeInTheDocument());
  });

  it('does not call onSave when the PUT fails (runAction toasts the error)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') return makeJsonResponse({ error: 'nope' }, false, 500);
      return makeJsonResponse({ data: { orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null } });
    });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-save')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-audit-retention-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('redirects to /login on 401 during load', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({}, false, 401));
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
  });

  it('marks dirty when the retention days field changes', async () => {
    mockApi({ orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-days')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('org-audit-retention-days'), { target: { value: '120' } });
    expect(onDirty).toHaveBeenCalled();
  });

  it('save button is disabled while saving', async () => {
    let resolvePut!: (r: Response) => void;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') {
        return new Promise<Response>(resolve => { resolvePut = resolve; });
      }
      return makeJsonResponse({ data: { orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null } });
    });
    render(<OrgAuditRetentionSettings orgId={ORG_ID} onDirty={onDirty} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('org-audit-retention-save')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-audit-retention-save'));
    await waitFor(() => expect((screen.getByTestId('org-audit-retention-save') as HTMLButtonElement).disabled).toBe(true));

    resolvePut(makeJsonResponse({ data: { orgId: ORG_ID, configured: true, retentionDays: 90, lastCleanupAt: null } }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
  });
});
