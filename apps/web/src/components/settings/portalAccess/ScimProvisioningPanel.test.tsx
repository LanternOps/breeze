import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ScimProvisioningPanel } from './ScimProvisioningPanel';
import type { PortalScimStatusView, PortalScimTokenView } from './types';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));
// Every mutation goes through runAction (no-silent-mutations): spy on it, keep its behaviour.
const runActionSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/runAction', async (orig) => {
  const actual = await orig<typeof import('@/lib/runAction')>();
  return {
    ...actual,
    runAction: (...a: Parameters<typeof actual.runAction>) => { runActionSpy.calls += 1; return actual.runAction(...a); },
  };
});

const ORG = '11111111-1111-4111-8111-111111111111';
const STATUS = `/orgs/organizations/${ORG}/portal-scim`;
const TID = '22222222-2222-4222-8222-222222222222';
const SECRET = `brzscim_${'a'.repeat(32)}_${'S'.repeat(43)}`;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

function token(over: Partial<PortalScimTokenView> = {}): PortalScimTokenView {
  return {
    id: '33333333-3333-4333-8333-333333333333', label: 'Entra provisioning', hint: 'SSSS', tenantId: TID,
    createdAt: '2026-11-14T10:00:00.000Z', lastUsedAt: null, revokedAt: null, usable: true, ...over,
  };
}

function view(over: Partial<PortalScimStatusView> = {}): PortalScimStatusView {
  return {
    tenant: { proven: true, tenantId: TID },
    baseUrl: 'https://api.example.com/api/v1/scim/portal/v2',
    tokens: [token()],
    counts: { provisioned: 12, deactivated: 2 },
    ...over,
  };
}

function mockStatus(v: PortalScimStatusView, extra?: (url: string, init?: RequestInit) => Promise<Response> | undefined) {
  fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url === STATUS && (!init?.method || init.method === 'GET')) return json({ data: v });
    return json({ error: 'unexpected' }, 500);
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  showToastMock.mockReset();
  runActionSpy.calls = 0;
});

describe('ScimProvisioningPanel', () => {
  it('shows the Tenant URL, the counts and each token without its secret', async () => {
    mockStatus(view());
    render(<ScimProvisioningPanel orgId={ORG} canEdit />);
    expect(await screen.findByTestId('portal-scim-base-url')).toHaveValue('https://api.example.com/api/v1/scim/portal/v2');
    expect(screen.getByTestId('portal-scim-counts')).toHaveTextContent('12');
    expect(screen.getByTestId('portal-scim-token-row')).toHaveTextContent('Entra provisioning');
    expect(screen.getByTestId('portal-scim-token-row')).toHaveTextContent('SSSS');
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('an unproven tenant shows the prerequisite and no create button', async () => {
    mockStatus(view({ tenant: { proven: false, tenantId: null }, tokens: [] }));
    render(<ScimProvisioningPanel orgId={ORG} canEdit />);
    expect(await screen.findByTestId('portal-scim-needs-tenant')).toBeInTheDocument();
    expect(screen.queryByTestId('portal-scim-create')).toBeNull();
  });

  it('a token bound to a tenant that is no longer proven is marked not working', async () => {
    mockStatus(view({ tokens: [token({ usable: false })] }));
    render(<ScimProvisioningPanel orgId={ORG} canEdit />);
    expect(await screen.findByTestId('portal-scim-token-unusable')).toBeInTheDocument();
  });

  it('create: runAction POST with the label, the secret is shown once with copy, then hidden on close', async () => {
    let created = false;
    mockStatus(view({ tokens: [] }), (url, init) => {
      if (url === `${STATUS}/tokens` && init?.method === 'POST') {
        created = true;
        expect(JSON.parse(String(init.body))).toEqual({ label: 'Entra provisioning' });
        return json({ data: { token: SECRET, tokenInfo: token(), baseUrl: view().baseUrl } }, 201);
      }
      return undefined;
    });
    render(<ScimProvisioningPanel orgId={ORG} canEdit />);
    fireEvent.click(await screen.findByTestId('portal-scim-create'));
    fireEvent.change(screen.getByTestId('portal-scim-label'), { target: { value: 'Entra provisioning' } });
    fireEvent.click(screen.getByTestId('portal-scim-create-submit'));
    expect(await screen.findByTestId('portal-scim-secret')).toHaveValue(SECRET);
    expect(created).toBe(true);
    expect(runActionSpy.calls).toBe(1);
    fireEvent.click(screen.getByTestId('portal-scim-secret-done'));
    await waitFor(() => expect(screen.queryByTestId('portal-scim-secret')).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('revoke: confirm, then runAction DELETE of that token and a reload', async () => {
    let revoked = false;
    mockStatus(view(), (url, init) => {
      if (url === `${STATUS}/tokens/${token().id}` && init?.method === 'DELETE') {
        revoked = true;
        return json(null, 204);
      }
      return undefined;
    });
    render(<ScimProvisioningPanel orgId={ORG} canEdit />);
    fireEvent.click(await screen.findByTestId('portal-scim-revoke'));
    fireEvent.click(await screen.findByTestId('portal-scim-revoke-confirm'));
    await waitFor(() => expect(revoked).toBe(true));
    expect(runActionSpy.calls).toBe(1);
  });

  it('read-only users see the status but no create or revoke', async () => {
    mockStatus(view());
    render(<ScimProvisioningPanel orgId={ORG} canEdit={false} />);
    await screen.findByTestId('portal-scim-token-row');
    expect(screen.queryByTestId('portal-scim-create')).toBeNull();
    expect(screen.queryByTestId('portal-scim-revoke')).toBeNull();
  });

  it('the token limit refusal shows its own message', async () => {
    mockStatus(view({ tokens: [token(), token({ id: '44444444-4444-4444-8444-444444444444' })] }), (url, init) => {
      if (url === `${STATUS}/tokens` && init?.method === 'POST') return json({ error: 'limit', code: 'PORTAL_SCIM_TOKEN_LIMIT' }, 409);
      return undefined;
    });
    render(<ScimProvisioningPanel orgId={ORG} canEdit />);
    fireEvent.click(await screen.findByTestId('portal-scim-create'));
    fireEvent.change(screen.getByTestId('portal-scim-label'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('portal-scim-create-submit'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(JSON.stringify(showToastMock.mock.calls)).toMatch(/two active provisioning tokens|portalScim\.errors\.limit/i);
  });

  it('a load failure shows an error state', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ error: 'boom' }, 500));
    render(<ScimProvisioningPanel orgId={ORG} canEdit />);
    expect(await screen.findByTestId('portal-scim-error')).toBeInTheDocument();
  });
});
