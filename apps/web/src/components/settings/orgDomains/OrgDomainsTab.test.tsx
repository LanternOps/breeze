import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OrgDomainsTab from './OrgDomainsTab';
import { DOMAINS, ENTRA, GOOGLE, ORG, OTHER_ORG, TENANT, callsTo, domainView, json, routeFetch, verifiedDns } from './testFixtures';

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
const fetchAllOrganizationsFromMock = vi.fn();
vi.mock('../../../lib/fetchAllOrganizations', () => ({
  fetchAllOrganizationsFrom: (...a: unknown[]) => fetchAllOrganizationsFromMock(...a),
}));

const entraNone = () => json({ data: { tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: null, consentUrl: null } });
const entraProvenWithConnection = () => json({ data: {
  tenantId: TENANT, state: 'proven', provenAt: '2026-11-01T00:00:00.000Z', provenVia: 'm365_connection', connectionTenantId: TENANT, consentUrl: null,
} });
const googleConnected = () => json({ connected: true, customerDomain: 'contoso.com' });

function baseRoutes(rows: unknown[], extra: Record<string, (init?: RequestInit) => Promise<Response>> = {}) {
  routeFetch(fetchWithAuthMock, {
    [`GET ${DOMAINS}`]: () => json({ data: rows }),
    [`GET ${ENTRA}`]: entraNone,
    [`GET ${GOOGLE}`]: () => json({ connected: false }),
    ...extra,
  });
}

describe('OrgDomainsTab', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    navigateToMock.mockReset();
    showToastMock.mockReset();
    fetchAllOrganizationsFromMock.mockReset();
    fetchAllOrganizationsFromMock.mockResolvedValue([{ id: ORG, name: 'Contoso' }, { id: OTHER_ORG, name: 'Fabrikam' }]);
  });

  it('lists domains with state badges', async () => {
    baseRoutes([
      domainView({ id: 'd1', domain: 'contoso.com' }),
      domainView({ id: 'd2', domain: 'contoso.co.uk', state: 'pending_dns', dnsRecord: { recordName: 'n', recordValue: 'v' } }),
      verifiedDns({ id: 'd3', domain: 'contoso.org' }),
      domainView({ id: 'd4', domain: 'contoso.net', method: null, clearedAt: '2026-11-08T00:00:00.000Z', clearedReason: 'displaced' }),
    ]);
    render(<OrgDomainsTab orgId={ORG} />);
    expect(await screen.findByTestId('org-domains-state-d1')).toHaveTextContent(/declared — mail routing only/i);
    expect(screen.getByTestId('org-domains-state-d2')).toHaveTextContent(/pending DNS/i);
    expect(screen.getByTestId('org-domains-state-d3')).toHaveTextContent(/verified · DNS/i);
    expect(screen.getByTestId('org-domains-cleared-d4')).toHaveTextContent(/verified by another organization/i);
  });

  it('shows an empty state and the add form when the org has no domains', async () => {
    baseRoutes([]);
    render(<OrgDomainsTab orgId={ORG} />);
    expect(await screen.findByTestId('org-domains-empty')).toBeInTheDocument();
    expect(screen.getByTestId('org-domains-add-input')).toBeInTheDocument();
  });

  it('a 403 renders the governance notice, not an error toast', async () => {
    routeFetch(fetchWithAuthMock, {
      [`GET ${DOMAINS}`]: () => json({ error: 'Managing ticket configuration requires an admin role', code: 'ACCESS_DENIED' }, 403),
      [`GET ${ENTRA}`]: entraNone,
      [`GET ${GOOGLE}`]: () => json({ connected: false }),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    expect(await screen.findByTestId('org-domains-forbidden')).toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('a load failure offers a retry', async () => {
    let fail = true;
    routeFetch(fetchWithAuthMock, {
      [`GET ${DOMAINS}`]: () => (fail ? json({ error: 'boom' }, 500) : json({ data: [domainView()] })),
      [`GET ${ENTRA}`]: entraNone,
      [`GET ${GOOGLE}`]: () => json({ connected: false }),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    fail = true;
    fireEvent.click(await screen.findByTestId('org-domains-retry'));
    fail = false;
    fireEvent.click(await screen.findByTestId('org-domains-retry'));
    expect(await screen.findByTestId('org-domains-row-d1')).toBeInTheDocument();
  });

  it('Microsoft is disabled with a link to #portal when the org has no proven tenant', async () => {
    baseRoutes([domainView()]);
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-verify-d1'));
    await waitFor(() => expect(screen.getByTestId('domain-method-entra_tenant')).toBeDisabled());
    expect(screen.getByTestId('domain-method-unavailable-entra_tenant').querySelector('a')?.getAttribute('href')).toBe('#portal');
  });

  it('enables Microsoft and Google when the tenant is proven through the connection and Google is connected', async () => {
    baseRoutes([domainView()], { [`GET ${ENTRA}`]: entraProvenWithConnection, [`GET ${GOOGLE}`]: googleConnected });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-verify-d1'));
    await waitFor(() => expect(screen.getByTestId('domain-method-entra_tenant')).toBeEnabled());
    expect(screen.getByTestId('domain-method-google_directory')).toBeEnabled();
  });

  it('a tenant proven by proof run with no M365 connection cannot use Microsoft', async () => {
    baseRoutes([domainView()], {
      [`GET ${ENTRA}`]: () => json({ data: {
        tenantId: TENANT, state: 'proven', provenAt: '2026-11-01T00:00:00.000Z', provenVia: 'proof_run', connectionTenantId: null, consentUrl: null,
      } }),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-verify-d1'));
    await waitFor(() => expect(screen.getByTestId('domain-method-unavailable-entra_tenant')).toHaveTextContent(/Microsoft 365 connection/i));
  });

  it('Microsoft is unavailable when the deployment has no portal Entra app; Google when Workspace is off', async () => {
    baseRoutes([domainView()], {
      [`GET ${ENTRA}`]: () => json({ error: 'not configured', code: 'PORTAL_ENTRA_NOT_CONFIGURED' }, 404),
      [`GET ${GOOGLE}`]: () => json({ error: 'Google Workspace integration is not enabled' }, 404),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-verify-d1'));
    await waitFor(() => expect(screen.getByTestId('domain-method-entra_tenant')).toBeDisabled());
    expect(screen.getByTestId('domain-method-unavailable-entra_tenant')).toHaveTextContent(/not available on this server/i);
    expect(screen.getByTestId('domain-method-google_directory')).toBeDisabled();
    expect(screen.getByTestId('domain-method-unavailable-google_directory')).toHaveTextContent(/not enabled/i);
  });

  it('a tenant-status load failure leaves Microsoft enabled (the server check decides)', async () => {
    baseRoutes([domainView()], { [`GET ${ENTRA}`]: () => json({ error: 'boom' }, 500) });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-verify-d1'));
    await screen.findByTestId('domain-verification-panel');
    await waitFor(() => expect(callsTo(fetchWithAuthMock, 'GET', ENTRA)).toHaveLength(1));
    expect(screen.getByTestId('domain-method-entra_tenant')).toBeEnabled();
  });

  it('toggling active PATCHes isActive through the org route', async () => {
    baseRoutes([domainView()], {
      [`PATCH ${DOMAINS}/d1`]: () => json({ data: domainView({ isActive: false }) }),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-active-d1'));
    await waitFor(() => expect(callsTo(fetchWithAuthMock, 'PATCH', `${DOMAINS}/d1`)).toHaveLength(1));
    const [, init] = callsTo(fetchWithAuthMock, 'PATCH', `${DOMAINS}/d1`)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ isActive: false });
  });

  it('moving a verified domain asks for confirmation naming the verification loss', async () => {
    baseRoutes([verifiedDns()], {
      [`PATCH ${DOMAINS}/d1`]: () => json({ data: domainView({ orgId: OTHER_ORG }) }),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-move-d1'));
    const dialog = await screen.findByTestId('org-domains-move-dialog');
    expect(dialog).toHaveTextContent(/lose its verification/i);
    const select = await within(dialog).findByTestId('org-domains-move-target');
    // The current org is not a move target.
    expect(within(select).queryByText('Contoso')).toBeNull();
    expect(screen.getByTestId('org-domains-move-confirm')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(select, { target: { value: OTHER_ORG } });
    fireEvent.click(screen.getByTestId('org-domains-move-confirm'));
    await waitFor(() => expect(callsTo(fetchWithAuthMock, 'PATCH', `${DOMAINS}/d1`)).toHaveLength(1));
    const [, init] = callsTo(fetchWithAuthMock, 'PATCH', `${DOMAINS}/d1`)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ orgId: OTHER_ORG });
  });

  it('moving a declared domain does not warn about verification', async () => {
    baseRoutes([domainView()]);
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-move-d1'));
    const dialog = await screen.findByTestId('org-domains-move-dialog');
    expect(dialog).not.toHaveTextContent(/lose its verification/i);
  });

  it('delete asks for confirmation, then DELETEs and reloads', async () => {
    let rows = [domainView()];
    routeFetch(fetchWithAuthMock, {
      [`GET ${DOMAINS}`]: () => json({ data: rows }),
      [`GET ${ENTRA}`]: entraNone,
      [`GET ${GOOGLE}`]: () => json({ connected: false }),
      [`DELETE ${DOMAINS}/d1`]: () => { rows = []; return Promise.resolve(new Response(null, { status: 204 })); },
    });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-delete-d1'));
    expect(callsTo(fetchWithAuthMock, 'DELETE', `${DOMAINS}/d1`)).toHaveLength(0);
    fireEvent.click(await screen.findByTestId('org-domains-delete-confirm'));
    expect(await screen.findByTestId('org-domains-empty')).toBeInTheDocument();
    expect(callsTo(fetchWithAuthMock, 'DELETE', `${DOMAINS}/d1`)).toHaveLength(1);
  });

  it('a failed move keeps the dialog open and shows no success toast', async () => {
    baseRoutes([verifiedDns()], {
      [`PATCH ${DOMAINS}/d1`]: () => json({ error: 'conflict', code: 'SOMETHING' }, 409),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-move-d1'));
    const select = await screen.findByTestId('org-domains-move-target');
    await within(select).findByText('Fabrikam');
    fireEvent.change(select, { target: { value: OTHER_ORG } });
    fireEvent.click(screen.getByTestId('org-domains-move-confirm'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.getByTestId('org-domains-move-dialog')).toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(screen.getByTestId('org-domains-row-d1')).toBeInTheDocument();
  });

  it('a failed delete keeps the row and the dialog and toasts the error', async () => {
    baseRoutes([domainView()], { [`DELETE ${DOMAINS}/d1`]: () => json({ error: 'boom' }, 500) });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-delete-d1'));
    fireEvent.click(await screen.findByTestId('org-domains-delete-confirm'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.getByTestId('org-domains-delete-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('org-domains-row-d1')).toBeInTheDocument();
  });

  it('a 401 on the list goes to login', async () => {
    routeFetch(fetchWithAuthMock, {
      [`GET ${DOMAINS}`]: () => json({ error: 'unauthorized' }, 401),
      [`GET ${ENTRA}`]: entraNone,
      [`GET ${GOOGLE}`]: () => json({ connected: false }),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true }));
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('a refresh that fails after a successful mutation keeps the table and says it may be out of date', async () => {
    let listCalls = 0;
    routeFetch(fetchWithAuthMock, {
      [`GET ${DOMAINS}`]: () => (++listCalls === 1 ? json({ data: [domainView()] }) : json({ error: 'boom' }, 500)),
      [`GET ${ENTRA}`]: entraNone,
      [`GET ${GOOGLE}`]: () => json({ connected: false }),
      [`PATCH ${DOMAINS}/d1`]: () => json({ data: domainView({ isActive: false }) }),
    });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-active-d1'));
    expect(await screen.findByTestId('org-domains-stale')).toBeInTheDocument();
    expect(screen.getByTestId('org-domains-row-d1')).toBeInTheDocument();
  });

  it('a row with an unknown state or method still renders (as declared); a malformed row is dropped, not the list', async () => {
    baseRoutes([
      domainView({ id: 'd1', domain: 'contoso.com' }),
      { ...domainView({ id: 'd2', domain: 'contoso.org' }), state: 'quarantined', method: 'carrier_pigeon' },
      { id: 'd3' },
    ]);
    render(<OrgDomainsTab orgId={ORG} />);
    expect(await screen.findByTestId('org-domains-state-d2')).toHaveTextContent(/declared — mail routing only/i);
    expect(screen.getByTestId('org-domains-row-d1')).toBeInTheDocument();
    expect(screen.queryByTestId('org-domains-row-d3')).toBeNull();
  });

  it('a Google connection body without an explicit connected:false leaves Google enabled', async () => {
    baseRoutes([domainView()], { [`GET ${GOOGLE}`]: () => json({ status: 'active' }) });
    render(<OrgDomainsTab orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('org-domains-verify-d1'));
    await waitFor(() => expect(callsTo(fetchWithAuthMock, 'GET', GOOGLE)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('domain-method-google_directory')).toBeEnabled();
  });
});
