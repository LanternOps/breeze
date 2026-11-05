import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  StepUpMintError: class StepUpMintError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  },
}));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.showToast }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => h.claims }));

import WispGrantStepUpModal from './WispGrantStepUpModal';
import { StepUpMintError } from '@/lib/mfaStepUp';

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
/** `granted` starts false: /wisp/thread is 404 no_active_grant until a grant is created (or `liveGrant`). */
function routes(extra: Route = () => undefined, opts: { liveGrant?: boolean; passkey?: boolean } = {}) {
  let granted = opts.liveGrant ?? false;
  h.fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    const hit = extra(url, init);
    if (hit) {
      if (hit.ok && (url === '/wisp/grants' || url.endsWith('/refresh'))) granted = true;
      return hit;
    }
    if (url === '/users/me') return res({ mfaMethod: 'totp' });
    if (url === '/auth/passkeys') return res(opts.passkey ? [{ id: 'pk-1' }] : []);
    if (url.startsWith('/wisp/grants/preview')) return res({ scope: {}, ceilingSnapshot: {}, ceilingHash: HASH });
    if (url === '/wisp/grants' && init?.method === 'POST') {
      granted = true;
      const body = JSON.parse(String(init.body));
      return res(grantDto(body.orgId), 201);
    }
    if (url.startsWith('/wisp/thread')) {
      return granted ? res(threadBody(url.includes('orgId=') ? 'org-1' : null)) : res({ code: 'no_active_grant' }, 404);
    }
    return res({}, 404);
  });
}

/** Let every already-resolved fetch chain (factor discovery, probes) land and render. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

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
    // live-grant probe (404) → preview → create → thread
    expect(order).toEqual(['/wisp/thread?orgId=org-1', '/wisp/grants/preview?orgId=org-1', '/wisp/grants', '/wisp/thread?orgId=org-1']);
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
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread?orgId=org-1', { skipOrgIdInjection: true });
    expect(onGranted).toHaveBeenCalledWith({
      grantId: 'g-1', threadId: 't-1', scopeOrgId: 'org-1', focusOrgId: null, focusOrgName: null, status: 'active',
      expiresAt: '2027-01-01T00:00:00.000Z', summary: 'Last time: patched.', budgetCentsPerDay: 200, floorTickMinutes: 30,
      wideningAvailable: true,
    });
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Wisp is on' }));
  });

  it('a 403 STEP_UP_REQUIRED with a TOTP factor asks for a fresh code instead of replaying the spent one', async () => {
    routes((url, init) =>
      url === '/wisp/grants' && init?.method === 'POST' ? res({ error: 'stale proof', code: 'STEP_UP_REQUIRED' }, 403) : undefined,
    );
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    await confirmWithCode();
    expect(await screen.findByText(/Enter a new code/)).toBeInTheDocument();
    expect(h.mintStepUpGrant).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('wisp-stepup-code') as HTMLInputElement).value).toBe('');
    expect(onGranted).not.toHaveBeenCalled();
    // The expected re-verify path is not an error toast.
    expect(h.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('with a passkey, a 403 STEP_UP_REQUIRED re-runs preview + mint once, then shows wisp.modal.stepUpUnavailable', async () => {
    routes(
      (url, init) => (url === '/wisp/grants' && init?.method === 'POST' ? res({ error: 'stale proof', code: 'STEP_UP_REQUIRED' }, 403) : undefined),
      { passkey: true },
    );
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    await screen.findByText('You will confirm with your passkey.');
    fireEvent.click(screen.getByTestId('wisp-grant-confirm'));
    expect(await screen.findByText('Could not verify your factor. Try again.')).toBeInTheDocument();
    expect(calls('/wisp/grants/preview')).toHaveLength(2);
    expect(h.mintStepUpGrant).toHaveBeenCalledTimes(2);
    expect(h.mintStepUpGrant).toHaveBeenLastCalledWith(expect.objectContaining({ reauth: { method: 'passkey' } }));
    expect(onGranted).not.toHaveBeenCalled();
  });

  it('with a passkey, a 403 STEP_UP_REQUIRED followed by success grants on the second attempt', async () => {
    let posts = 0;
    routes(
      (url, init) => (url === '/wisp/grants' && init?.method === 'POST' && ++posts === 1 ? res({ error: 'stale', code: 'STEP_UP_REQUIRED' }, 403) : undefined),
      { passkey: true },
    );
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    await screen.findByText('You will confirm with your passkey.');
    fireEvent.click(screen.getByTestId('wisp-grant-confirm'));
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(h.mintStepUpGrant).toHaveBeenCalledTimes(2);
  });

  it('a grant already live for the scope is re-entered with no new step-up', async () => {
    routes(undefined, { liveGrant: true });
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await waitFor(() => expect(onGranted).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'g-1', threadId: 't-1' })));
    expect(h.mintStepUpGrant).not.toHaveBeenCalled();
    expect(calls('/wisp/grants')).toHaveLength(0);
  });

  describe('re-entering a live grant asks for no proof (#10105)', () => {
    it('with a live grant for the scope: says so, renders no code field, and Open works without input', async () => {
      routes(undefined, { liveGrant: true });
      const onGranted = vi.fn();
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
      expect(await screen.findByTestId('wisp-grant-live')).toHaveTextContent('Wisp is already on for this organization.');
      expect(screen.queryByTestId('wisp-stepup-code')).toBeNull();
      const open = screen.getByTestId('wisp-grant-confirm');
      expect(open).toHaveTextContent('Open');
      expect(open).toBeEnabled();
      fireEvent.click(open);
      await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
      expect(h.mintStepUpGrant).not.toHaveBeenCalled();
      expect(calls('/wisp/grants')).toHaveLength(0);
      expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Wisp is on' }));
    });

    it('hides the passkey prompt too when the factor is a passkey', async () => {
      routes(undefined, { liveGrant: true, passkey: true });
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
      await screen.findByTestId('wisp-grant-live');
      // Let factor discovery settle; the live-grant view must still win.
      await waitFor(() => expect(calls('/auth/passkeys')).toHaveLength(1));
      await settle();
      expect(screen.queryByText('You will confirm with your passkey.')).toBeNull();
    });

    it('an account with no usable factor can still reopen its live grant', async () => {
      routes((url) => (url === '/users/me' ? res({ mfaMethod: 'sms' }) : undefined), { liveGrant: true });
      const onGranted = vi.fn();
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
      await screen.findByTestId('wisp-grant-live');
      await waitFor(() => expect(calls('/users/me')).toHaveLength(1));
      await settle();
      expect(screen.queryByText(/Wisp needs a passkey or an authenticator app/)).toBeNull();
      fireEvent.click(screen.getByTestId('wisp-grant-confirm'));
      await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    });

    it('probes per scope: switching to a scope with no grant brings back the code requirement', async () => {
      routes((url) => (url === '/wisp/thread' ? res({ code: 'no_active_grant' }, 404) : undefined), { liveGrant: true });
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
      await screen.findByTestId('wisp-grant-live');
      fireEvent.click(screen.getByTestId('wisp-scope-partner'));
      const code = await screen.findByTestId('wisp-stepup-code');
      expect(screen.queryByTestId('wisp-grant-live')).toBeNull();
      expect(screen.getByTestId('wisp-grant-confirm')).toBeDisabled();
      fireEvent.change(code, { target: { value: '12345' } });
      expect(screen.getByTestId('wisp-grant-confirm')).toBeDisabled();
      fireEvent.change(code, { target: { value: '123456' } });
      expect(screen.getByTestId('wisp-grant-confirm')).toBeEnabled();
      // ...and back again.
      fireEvent.click(screen.getByTestId('wisp-scope-org'));
      expect(await screen.findByTestId('wisp-grant-live')).toBeInTheDocument();
      expect(screen.queryByTestId('wisp-stepup-code')).toBeNull();
    });

    it('without a live grant the 6-digit code is still required', async () => {
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
      const code = await screen.findByTestId('wisp-stepup-code');
      expect(screen.queryByTestId('wisp-grant-live')).toBeNull();
      expect(screen.getByTestId('wisp-grant-confirm')).toBeDisabled();
      fireEvent.change(code, { target: { value: '123456' } });
      expect(screen.getByTestId('wisp-grant-confirm')).toBeEnabled();
    });

    it('a grant that ended after the modal opened falls back to the step-up, never "Wisp is on"', async () => {
      let threadReads = 0;
      routes(
        (url) => (url === '/wisp/thread?orgId=org-1' && ++threadReads > 1 ? res({ code: 'no_active_grant' }, 404) : undefined),
        { liveGrant: true },
      );
      const onGranted = vi.fn();
      const onClose = vi.fn();
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={onClose} onGranted={onGranted} />);
      await screen.findByTestId('wisp-grant-live');
      fireEvent.click(screen.getByTestId('wisp-grant-confirm'));
      expect(await screen.findByText('Wisp is no longer on for this scope. Confirm it is you to turn it on again.')).toBeInTheDocument();
      expect(await screen.findByTestId('wisp-stepup-code')).toBeInTheDocument();
      expect(screen.getByTestId('wisp-grant-confirm')).toBeDisabled();
      expect(onGranted).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(h.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Wisp is on' }));
      // The message is about that scope: choosing another one clears it.
      fireEvent.click(screen.getByTestId('wisp-scope-partner'));
      await screen.findByTestId('wisp-grant-live');
      expect(screen.queryByText(/no longer on for this scope/)).toBeNull();
    });

    it('a grant that ended, on an account whose factor lookup failed, says why it cannot confirm', async () => {
      let threadReads = 0;
      routes(
        (url) => {
          if (url === '/auth/passkeys') return res({ error: 'boom' }, 500);
          return url === '/wisp/thread?orgId=org-1' && ++threadReads > 1 ? res({ code: 'no_active_grant' }, 404) : undefined;
        },
        { liveGrant: true },
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
      await screen.findByTestId('wisp-grant-live');
      await settle();
      expect(screen.queryByText('Could not verify your factor. Try again.')).toBeNull();
      fireEvent.click(screen.getByTestId('wisp-grant-confirm'));
      expect(await screen.findByText(/no longer on for this scope/)).toBeInTheDocument();
      expect(screen.getByText('Could not verify your factor. Try again.')).toBeInTheDocument();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('factor discovery failed'), expect.anything());
      warn.mockRestore();
    });

    it('a stale probe from the previous scope never shows Open for the new one', async () => {
      const pending = new Map<string, (r: Response) => void>();
      routes((url) => (url.startsWith('/wisp/thread') ? undefined : undefined));
      const base = h.fetchWithAuth.getMockImplementation()!;
      h.fetchWithAuth.mockImplementation((url: string, init?: RequestInit) =>
        url.startsWith('/wisp/thread') ? new Promise<Response>((resolve) => pending.set(url, resolve)) : base(url, init),
      );
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
      await waitFor(() => expect(pending.has('/wisp/thread?orgId=org-1')).toBe(true));
      // Switch scope while the org probe is still out, answer partner-wide "no grant"...
      fireEvent.click(screen.getByTestId('wisp-scope-partner'));
      await waitFor(() => expect(pending.has('/wisp/thread')).toBe(true));
      await act(async () => { pending.get('/wisp/thread')!(res({ code: 'no_active_grant' }, 404)); });
      expect(await screen.findByTestId('wisp-stepup-code')).toBeInTheDocument();
      // ...then the org probe lands late, saying "live". It must not flip the partner view.
      await act(async () => { pending.get('/wisp/thread?orgId=org-1')!(res(threadBody('org-1'))); });
      await settle();
      expect(screen.queryByTestId('wisp-grant-live')).toBeNull();
      expect(screen.getByTestId('wisp-stepup-code')).toBeInTheDocument();
      expect(screen.getByTestId('wisp-grant-confirm')).toBeDisabled();
    });

    it('right after a scope switch, the previous scope\'s live answer is not shown while the new one is checked', async () => {
      const pending = new Map<string, (r: Response) => void>();
      routes(undefined, { liveGrant: true });
      const base = h.fetchWithAuth.getMockImplementation()!;
      h.fetchWithAuth.mockImplementation((url: string, init?: RequestInit) =>
        url === '/wisp/thread' ? new Promise<Response>((resolve) => pending.set(url, resolve)) : base(url, init),
      );
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
      await screen.findByTestId('wisp-grant-live');
      fireEvent.click(screen.getByTestId('wisp-scope-partner'));
      // Synchronously after the switch: neither the org's "live" view nor a code field, and nothing to press.
      expect(screen.queryByTestId('wisp-grant-live')).toBeNull();
      expect(screen.queryByTestId('wisp-stepup-code')).toBeNull();
      expect(screen.getByTestId('wisp-grant-confirm')).toBeDisabled();
      await waitFor(() => expect(pending.has('/wisp/thread')).toBe(true));
      await act(async () => { pending.get('/wisp/thread')!(res({ code: 'no_active_grant' }, 404)); });
      expect(await screen.findByTestId('wisp-stepup-code')).toBeInTheDocument();
    });

    it('a failed probe (no answer) does not pretend a grant exists: the step-up stays and runs', async () => {
      routes((url) => (url.startsWith('/wisp/thread') ? res({ error: 'boom' }, 500) : undefined), { liveGrant: true });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
      expect(await screen.findByTestId('wisp-stepup-code')).toBeInTheDocument();
      expect(screen.queryByTestId('wisp-grant-live')).toBeNull();
      await confirmWithCode();
      await waitFor(() => expect(h.mintStepUpGrant).toHaveBeenCalledWith(expect.objectContaining({ reauth: { method: 'totp', code: '123456' } })));
      warn.mockRestore();
      errSpy.mockRestore();
    });

    it('refresh mode never probes: a refresh always takes a new proof', async () => {
      routes(undefined, { liveGrant: true });
      render(
        <WispGrantStepUpModal open defaultOrgId="org-1" refresh={{ grantId: 'g-1', orgId: 'org-1' }} onClose={vi.fn()} onGranted={vi.fn()} />,
      );
      expect(await screen.findByTestId('wisp-stepup-code')).toBeInTheDocument();
      expect(screen.queryByTestId('wisp-grant-live')).toBeNull();
      expect(calls('/wisp/thread')).toHaveLength(0);
    });

    it('with no org selected, "This organization" is not probed as partner-wide', async () => {
      routes(undefined, { liveGrant: true });
      h.claims = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: null } };
      render(<WispGrantStepUpModal open defaultOrgId={null} onClose={vi.fn()} onGranted={vi.fn()} />);
      expect(await screen.findByText('Select an organization in the header first.')).toBeInTheDocument();
      await waitFor(() => expect(calls('/users/me')).toHaveLength(1));
      expect(calls('/wisp/thread')).toHaveLength(0);
      expect(screen.queryByTestId('wisp-grant-live')).toBeNull();
    });
  });

  it('a 409 ALREADY_ACTIVE (lost race) opens the live grant instead of failing', async () => {
    let probed = false;
    routes((url, init) => {
      if (url === '/wisp/thread?orgId=org-1' && !probed) { probed = true; return res({ code: 'no_active_grant' }, 404); }
      if (url === '/wisp/grants' && init?.method === 'POST') return res({ error: 'already', code: 'ALREADY_ACTIVE' }, 409);
      if (url === '/wisp/thread?orgId=org-1') return res(threadBody('org-1'));
      return undefined;
    });
    const onGranted = vi.fn();
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={onGranted} />);
    await confirmWithCode();
    await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
    expect(h.showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('a rejected code says so (not the generic factor error)', async () => {
    h.mintStepUpGrant.mockRejectedValueOnce(new (StepUpMintError as unknown as new (c: string, m: string) => Error)('invalid_factor', 'bad'));
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={vi.fn()} onGranted={vi.fn()} />);
    await confirmWithCode();
    expect(await screen.findByText('That code was not accepted. Try again.')).toBeInTheDocument();
  });

  it('a grant whose thread does not open reports that once, never "Wisp is on"', async () => {
    routes((url) => (url === '/wisp/thread?orgId=org-1' ? res({ error: 'boom' }, 500) : undefined));
    const onClose = vi.fn();
    const onGranted = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<WispGrantStepUpModal open defaultOrgId="org-1" onClose={onClose} onGranted={onGranted} />);
    await confirmWithCode();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onGranted).not.toHaveBeenCalled();
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/thread could not be opened/) }));
    errSpy.mockRestore();
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
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread', { skipOrgIdInjection: true });
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
