import '@/lib/i18n';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth, useAuthStore } from '@/stores/auth';
import { useOrgStore } from '@/stores/orgStore';
import { useCustomFieldDefinitionsStore } from '@/stores/customFieldDefinitions';
import { i18n } from '@/lib/i18n';

vi.mock('@/stores/auth', async (importOriginal) => ({ ...await importOriginal<typeof import('@/stores/auth')>(), fetchWithAuth: vi.fn() }));
vi.mock('@/hooks/useFilterPreview', () => ({ useFilterPreview: () => ({ preview: null, loading: false, error: null, refresh: vi.fn() }) }));
const mockFetch = vi.mocked(fetchWithAuth);
const filter = { operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: 'web' }] };
const partner = { id: 'partner-group', name: 'Partner servers', ownerScope: 'partner', orgId: null, type: 'dynamic', deviceCount: 1, filterConditions: filter, evaluation: { state: 'current', evaluatedAt: '2026-10-01T12:00:00Z', failedOrgs: 0 } };
const organization = { id: 'org-group', name: 'Organization servers', ownerScope: 'organization', type: 'static', deviceCount: 0 };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
function auth(scope = 'partner', canManagePartnerWide = true) {
  useAuthStore.setState({ user: { canManagePartnerWide } as never, tokens: { accessToken: `x.${btoa(JSON.stringify({ scope, partnerId: 'partner-1' }))}.x` } as never });
}
function serve(groups: unknown[] = [partner, organization], failEdit = false) {
  mockFetch.mockImplementation(async (url, options) => {
    const path = url.split('?')[0];
    if (options?.method === 'PATCH') return failEdit ? response({ code: 'PARTNER_GROUP_FILTER_UNSUPPORTED', error: 'raw failure' }, 400) : response({ data: partner });
    if (options?.method === 'POST') return response({ data: { id: 'new-group' } });
    if (path === '/device-groups') return response({ data: groups });
    if (path.endsWith('/devices') && path.startsWith('/device-groups/')) return response({ data: [{ deviceId: 'device-1', orgId: 'org-1', hostname: 'web-1', displayName: 'Web server', status: 'online' }] });
    return response({ data: [], total: 0 });
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/devices/groups');
  auth();
  useOrgStore.setState({ currentOrgId: 'org-1', allOrgs: false, organizationsLoaded: true, organizations: [{ id: 'org-1', partnerId: 'partner-1', name: 'Customer One' } as never] });
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'loaded' as never });
});

describe('partner device groups', () => {
  it('fetches all owners and renders evaluation, badge, and organization-aware members', async () => {
    serve(); render(<DeviceGroupsPage />);
    expect(await screen.findByTestId('group-owner-badge-partner-group')).toHaveTextContent('All orgs');
    expect(mockFetch).toHaveBeenCalledWith('/device-groups?includeMemberships=true&ownerScope=all');
    expect(screen.getByTestId('group-evaluation-partner-group')).toHaveTextContent('Last evaluated');
    await userEvent.click(screen.getByTestId('partner-group-members-toggle-partner-group'));
    const table = await screen.findByTestId('partner-group-members-partner-group');
    expect(within(table).getByText('Organization')).toBeInTheDocument();
    expect(await within(table).findByText('Customer One')).toBeInTheDocument();
  });
  it.each(['pending', 'partial'])('shows %s evaluation status', async (state) => {
    serve([{ ...partner, evaluation: { ...partner.evaluation, state, failedOrgs: 2 } }]); render(<DeviceGroupsPage />);
    const status = await screen.findByTestId('group-evaluation-partner-group');
    expect(status).toHaveTextContent(state === 'pending' ? 'Updating membership' : '2 orgs not evaluated');
    if (state === 'partial') expect(status).toHaveTextContent('Breeze retries these organizations automatically.');
  });
  it('filters visible groups, preserves other hash keys and selects only visible groups', async () => {
    window.history.replaceState(null, '', '#other=keep'); serve(); render(<DeviceGroupsPage />);
    await screen.findByText('Organization servers');
    await userEvent.click(screen.getByTestId('group-owner-filter-partner'));
    expect(screen.queryByText('Organization servers')).not.toBeInTheDocument();
    expect(window.location.hash).toContain('owner=partner'); expect(window.location.hash).toContain('other=keep');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all groups' }));
    expect(screen.getByRole('checkbox', { name: 'Select group Partner servers' })).toBeChecked();
    await userEvent.click(screen.getByTestId('group-owner-filter-organization'));
    expect(screen.getByRole('checkbox', { name: 'Select group Organization servers' })).not.toBeChecked();
  });
  it('reads the owner filter from the hash on mount', async () => {
    window.history.replaceState(null, '', '#owner=partner'); serve(); render(<DeviceGroupsPage />);
    await screen.findByText('Partner servers'); expect(screen.queryByText('Organization servers')).not.toBeInTheDocument();
  });
  it('allows partner admins to edit and delete', async () => {
    serve([partner]); render(<DeviceGroupsPage />); await screen.findByText('Partner servers');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
  it('lets an organization viewer clear a hash owner filter with no partner groups', async () => {
    auth('organization'); window.history.replaceState(null, '', '#owner=partner');
    serve([organization]); render(<DeviceGroupsPage />);
    expect(await screen.findByTestId('group-owner-filter-partner')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Organization servers')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('group-owner-filter-all'));
    expect(await screen.findByText('Organization servers')).toBeInTheDocument();
    expect(window.location.hash).not.toContain('owner=partner');
  });
  it('edits a partner group with only its name, dynamic type, and filter', async () => {
    serve([partner]); render(<DeviceGroupsPage />); await screen.findByText('Partner servers');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const name = screen.getByPlaceholderText('e.g. Production Linux');
    await userEvent.clear(name); await userEvent.type(name, 'Renamed partner servers');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([, opts]) => opts?.method === 'PATCH')).toBe(true));
    const call = mockFetch.mock.calls.find(([, opts]) => opts?.method === 'PATCH')!;
    expect(call[0]).toBe('/device-groups/partner-group');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ name: 'Renamed partner servers', type: 'dynamic', filterConditions: filter });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument());
  });
  it('hides partner writes for restricted partners', async () => {
    auth('partner', false); serve([partner]); render(<DeviceGroupsPage />); await screen.findByText('Partner servers');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
  it('shows the provider note and hides rules and write actions for redacted org viewers', async () => {
    auth('organization'); serve([{ ...partner, filterConditions: null, evaluation: null }]); render(<DeviceGroupsPage />);
    expect(await screen.findByTestId('group-managed-by-partner-partner-group')).toHaveTextContent('Managed by your service provider');
    expect(screen.queryByText('Auto membership rules')).not.toBeInTheDocument();
    expect(screen.queryByText(/Group assignment:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
  it('creates a dynamic partner group without requiring a fleet organization', async () => {
    useOrgStore.setState({ currentOrgId: null, allOrgs: true }); serve(); render(<DeviceGroupsPage />); await screen.findByText('Partner servers');
    await userEvent.click(screen.getByRole('button', { name: 'Create Group' }));
    await userEvent.click(screen.getByTestId('group-owner-scope-partner'));
    await userEvent.type(screen.getByPlaceholderText('e.g. Production Linux'), 'All web servers');
    await userEvent.type(screen.getByTestId('value-text-input'), 'web');
    await userEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(mockFetch.mock.calls.some(([url, opts]) => url === '/device-groups' && opts?.method === 'POST')).toBe(true));
    const call = mockFetch.mock.calls.find(([url, opts]) => url === '/device-groups' && opts?.method === 'POST')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ ownerScope: 'partner', name: 'All web servers', type: 'dynamic', filterConditions: filter });
  });
  it('deletes a partner group without a reassignment target', async () => {
    serve([partner]); render(<DeviceGroupsPage />); await screen.findByText('Partner servers');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('This removes the group from every organization and deletes its policy assignments.')).toBeInTheDocument();
    expect(screen.queryByText('Reassign devices (optional)')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete group' }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith('/device-groups/partner-group', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ reassignGroupId: null }) })));
  });
  it('blocks a nested refused filter before sending an edit', async () => {
    serve([{ ...partner, filterConditions: { operator: 'AND', conditions: [{ operator: 'OR', conditions: [{ field: 'orgId', operator: 'equals', value: 'org-1' }] }] } }]);
    render(<DeviceGroupsPage />); await screen.findByText('Partner servers');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(i18n.t('errors:PARTNER_GROUP_FILTER_UNSUPPORTED'))).toBeInTheDocument();
    expect(mockFetch.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
  });
  it('keeps legacy org groups static when edited from a partner all-orgs view', async () => {
    useOrgStore.setState({ currentOrgId: null, allOrgs: true });
    serve([{ ...organization, ownerScope: undefined }]); render(<DeviceGroupsPage />); await screen.findByText('Organization servers');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Static' })).toBeInTheDocument();
    expect(screen.queryByTestId('group-owner-scope')).not.toBeInTheDocument();
  });
  it('shows the localized API error when partner edit fails', async () => {
    serve([partner], true); render(<DeviceGroupsPage />); await screen.findByText('Partner servers');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(i18n.t('errors:PARTNER_GROUP_FILTER_UNSUPPORTED'))).toBeInTheDocument();
  });
});
