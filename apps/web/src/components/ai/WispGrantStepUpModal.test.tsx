import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  mintStepUpGrant: vi.fn(),
  showToast: vi.fn(),
  claims: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } } as Record<string, unknown>,
}));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/lib/mfaStepUp', () => ({
  mintStepUpGrant: h.mintStepUpGrant,
  StepUpMintError: class StepUpMintError extends Error {},
}));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.showToast }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => h.claims }));

import WispGrantStepUpModal from './WispGrantStepUpModal';

const HASH = 'a'.repeat(64);
const res = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const grantDto = (orgId: string | null) => ({
  id: 'g-1', partnerId: 'p-1', orgId, grantorUserId: 'u-1', grantee: 'wisp', currentRevisionId: 'r-1',
  status: 'active', pausedReason: null, expiresAt: '2027-01-01T00:00:00.000Z', budgetCentsPerDay: 200, floorTickMinutes: 30,
});
const threadBody = (orgId: string | null) => ({
  data: {
    thread: { id: 't-1', grantId: 'g-1', partnerId: 'p-1', summary: 'Last time: patched.', focusOrgId: null },
    focusOrgName: null,
    grant: { id: 'g-1', status: 'active', orgId, expiresAt: '2027-01-01T00:00:00.000Z', currentRevisionId: 'r-1', budgetCentsPerDay: 200, floorTickMinutes: 30, spentTodayCents: 12 },
    wideningAvailable: true,
  },
});

type Route = (url: string, init?: RequestInit) => Response | undefined;
function routes(extra: Route = () => undefined) {
  h.fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const hit = extra(url, init);
    if (hit) return hit;
    if (url === '/users/me') return res({ mfaMethod: 'totp' });
    if (url === '/auth/passkeys') return res([]);
    if (url.startsWith('/wisp/grants/preview')) return res({ scope: {}, ceilingSnapshot: {}, ceilingHash: HASH });
    if (url === '/wisp/grants' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return res(grantDto(body.orgId), 201);
    }
    if (url.startsWith('/wisp/thread')) return res(threadBody(url.includes('orgId=') ? 'org-1' : null));
    return res({}, 404);
  });
}

const calls = (prefix: string) => h.fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith(prefix));

async function confirmWithCode() {
  const code = await screen.findByTestId('wisp-stepup-code');
  fireEvent.change(code, { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('wisp-grant-confirm'));
}

describe('WispGrantStepUpModal (W04 Task 7, w00 A4 handshake)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.claims = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } };
    h.mintStepUpGrant.mockResolvedValue('su-1');
    routes();
  });

  it('submit fetches /wisp/grants/preview?orgId= first, then mints a wisp_grant step-up with resource { partnerId, orgId, requestedCeilingHash: ceilingHash }, then posts /wisp/grants { orgId, stepUpGrantId }', async () => {
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    await confirmWithCode();
    await waitFor(() => expect(onGranted).toHaveBeenCalled());

    const order = h.fetchWithAuth.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/wisp/'));
    expect(order.slice(0, 2)).toEqual(['/wisp/grants/preview?orgId=org-1', '/wisp/grants']);
    expect(h.mintStepUpGrant).toHaveBeenCalledWith({
      operation: 'wisp_grant',
      resource: { partnerId: 'p-1', orgId: 'org-1', requestedCeilingHash: HASH },
      reauth: { method: 'totp', code: '123456' },
    });
    const post = calls('/wisp/grants').find(([u, i]) => u === '/wisp/grants' && (i as RequestInit)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ orgId: 'org-1', stepUpGrantId: 'su-1' });
  });

  it('then fetches /wisp/thread?orgId= and calls onGranted with grant + thread', async () => {
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    await confirmWithCode();
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread?orgId=org-1');
    expect(onGranted).toHaveBeenCalledWith({
      grantId: 'g-1', threadId: 't-1', scopeOrgId: 'org-1', focusOrgId: null, focusOrgName: null, status: 'active',
      expiresAt: '2027-01-01T00:00:00.000Z', summary: 'Last time: patched.', budgetCentsPerDay: 200, floorTickMinutes: 30,
      wideningAvailable: true,
    });
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Wisp is on' }));
  });

  it('a 403 STEP_UP_REQUIRED on the POST re-runs preview + mint once, then shows wisp.modal.stepUpUnavailable', async () => {
    routes((url, init) =>
      url === '/wisp/grants' && init?.method === 'POST' ? res({ error: 'stale proof', code: 'STEP_UP_REQUIRED' }, 403) : undefined,
    );
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    await confirmWithCode();
    expect(await screen.findByText('Could not verify your factor. Try again.')).toBeInTheDocument();
    expect(calls('/wisp/grants/preview')).toHaveLength(2);
    expect(h.mintStepUpGrant).toHaveBeenCalledTimes(2);
    expect(onGranted).not.toHaveBeenCalled();
    // The expected re-mint path is not an error toast.
    expect(h.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('a 403 STEP_UP_REQUIRED followed by success grants on the second attempt', async () => {
    let posts = 0;
    routes((url, init) => {
      if (url === '/wisp/grants' && init?.method === 'POST' && ++posts === 1) return res({ error: 'stale', code: 'STEP_UP_REQUIRED' }, 403);
      return undefined;
    });
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    await confirmWithCode();
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(h.mintStepUpGrant).toHaveBeenCalledTimes(2);
  });

  it('hides the "All organizations" option for an org-scoped token', async () => {
    h.claims = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: 'org-1' } };
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
    expect(await screen.findByTestId('wisp-scope-org')).toBeInTheDocument();
    expect(screen.queryByTestId('wisp-scope-partner')).toBeNull();
  });

  it('"All organizations" previews and grants partner-wide (orgId null) and reads the thread without an org', async () => {
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    fireEvent.click(await screen.findByTestId('wisp-scope-partner'));
    await confirmWithCode();
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(calls('/wisp/grants/preview')[0]![0]).toBe('/wisp/grants/preview');
    expect(h.mintStepUpGrant).toHaveBeenCalledWith(expect.objectContaining({ resource: { partnerId: 'p-1', orgId: null, requestedCeilingHash: HASH } }));
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread');
  });

  it('a non-step-up failure toasts through runAction and keeps the modal open', async () => {
    routes((url, init) =>
      url === '/wisp/grants' && init?.method === 'POST' ? res({ error: 'This partner already has 25 active Wisp grants (plan limit 25).', code: 'GRANT_LIMIT_REACHED' }, 409) : undefined,
    );
    const onClose = vi.fn();
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={onClose} onGranted={onGranted} />);
    await confirmWithCode();
    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(h.mintStepUpGrant).toHaveBeenCalledTimes(1);
    expect(onGranted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('wisp-grant-confirm')).toBeInTheDocument();
  });

  it('refresh mode posts /wisp/grants/:id/refresh { stepUpGrantId } after a preview for the grant scope', async () => {
    routes((url, init) => (url === '/wisp/grants/g-1/refresh' && init?.method === 'POST' ? res(grantDto('org-1')) : undefined));
    const onGranted = vi.fn();
    render(
      <WispGrantStepUpModal open defaultOrgId="org-1" refresh={{ grantId: 'g-1', orgId: 'org-1' }} onClose={vi.fn()} onGranted={onGranted} />,
    );
    expect(screen.queryByTestId('wisp-scope-org')).toBeNull();
    await confirmWithCode();
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    const post = h.fetchWithAuth.mock.calls.find(([u]) => u === '/wisp/grants/g-1/refresh')!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ stepUpGrantId: 'su-1' });
    expect(calls('/wisp/grants/preview')[0]![0]).toBe('/wisp/grants/preview?orgId=org-1');
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Grant refreshed' }));
  });

  it('an account without a passkey or authenticator app cannot confirm', async () => {
    routes((url) => (url === '/users/me' ? res({ mfaMethod: 'sms' }) : undefined));
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
    expect(await screen.findByText(/Wisp needs a passkey or an authenticator app/)).toBeInTheDocument();
    expect(screen.getByTestId('wisp-grant-confirm')).toBeDisabled();
  });
});
