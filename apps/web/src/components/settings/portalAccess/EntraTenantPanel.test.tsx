import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EntraTenantPanel } from './EntraTenantPanel';
import type { PortalEntraTenantView } from './types';

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
const TENANT = '22222222-2222-4222-8222-222222222222';
const BASE = `/orgs/organizations/${ORG}/portal-entra-tenant`;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function status(over: Partial<PortalEntraTenantView> = {}): PortalEntraTenantView {
  return { tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: null, consentUrl: null, ...over };
}

type Handler = (init?: RequestInit) => Promise<Response>;

function mockRoutes(routes: Record<string, Handler>) {
  fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    return handler ? handler(init) : json({ error: `unexpected ${key}` }, 500);
  });
}

const calls = (method: string, url: string) =>
  fetchWithAuthMock.mock.calls.filter(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? 'GET') === method);

function renderPanel() {
  const onChanged = vi.fn();
  render(<EntraTenantPanel orgId={ORG} onChanged={onChanged} />);
  return { onChanged };
}

describe('EntraTenantPanel', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    navigateToMock.mockReset();
    showToastMock.mockReset();
  });

  it('shows not proven with both proof actions when a connection tenant exists', async () => {
    mockRoutes({ [`GET ${BASE}`]: () => json({ data: status({ connectionTenantId: TENANT }) }) });
    renderPanel();
    expect(await screen.findByTestId('entra-tenant-status')).toHaveTextContent('No Microsoft tenant is linked yet');
    expect(screen.getByTestId('entra-tenant-prove-connection')).toHaveTextContent(`Use Microsoft 365 connection (tenant ${TENANT})`);
    expect(screen.getByTestId('entra-tenant-create-link')).toBeInTheDocument();
    // Prefilled from the connection tenant.
    expect((screen.getByTestId('entra-tenant-hint') as HTMLInputElement).value).toBe(TENANT);
    expect(screen.queryByTestId('entra-tenant-remove')).toBeNull();
  });

  it('hides the connection action without a connection tenant and requires a tenant for the link', async () => {
    mockRoutes({ [`GET ${BASE}`]: () => json({ data: status() }) });
    renderPanel();
    await screen.findByTestId('entra-tenant-status');
    expect(screen.queryByTestId('entra-tenant-prove-connection')).toBeNull();
    expect(screen.getByTestId('entra-tenant-create-link')).toBeDisabled();
  });

  it('create proof link shows the url and expiry', async () => {
    const url = 'https://portal.example.test/api/v1/portal/auth/oidc/entra/proof?run=abc';
    mockRoutes({
      [`GET ${BASE}`]: () => json({ data: status({ tenantId: TENANT, state: 'unproven' }) }),
      [`POST ${BASE}/proof-links`]: () => json({ data: { url, expiresAt: '2026-11-12T10:00:00.000Z', expectedTenantId: TENANT } }),
    });
    renderPanel();
    expect(await screen.findByTestId('entra-tenant-status')).toHaveTextContent(`Tenant ${TENANT} is linked but not proven`);
    fireEvent.click(screen.getByTestId('entra-tenant-create-link'));
    expect(await screen.findByTestId('entra-tenant-link-url')).toHaveValue(url);
    expect(screen.getByTestId('entra-tenant-link-expiry')).toHaveTextContent(`Works only for tenant ${TENANT}`);
    const [[, init]] = calls('POST', `${BASE}/proof-links`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ tenant: TENANT });
  });

  it('maps a proof-link refusal code to its message', async () => {
    mockRoutes({
      [`GET ${BASE}`]: () => json({ data: status() }),
      [`POST ${BASE}/proof-links`]: () => json({ error: 'x', code: 'PORTAL_ENTRA_TENANT_HINT_LOOKUP_FAILED' }, 503),
    });
    renderPanel();
    await screen.findByTestId('entra-tenant-status');
    fireEvent.change(screen.getByTestId('entra-tenant-hint'), { target: { value: 'contoso.example' } });
    fireEvent.click(screen.getByTestId('entra-tenant-create-link'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: "Couldn't reach Microsoft to look up that domain. Try again, or enter the tenant ID.",
    })));
    expect(screen.queryByTestId('entra-tenant-link-url')).toBeNull();
  });

  it('prove from connection maps TENANT_PROVEN_ELSEWHERE and reloads on success', async () => {
    let proven = false;
    mockRoutes({
      [`GET ${BASE}`]: () => json({ data: proven
        ? status({ tenantId: TENANT, state: 'proven', provenAt: '2026-11-09T10:00:00.000Z', provenVia: 'm365_connection', connectionTenantId: TENANT, consentUrl: 'https://login.example.test/consent' })
        : status({ connectionTenantId: TENANT }) }),
      [`POST ${BASE}/prove-from-connection`]: () => {
        proven = true;
        return json({ data: status({ tenantId: TENANT, state: 'proven', provenAt: '2026-11-09T10:00:00.000Z', provenVia: 'm365_connection', connectionTenantId: TENANT }) });
      },
    });
    const { onChanged } = renderPanel();
    fireEvent.click(await screen.findByTestId('entra-tenant-prove-connection'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('entra-tenant-consent-url')).toHaveValue('https://login.example.test/consent');
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Microsoft tenant proven.' }));
  });

  it('prove from connection refusal shows the mapped message and does not call onChanged', async () => {
    mockRoutes({
      [`GET ${BASE}`]: () => json({ data: status({ connectionTenantId: TENANT }) }),
      [`POST ${BASE}/prove-from-connection`]: () => json({ error: 'x', code: 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE' }, 409),
    });
    const { onChanged } = renderPanel();
    fireEvent.click(await screen.findByTestId('entra-tenant-prove-connection'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining('already proven for another organization'),
    })));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('proven shows date, method and the consent link', async () => {
    mockRoutes({
      [`GET ${BASE}`]: () => json({ data: status({
        tenantId: TENANT, state: 'proven', provenAt: '2026-11-09T10:00:00.000Z', provenVia: 'proof_run',
        consentUrl: `https://login.example.test/${TENANT}/v2.0/adminconsent?client_id=x`,
      }) }),
    });
    renderPanel();
    const statusLine = await screen.findByTestId('entra-tenant-status');
    expect(statusLine).toHaveTextContent(`Tenant ${TENANT} proven`);
    expect(statusLine).toHaveTextContent('via an admin sign-in');
    expect(screen.getByTestId('entra-tenant-consent-url')).toHaveValue(`https://login.example.test/${TENANT}/v2.0/adminconsent?client_id=x`);
    expect(screen.queryByTestId('entra-tenant-create-link')).toBeNull();
    expect(screen.queryByTestId('entra-tenant-prove-connection')).toBeNull();
    expect(screen.getByTestId('entra-tenant-remove')).toBeInTheDocument();
  });

  it('remove asks for confirmation naming AI for Office', async () => {
    mockRoutes({
      [`GET ${BASE}`]: () => json({ data: status({ tenantId: TENANT, state: 'proven', provenAt: '2026-11-09T10:00:00.000Z', provenVia: 'proof_run' }) }),
      [`DELETE ${BASE}`]: () => json({ data: { removed: true, tenantId: TENANT } }),
    });
    const { onChanged } = renderPanel();
    fireEvent.click(await screen.findByTestId('entra-tenant-remove'));
    const dialog = await screen.findByTestId('entra-tenant-remove-dialog');
    expect(dialog).toHaveTextContent('AI for Office');
    // Nothing removed until confirmed.
    expect(calls('DELETE', BASE)).toHaveLength(0);
    fireEvent.click(within(document.body).getByTestId('entra-tenant-remove-confirm'));
    await waitFor(() => expect(calls('DELETE', BASE)).toHaveLength(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('renders nothing when the portal Entra app is not configured', async () => {
    mockRoutes({ [`GET ${BASE}`]: () => json({ error: 'x', code: 'PORTAL_ENTRA_NOT_CONFIGURED' }, 404) });
    const { container } = render(<EntraTenantPanel orgId={ORG} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('a failed load shows an error with retry', async () => {
    mockRoutes({ [`GET ${BASE}`]: () => json({ error: 'boom' }, 500) });
    renderPanel();
    expect(await screen.findByTestId('entra-tenant-load-error')).toHaveTextContent("Couldn't load the Microsoft tenant.");
    mockRoutes({ [`GET ${BASE}`]: () => json({ data: status() }) });
    fireEvent.click(screen.getByTestId('entra-tenant-retry'));
    expect(await screen.findByTestId('entra-tenant-status')).toBeInTheDocument();
  });
});
