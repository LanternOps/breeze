import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    const view = makePolicyView({ capabilities: { entra: true }, inherited: { entraEnabled: true } });
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
