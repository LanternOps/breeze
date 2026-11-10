import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OrgSignInRegistrationCard from './OrgSignInRegistrationCard';
import { makePolicyView } from './viewFixture';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));
const navigateToMock = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateToMock(...a) }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const POLICY = `/orgs/organizations/${ORG}/portal-access-policy`;
const REQUESTS = `/orgs/organizations/${ORG}/portal-access-requests?status=pending`;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function request(id: string) {
  return {
    id, email: `${id}@acme.test`, name: null, source: 'entra', status: 'pending',
    requestedAt: '2026-11-01T00:00:00.000Z', lastRequestedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-11-15T00:00:00.000Z', decidedAt: null, decidedBy: null, portalUserId: null, accountExists: false,
  };
}

type Routes = { view?: ReturnType<typeof makePolicyView>; patch?: () => Promise<Response>; pending?: unknown[] };

function mockRoutes({ view = makePolicyView(), patch, pending = [] }: Routes = {}) {
  fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === POLICY && (!init?.method || init.method === 'GET')) return json({ data: view });
    if (url === POLICY && init?.method === 'PATCH') return patch ? patch() : json({ data: view });
    if (url === REQUESTS) return json({ data: pending, hasMore: false });
    return json({ error: 'unexpected' }, 500);
  });
}

function renderCard() {
  const onDirty = vi.fn();
  const onSave = vi.fn();
  render(<OrgSignInRegistrationCard orgId={ORG} onDirty={onDirty} onSave={onSave} />);
  return { onDirty, onSave };
}

const patchCalls = () => fetchWithAuthMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');

describe('OrgSignInRegistrationCard', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    navigateToMock.mockReset();
    showToastMock.mockReset();
  });

  it('loads and renders effective values with sources', async () => {
    mockRoutes({ view: makePolicyView({ inherited: { passwordMode: 'allowed' }, inheritedSource: 'partner' }) });
    renderCard();
    expect(await screen.findByText('Inherit — Allowed (Partner default)')).toBeInTheDocument();
    expect((screen.getByTestId('portal-access-policy-password-inherit') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('portal-access-policy-invites')).toHaveTextContent('Always on');
  });

  it('shows an override as the checked option, not the inherit radio', async () => {
    mockRoutes({ view: makePolicyView({ values: { passwordMode: 'allowed' }, inheritedSource: 'default' }) });
    renderCard();
    expect(await screen.findByText('Inherit — Allowed (Breeze default)')).toBeInTheDocument();
    expect((screen.getByTestId('portal-access-policy-password-allowed') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('portal-access-policy-password-inherit') as HTMLInputElement).checked).toBe(false);
  });

  it('saving an override PATCHes only changed fields and calls onSave', async () => {
    const saved = makePolicyView({ values: { passwordMode: 'allowed' } });
    mockRoutes({ patch: () => json({ data: saved }) });
    const { onDirty, onSave } = renderCard();
    const save = await screen.findByTestId('org-sign-in-card-save');
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByTestId('portal-access-policy-password-allowed'));
    expect(onDirty).toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [[url, init]] = patchCalls();
    expect(url).toBe(POLICY);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ passwordMode: 'allowed' });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Sign-in settings saved.' }));
    // Re-baselined on the server's copy: nothing left to save.
    await waitFor(() => expect(screen.getByTestId('org-sign-in-card-save')).toBeDisabled());
  });

  it('clearing to inherit sends null', async () => {
    mockRoutes({ view: makePolicyView({ values: { passwordMode: 'allowed' } }) });
    renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-inherit'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(JSON.parse((patchCalls()[0][1] as RequestInit).body as string)).toEqual({ passwordMode: null });
  });

  it('a 400 SSO_ONLY_NEEDS_SSO shows the field error, not a generic toast', async () => {
    const view = makePolicyView({ capabilities: { entra: true }, inherited: { entraEnabled: true }, entraTenantProven: true });
    mockRoutes({
      view,
      patch: () => json({ error: 'needs sso', code: 'PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO', field: 'passwordMode' }, 400),
    });
    const { onSave } = renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-sso_only'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    expect(await screen.findByTestId('portal-access-policy-passwordMode-error')).toHaveTextContent(
      'Turn on Microsoft or Google sign-in before turning off password sign-in.',
    );
    expect(showToastMock).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    // The draft survives for another try.
    expect(screen.getByTestId('org-sign-in-card-save')).not.toBeDisabled();
  });

  it('a 400 METHOD_UNAVAILABLE on a hidden field still surfaces as a toast', async () => {
    mockRoutes({
      patch: () => json({ error: 'nope', code: 'PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE', field: 'googleEnabled' }, 400),
    });
    renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-allowed'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: "This sign-in method isn't available on this Breeze deployment yet.",
    })));
  });

  it('Requests (n) button scrolls to the queue', async () => {
    mockRoutes({ pending: [request('r1'), request('r2')] });
    const target = document.createElement('section');
    target.id = 'portal-access-requests';
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    document.body.appendChild(target);
    try {
      renderCard();
      const button = await screen.findByTestId('portal-access-policy-requests');
      expect(button).toHaveTextContent('Requests (2)');
      const hashBefore = window.location.hash;
      fireEvent.click(button);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe(hashBefore);
    } finally {
      target.remove();
    }
  });

  it('shows "n+" when the pending list has more pages', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === POLICY) return json({ data: makePolicyView() });
      return json({ data: [request('r1'), request('r2')], hasMore: true });
    });
    renderCard();
    expect(await screen.findByTestId('portal-access-policy-requests')).toHaveTextContent('Requests (2+)');
  });

  it('a 200 save without a policy view is a failed save: error toast, no onSave, draft kept', async () => {
    mockRoutes({ patch: () => json({ data: null }) });
    const { onSave } = renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-allowed'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: "Couldn't save sign-in settings.",
    })));
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('portal-access-policy-form')).toBeInTheDocument();
    expect(screen.getByTestId('org-sign-in-card-save')).not.toBeDisabled();
  });

  it('a failed request-count load leaves the card working without the Requests button', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === POLICY) return json({ data: makePolicyView() });
      return json({ error: 'forbidden' }, 403);
    });
    renderCard();
    expect(await screen.findByTestId('portal-access-policy-form')).toBeInTheDocument();
    expect(screen.queryByTestId('portal-access-policy-requests')).toBeNull();
  });

  it('shows a load error with retry', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === POLICY) return json({ error: 'boom' }, 500);
      return json({ data: [], hasMore: false });
    });
    renderCard();
    expect(await screen.findByTestId('org-sign-in-card-load-error')).toHaveTextContent("Couldn't load sign-in settings.");
    mockRoutes();
    fireEvent.click(screen.getByTestId('org-sign-in-card-retry'));
    expect(await screen.findByTestId('portal-access-policy-form')).toBeInTheDocument();
  });

  it('a malformed 200 body shows the load error instead of crashing', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === POLICY) return json({ data: [] });
      return json({ data: [], hasMore: false });
    });
    renderCard();
    expect(await screen.findByTestId('org-sign-in-card-load-error')).toBeInTheDocument();
  });

  it('a 401 on load sends the user to login', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ error: 'unauthorized' }, 401));
    renderCard();
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true }));
  });
});

// ── W4 (#11381): tenant proof panel, TENANT_NOT_PROVEN, sso_only confirmation, stranded list ──

const TENANT_URL = `/orgs/organizations/${ORG}/portal-entra-tenant`;
const STRANDED = `/orgs/organizations/${ORG}/portal-access-policy/stranded`;
const SSO_INVITE = `/orgs/organizations/${ORG}/portal-users/sso-invite`;

type FlowRoutes = {
  view?: ReturnType<typeof makePolicyView>;
  patch?: (url: string, init: RequestInit) => Promise<Response>;
  stranded?: () => Promise<Response>;
  ssoInvite?: (init: RequestInit) => Promise<Response>;
  tenant?: () => Promise<Response>;
};

function mockFlow({ view = makePolicyView(), patch, stranded, ssoInvite, tenant }: FlowRoutes) {
  fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === POLICY && method === 'GET') return json({ data: view });
    if (url.startsWith(POLICY) && method === 'PATCH') return patch ? patch(url, init!) : json({ data: view });
    if (url === REQUESTS) return json({ data: [], hasMore: false });
    if (url === STRANDED) return stranded ? stranded() : json({ data: { items: [], total: 0 } });
    if (url === SSO_INVITE && method === 'POST') return ssoInvite ? ssoInvite(init!) : json({ data: [] });
    if (url === TENANT_URL) return tenant ? tenant() : json({ error: 'x', code: 'PORTAL_ENTRA_NOT_CONFIGURED' }, 404);
    return json({ error: `unexpected ${method} ${url}` }, 500);
  });
}

const flip = (passwordsToClear: number, strandedTotal: number) => ({ orgId: ORG, orgName: 'Acme', passwordsToClear, strandedTotal });
const confirmRequired = (digest: string, passwordsToClear = 3, strandedTotal = 2) => json({
  error: 'confirm', code: 'PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED',
  impact: { flips: [flip(passwordsToClear, strandedTotal)], impactDigest: digest },
}, 409);
const strandedBody = (ids: string[], total = ids.length) => json({
  data: { items: ids.map((id, i) => ({ portalUserId: id, email: `${id}@acme.test`, name: i === 0 ? 'Pat Doe' : null, status: 'active' })), total },
});
const ssoCapableView = (over: Parameters<typeof makePolicyView>[0] = {}) =>
  makePolicyView({ capabilities: { entra: true }, inherited: { entraEnabled: true }, entraTenantProven: true, ...over });

describe('OrgSignInRegistrationCard — W4', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    navigateToMock.mockReset();
    showToastMock.mockReset();
  });

  it('renders the tenant panel under the Microsoft row', async () => {
    mockFlow({
      view: makePolicyView({ capabilities: { entra: true } }),
      tenant: () => json({ data: { tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: null, consentUrl: null } }),
    });
    renderCard();
    expect(await screen.findByTestId('entra-tenant-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('entra-tenant-status')).toHaveTextContent('No Microsoft tenant is linked yet');
  });

  it('the tenant panel re-reads the tenant when a saved view reports a different proof state', async () => {
    const tenantNone = { tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: null, consentUrl: null };
    mockFlow({
      view: makePolicyView({ capabilities: { entra: true }, entraTenantProven: false }),
      patch: () => json({ data: makePolicyView({ capabilities: { entra: true }, entraTenantProven: true, values: { passwordMode: 'allowed' } }) }),
      tenant: () => json({ data: tenantNone }),
    });
    renderCard();
    await screen.findByTestId('entra-tenant-status');
    const tenantReads = () => fetchWithAuthMock.mock.calls.filter(([u]) => u === TENANT_URL).length;
    expect(tenantReads()).toBe(1);
    fireEvent.click(screen.getByTestId('portal-access-policy-password-allowed'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    await waitFor(() => expect(tenantReads()).toBe(2));
  });

  it('an invalid session length blocks Save until it is fixed', async () => {
    mockFlow({ view: makePolicyView({ capabilities: { entra: true } }) });
    renderCard();
    const input = await screen.findByTestId('portal-access-policy-session-hours');
    fireEvent.change(input, { target: { value: '20' } });
    expect(screen.getByTestId('org-sign-in-card-save')).not.toBeDisabled();
    fireEvent.change(input, { target: { value: '200' } });
    expect(screen.getByTestId('org-sign-in-card-save')).toBeDisabled();
    fireEvent.change(input, { target: { value: '24' } });
    expect(screen.getByTestId('org-sign-in-card-save')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(JSON.parse((patchCalls()[0][1] as RequestInit).body as string)).toEqual({ ssoSessionMaxHours: 24 });
  });

  it('confirming without ticking invites saves and sends no invites', async () => {
    mockFlow({
      view: ssoCapableView(),
      patch: (url) => (url === `${POLICY}?acknowledge=d1`
        ? json({ data: ssoCapableView({ values: { passwordMode: 'sso_only' } }) })
        : confirmRequired('d1')),
      stranded: () => strandedBody(['u1']),
    });
    const { onSave } = renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-sso_only'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    fireEvent.click(await screen.findByTestId('sso-only-confirm'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(fetchWithAuthMock.mock.calls.some(([u]) => u === SSO_INVITE)).toBe(false);
  });

  it('a confirmed save that fails closes the dialog, keeps the draft and sends no invites', async () => {
    mockFlow({
      view: ssoCapableView(),
      patch: (url) => (url === `${POLICY}?acknowledge=d1` ? json({ error: 'boom' }, 500) : confirmRequired('d1')),
      stranded: () => strandedBody(['u1']),
    });
    const { onSave } = renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-sso_only'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    fireEvent.click(await screen.findByTestId('sso-only-confirm-send-invites'));
    fireEvent.click(screen.getByTestId('sso-only-confirm'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(screen.queryByTestId('sso-only-confirm-dialog')).toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    expect(fetchWithAuthMock.mock.calls.some(([u]) => u === SSO_INVITE)).toBe(false);
    expect(screen.getByTestId('org-sign-in-card-save')).not.toBeDisabled();
  });

  it('TENANT_NOT_PROVEN shows the field error on the Microsoft row', async () => {
    mockFlow({
      view: makePolicyView({ capabilities: { entra: true } }),
      patch: () => json({ error: 'x', code: 'PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN', field: 'entraEnabled' }, 400),
    });
    renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-microsoft-on'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    expect(await screen.findByTestId('portal-access-policy-entraEnabled-error')).toHaveTextContent(
      "Prove this organization's Microsoft tenant before turning on Microsoft sign-in.",
    );
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('save that flips to sso_only opens the dialog with counts and stranded names', async () => {
    mockFlow({ view: ssoCapableView(), patch: () => confirmRequired('d1'), stranded: () => strandedBody(['u1', 'u2']) });
    const { onSave } = renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-sso_only'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    const dialog = await screen.findByTestId('sso-only-confirm-dialog');
    expect(within(dialog).getByTestId(`sso-only-confirm-flip-${ORG}`)).toHaveTextContent('3');
    expect(await within(dialog).findByTestId('sso-only-confirm-stranded')).toHaveTextContent('Pat Doe');
    // The 409 is the dialog, not an error toast; nothing saved yet.
    expect(showToastMock).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('confirm sends the impact digest and then batches sso-invite when ticked', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    let acknowledged = false;
    mockFlow({
      view: ssoCapableView(),
      patch: (url) => {
        if (url === `${POLICY}?acknowledge=d1`) {
          acknowledged = true;
          return json({ data: ssoCapableView({ values: { passwordMode: 'sso_only' } }) });
        }
        return confirmRequired('d1', 3, 150);
      },
      stranded: () => strandedBody(ids),
      ssoInvite: (init) => {
        const { portalUserIds } = JSON.parse(init.body as string) as { portalUserIds: string[] };
        return json({ data: portalUserIds.map((portalUserId) => ({ portalUserId, result: 'invited', emailSent: true })) });
      },
    });
    const { onSave } = renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-sso_only'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    fireEvent.click(await screen.findByTestId('sso-only-confirm-send-invites'));
    fireEvent.click(screen.getByTestId('sso-only-confirm'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(acknowledged).toBe(true);
    const inviteCalls = () => fetchWithAuthMock.mock.calls.filter(([u]) => u === SSO_INVITE);
    await waitFor(() => expect(inviteCalls()).toHaveLength(2));
    const batches = inviteCalls().map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { portalUserIds: string[] }).portalUserIds);
    expect(batches[0]).toHaveLength(100);
    expect(batches[1]).toHaveLength(50);
    expect([...batches[0], ...batches[1]]).toEqual(ids);
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success', message: 'Sent 150 Microsoft sign-in invite(s).',
    })));
    expect(screen.queryByTestId('sso-only-confirm-dialog')).toBeNull();
  });

  it('a 409 with a new digest re-opens the dialog with fresh counts', async () => {
    mockFlow({
      view: ssoCapableView(),
      patch: (url) => (url === `${POLICY}?acknowledge=d1` ? confirmRequired('d2', 7, 4) : confirmRequired('d1', 3, 2)),
      stranded: () => strandedBody(['u1']),
    });
    const { onSave } = renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-sso_only'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    fireEvent.click(await screen.findByTestId('sso-only-confirm'));
    expect(await screen.findByTestId('sso-only-confirm-changed')).toBeInTheDocument();
    expect(screen.getByTestId(`sso-only-confirm-flip-${ORG}`)).toHaveTextContent('7');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sso-only-confirm'));
    await waitFor(() => expect(patchCalls().map(([u]) => u)).toContain(`${POLICY}?acknowledge=d2`));
  });

  it('cancel writes nothing', async () => {
    mockFlow({ view: ssoCapableView(), patch: () => confirmRequired('d1') });
    const { onSave } = renderCard();
    fireEvent.click(await screen.findByTestId('portal-access-policy-password-sso_only'));
    fireEvent.click(screen.getByTestId('org-sign-in-card-save'));
    const dialog = await screen.findByTestId('sso-only-confirm-dialog');
    fireEvent.click(within(dialog.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByTestId('sso-only-confirm-dialog')).toBeNull());
    expect(patchCalls()).toHaveLength(1); // only the unacknowledged attempt, which the server refused
    expect(patchCalls()[0][0]).toBe(POLICY);
    expect(onSave).not.toHaveBeenCalled();
    expect(fetchWithAuthMock.mock.calls.some(([u]) => u === SSO_INVITE)).toBe(false);
    // The draft survives.
    expect(screen.getByTestId('org-sign-in-card-save')).not.toBeDisabled();
  });

  it('stranded list shows when sso_only is effective', async () => {
    const view = ssoCapableView({ values: { passwordMode: 'sso_only' } });
    view.effective.passwordMode = { value: 'sso_only', source: 'org' };
    mockFlow({
      view,
      stranded: () => strandedBody(['u1', 'u2']),
      ssoInvite: () => json({ data: [{ portalUserId: 'u1', result: 'invited', emailSent: true }] }),
    });
    renderCard();
    const list = await screen.findByTestId('portal-access-stranded');
    expect(list).toHaveTextContent("Can't sign in yet (2)");
    expect(list).toHaveTextContent('Pat Doe');
    fireEvent.click(screen.getByTestId('portal-access-stranded-invite-u1'));
    await waitFor(() => expect(fetchWithAuthMock.mock.calls.filter(([u]) => u === SSO_INVITE)).toHaveLength(1));
    const [, init] = fetchWithAuthMock.mock.calls.find(([u]) => u === SSO_INVITE)!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ portalUserIds: ['u1'] });
  });

  it('no stranded list while password sign-in is effectively allowed', async () => {
    mockFlow({ view: ssoCapableView(), stranded: () => strandedBody(['u1']) });
    renderCard();
    await screen.findByTestId('portal-access-policy-form');
    expect(screen.queryByTestId('portal-access-stranded')).toBeNull();
    expect(fetchWithAuthMock.mock.calls.some(([u]) => u === STRANDED)).toBe(false);
  });
});
