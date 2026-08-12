import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TenantVariablesPage from './TenantVariablesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const scopeState = { isPartnerScope: true, orgId: 'org-a' as string | null };
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({
    isPartnerScope: scopeState.isPartnerScope,
    defaultOwnerScope: scopeState.isPartnerScope ? 'partner' : 'organization'
  })
}));
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => ({
    ready: true,
    status: 'resolved',
    scope: scopeState.orgId ? 'org' : 'all',
    orgId: scopeState.orgId,
    org: null,
    error: null
  })
}));

const fetchMock = vi.mocked(fetchWithAuth);
const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG_VAR = {
  id: 'v-1',
  key: 'syslog_host',
  value: 'logs.example.net',
  isSecret: false,
  description: 'Collector address',
  ownerScope: 'organization' as const,
  orgId: 'org-a',
  partnerId: null,
  version: 1,
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T00:00:00.000Z'
};

const SECRET_VAR = {
  ...ORG_VAR,
  id: 'v-2',
  key: 's1_site_token',
  value: null,
  isSecret: true,
  description: 'SentinelOne site token',
  ownerScope: 'partner' as const,
  orgId: null,
  partnerId: 'p-1'
};

beforeEach(() => {
  vi.clearAllMocks();
  scopeState.isPartnerScope = true;
  scopeState.orgId = 'org-a';
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/tenant-variables' && (!init || !init.method)) {
      return makeJsonResponse({ data: [ORG_VAR, SECRET_VAR] });
    }
    if (url === '/tenant-variables' && init?.method === 'POST') {
      return makeJsonResponse({ data: { ...ORG_VAR, id: 'v-3' } }, true, 201);
    }
    if (url.startsWith('/tenant-variables/') && init?.method === 'PUT') {
      return makeJsonResponse({ data: ORG_VAR });
    }
    if (url.startsWith('/tenant-variables/') && init?.method === 'DELETE') {
      return makeJsonResponse({ success: true });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
});

describe('TenantVariablesPage', () => {
  it('lists variables and badges the partner-wide row', async () => {
    render(<TenantVariablesPage />);
    expect(await screen.findByTestId('tenant-variable-row-syslog_host')).toBeTruthy();
    const partnerRow = screen.getByTestId('tenant-variable-row-s1_site_token');
    expect(partnerRow.textContent).toContain('All organizations');
  });

  it('masks a secret and never renders its value', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-s1_site_token');
    const row = screen.getByTestId('tenant-variable-row-s1_site_token');
    expect(row.querySelector('[data-testid="tenant-variable-secret-mask"]')).toBeTruthy();
    expect(screen.getByTestId('tenant-variable-row-syslog_host').textContent).toContain('logs.example.net');
  });

  it('creates a partner-wide variable with the ownerScope in the body', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    fireEvent.click(screen.getByTestId('tenant-variable-owner-partner'));
    fireEvent.change(screen.getByTestId('tenant-variable-key-input'), { target: { value: 's1_site_token' } });
    fireEvent.change(screen.getByTestId('tenant-variable-value-input'), { target: { value: 'tok-123' } });
    fireEvent.click(screen.getByTestId('tenant-variable-secret-toggle'));
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
        ownerScope: 'partner',
        key: 's1_site_token',
        value: 'tok-123',
        isSecret: true
      });
    });
  });

  it('sends the selected orgId when creating an org-scoped variable', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    fireEvent.click(screen.getByTestId('tenant-variable-owner-org'));
    fireEvent.change(screen.getByTestId('tenant-variable-key-input'), { target: { value: 'repo_url' } });
    fireEvent.change(screen.getByTestId('tenant-variable-value-input'), { target: { value: 'https://pkg' } });
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({
        ownerScope: 'organization',
        orgId: 'org-a'
      });
    });
  });

  it('hides the scope selector for an org-scoped session', async () => {
    scopeState.isPartnerScope = false;
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');
    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    expect(screen.queryByTestId('tenant-variable-owner-scope')).toBeNull();
  });

  it('hides edit and delete on an inherited partner-wide row for an org-scoped session', async () => {
    scopeState.isPartnerScope = false;
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-s1_site_token');
    expect(screen.queryByTestId('tenant-variable-edit-s1_site_token')).toBeNull();
    expect(screen.queryByTestId('tenant-variable-delete-s1_site_token')).toBeNull();
    // ...but its own org row stays editable.
    expect(screen.getByTestId('tenant-variable-edit-syslog_host')).toBeTruthy();
  });

  it('rejects an invalid key before issuing a request', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    fireEvent.change(screen.getByTestId('tenant-variable-key-input'), { target: { value: 'Not A Key' } });
    fireEvent.change(screen.getByTestId('tenant-variable-value-input'), { target: { value: 'v' } });
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    expect(await screen.findByTestId('tenant-variable-issues')).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('omits value on edit when the field is left blank, so a secret is not clobbered', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-s1_site_token');

    fireEvent.click(screen.getByTestId('tenant-variable-edit-s1_site_token'));
    expect((screen.getByTestId('tenant-variable-value-input') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByTestId('tenant-variable-description-input'), { target: { value: 'rotated Q3' } });
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body).not.toHaveProperty('value');
      expect(body).toMatchObject({ description: 'rotated Q3' });
    });
  });

  it('blocks un-secreting without a replacement value', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-s1_site_token');

    fireEvent.click(screen.getByTestId('tenant-variable-edit-s1_site_token'));
    fireEvent.click(screen.getByTestId('tenant-variable-secret-toggle'));
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    expect(await screen.findByTestId('tenant-variable-issues')).toBeTruthy();
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('requires a second click to delete, then issues the DELETE', async () => {
    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-delete-syslog_host'));
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByTestId('tenant-variable-delete-syslog_host'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
    });
  });

  it('surfaces a failed save as an error toast', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tenant-variables' && (!init || !init.method)) return makeJsonResponse({ data: [ORG_VAR] });
      return makeJsonResponse({ error: 'A variable named "repo_url" already exists in this scope' }, false, 409);
    });

    render(<TenantVariablesPage />);
    await screen.findByTestId('tenant-variable-row-syslog_host');

    fireEvent.click(screen.getByTestId('tenant-variable-create-button'));
    fireEvent.change(screen.getByTestId('tenant-variable-key-input'), { target: { value: 'repo_url' } });
    fireEvent.change(screen.getByTestId('tenant-variable-value-input'), { target: { value: 'https://pkg' } });
    fireEvent.click(screen.getByTestId('tenant-variable-save'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    // The editor stays open so the tech can fix the key.
    expect(screen.getByTestId('tenant-variable-editor')).toBeTruthy();
  });
});
