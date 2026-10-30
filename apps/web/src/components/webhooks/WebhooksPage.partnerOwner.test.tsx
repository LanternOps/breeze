import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '../../lib/i18n';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, type User } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import WebhookForm from './WebhookForm';
import WebhookList from './WebhookList';
import WebhookDeliveryHistory, { normalizeDelivery } from './WebhookDeliveryHistory';
import WebhooksPage from './WebhooksPage';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('../../stores/auth', async importOriginal => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

function session(scope: string, canManagePartnerWide: boolean | undefined = true) {
  useAuthStore.setState({
    user: { id: 'user-1', name: 'Admin', email: 'admin@example.com', mfaEnabled: false, canManagePartnerWide } as User,
    tokens: { accessToken: `header.${btoa(JSON.stringify({ scope, partnerId: 'partner-1' }))}.signature`, expiresInSeconds: 3600 },
  });
}
const row = { id: 'hook-1', name: 'Partner relay', url: 'https://hooks.example.com/in', events: ['device.online'], status: 'active' as const, partnerId: 'partner-1', orgId: null, hasSecret: true };
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
function serve(rows: unknown[] = []) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return json(row);
    if (url.includes('/deliveries')) return json({ data: [] });
    return json({ data: rows });
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  window.location.hash = '';
  useOrgStore.setState({ currentOrgId: 'org-selected' });
  session('partner');
});
afterEach(() => { cleanup(); useAuthStore.setState({ user: null, tokens: null }); });

describe('partner webhook ownership', () => {
  it('shows the ownership selector to a partner-wide administrator creating a webhook', () => {
    render(<WebhookForm />);
    expect(screen.getByTestId('webhook-owner')).toBeInTheDocument();
    expect(screen.getByTestId('webhook-owner-partner')).toHaveAccessibleName('All organizations');
    expect(screen.getByTestId('webhook-owner-org')).toHaveAccessibleName('This organization only');
  });

  it.each([
    ['organization', true], ['partner', false], ['partner', undefined], ['system', true],
  ])('hides the selector for scope %s and capability %s', (scope, capable) => {
    session(scope as string, capable as boolean | undefined);
    // Avoid the helper's default when exercising an older session without the capability.
    if (capable === undefined) useAuthStore.setState({ user: { ...useAuthStore.getState().user!, canManagePartnerWide: undefined } });
    render(<WebhookForm />);
    expect(screen.queryByTestId('webhook-owner')).not.toBeInTheDocument();
  });

  it('does not offer ownership changes when editing', async () => {
    serve([row]);
    render(<WebhooksPage />);
    fireEvent.click((await screen.findAllByTitle('Edit webhook'))[0]!);
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    expect(screen.queryByTestId('webhook-owner')).not.toBeInTheDocument();
  });

  it('marks partner rows and filters by their ownership', () => {
    render(<WebhookList webhooks={[row, { ...row, id: 'hook-2', name: 'Org relay', partnerId: null, orgId: 'org-1' }]} />);
    expect(screen.getByTestId('webhook-partner-badge')).toHaveTextContent('All organizations');
    fireEvent.change(screen.getByRole('combobox', { name: 'Ownership' }), { target: { value: 'partner' } });
    expect(screen.getByText('Partner relay')).toBeInTheDocument();
    expect(screen.queryByText('Org relay')).not.toBeInTheDocument();
  });

  it('creates a partner webhook without the selected organization in the body', async () => {
    serve();
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New Webhook' }));
    fireEvent.click(screen.getByTestId('webhook-owner-partner'));
    fireEvent.change(document.getElementById('webhook-name')!, { target: { value: 'Partner relay' } });
    fireEvent.change(document.getElementById('webhook-url')!, { target: { value: row.url } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Device Online/ }));
    fireEvent.change(document.getElementById('webhook-secret')!, { target: { value: 'signing-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Webhook' }));
    await waitFor(() => expect(fetchWithAuth.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const [, init] = fetchWithAuth.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(init.body)).toMatchObject({ ownerScope: 'partner', payloadVersion: 2 });
    expect(JSON.parse(init.body)).not.toHaveProperty('orgId');
  });

  it('keeps selected-org injection enabled when listing and filtering partner webhooks', async () => {
    serve([row]);
    render(<WebhooksPage />);
    await screen.findByText('Partner relay', { selector: 'td' });
    expect(fetchWithAuth).toHaveBeenCalledWith('/webhooks');
    fireEvent.change(screen.getByRole('combobox', { name: 'Ownership' }), { target: { value: 'partner' } });
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/webhooks?ownerScope=partner'));
    expect(window.location.hash).toBe('#webhooks?ownerScope=partner');
  });

  it('shows the delivery organization and labels null organizations as test sends', () => {
    render(<WebhookDeliveryHistory showOrganization deliveries={[
      normalizeDelivery({ id: 'delivery-1', orgId: 'org-event', eventType: 'alert.triggered', status: 'delivered' }),
      normalizeDelivery({ id: 'delivery-2', orgId: null, eventType: 'alert.triggered', status: 'delivered' }),
    ]} />);
    expect(screen.getByRole('columnheader', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByText('org-event')).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();
  });
});
