import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TemplatesTab from './TemplatesTab';
import { fetchWithAuth } from '../../stores/auth';

const grants = vi.hoisted(() => ({
  current: [] as { resource: string; action: string }[],
  accessToken: null as string | null,
  canManagePartnerWide: undefined as boolean | undefined,
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({
      user: { permissions: grants.current, canManagePartnerWide: grants.canManagePartnerWide },
      tokens: grants.accessToken ? { accessToken: grants.accessToken } : null,
    }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: unknown) => unknown) =>
    selector({ organizations: [{ id: '0c0c0c0c-1111-4222-8333-444455556666', name: 'Contoso Accounting' }] }),
}));

/** Unsigned JWT carrying only the claims the UI decodes. */
function tokenFor(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

const READ_GRANT = { resource: 'client_ai_templates', action: 'read' };
const WRITE_GRANT = { resource: 'client_ai_templates', action: 'write' };

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PARTNER_ID = 'f0f0f0f0-1111-4222-8333-444455556666';
const TEMPLATE_ID = '7e7e7e7e-1111-4222-8333-444455556666';
const ORG_TEMPLATE_ID = '8f8f8f8f-1111-4222-8333-444455556666';

const PARTNER_ROW = {
  id: TEMPLATE_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  orgName: null,
  name: 'Quarterly variance walkthrough',
  description: 'Explains variance between columns',
  promptBody: 'Explain the variance between the selected columns.',
  category: 'finance',
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const ORG_ROW = {
  ...PARTNER_ROW,
  id: ORG_TEMPLATE_ID,
  orgId: ORG_ID,
  partnerId: null,
  orgName: 'Contoso Accounting',
  name: 'Contoso month-end checklist',
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/templates' && !init?.method) {
      return makeJsonResponse({ data: [PARTNER_ROW, ORG_ROW] });
    }
    if (url === '/client-ai/admin/templates' && init?.method === 'POST') {
      return makeJsonResponse({ template: { ...PARTNER_ROW, id: 'new-id' } }, true, 201);
    }
    if (url === `/client-ai/admin/templates/${TEMPLATE_ID}` && init?.method === 'PUT') {
      return makeJsonResponse({ template: { ...PARTNER_ROW, name: 'Renamed' } });
    }
    if (url === `/client-ai/admin/templates/${TEMPLATE_ID}` && init?.method === 'DELETE') {
      return makeJsonResponse({ success: true });
    }
    if (url === '/client-ai/admin/templates/org-options' && !init?.method) {
      return makeJsonResponse({ data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }] });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('TemplatesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grants.current = [READ_GRANT, WRITE_GRANT];
    grants.accessToken = null;
    grants.canManagePartnerWide = undefined;
  });

  it('renders scope badges: Partner-wide for partner-owned, org name for org-scoped', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-template-row-${TEMPLATE_ID}`)).toBeInTheDocument()
    );
    expect(screen.getByTestId('ai-office-template-scope-partner').textContent).toBe('Partner-wide');
    expect(screen.getByTestId('ai-office-template-scope-org').textContent).toBe('Contoso Accounting');
  });

  it('creates a partner-wide template (exact POST payload)', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() => expect(screen.getByTestId('ai-office-template-create')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-template-create'));
    fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'New' } });
    fireEvent.change(screen.getByTestId('ai-office-template-body'), { target: { value: 'Body' } });
    // Scope select defaults to 'partner' — leave it.
    fireEvent.click(screen.getByTestId('ai-office-template-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    );
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(String(postCall![0])).toBe('/client-ai/admin/templates');
    expect(JSON.parse(String(postCall![1]!.body))).toEqual({
      name: 'New',
      description: null,
      promptBody: 'Body',
      category: null,
      hosts: [], // no apps checked ⇒ all apps (server canonicalizes to null)
      orgId: null,
    });
  });

  it('creates a template targeting selected apps (hosts in POST payload)', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() => expect(screen.getByTestId('ai-office-template-create')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-template-create'));
    fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'Deck polish' } });
    fireEvent.change(screen.getByTestId('ai-office-template-body'), { target: { value: 'Body' } });
    fireEvent.click(screen.getByTestId('ai-office-template-host-powerpoint'));
    fireEvent.click(screen.getByTestId('ai-office-template-host-word'));
    fireEvent.click(screen.getByTestId('ai-office-template-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    );
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const body = JSON.parse(String(postCall![1]!.body));
    expect(body.hosts).toEqual(['powerpoint', 'word']);
  });

  it('creates an org-scoped template when an org is chosen', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() => expect(screen.getByTestId('ai-office-template-create')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-template-create'));
    fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'Org one' } });
    fireEvent.change(screen.getByTestId('ai-office-template-body'), { target: { value: 'Body' } });
    await waitFor(() =>
      expect(
        (screen.getByTestId('ai-office-template-scope') as HTMLSelectElement).options.length
      ).toBeGreaterThan(1)
    );
    fireEvent.change(screen.getByTestId('ai-office-template-scope'), { target: { value: ORG_ID } });
    fireEvent.click(screen.getByTestId('ai-office-template-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    );
    const body = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body)
    );
    expect(body.orgId).toBe(ORG_ID);
  });

  it('edits without an orgId key (scope is immutable) and the scope select is disabled', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-template-edit-${TEMPLATE_ID}`)).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId(`ai-office-template-edit-${TEMPLATE_ID}`));
    expect((screen.getByTestId('ai-office-template-scope') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('ai-office-template-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(putCall![0])).toBe(`/client-ai/admin/templates/${TEMPLATE_ID}`);
    const body = JSON.parse(String(putCall![1]!.body));
    expect(body).not.toHaveProperty('orgId');
    expect(body.name).toBe('Renamed');
  });

  it('deletes through the confirm dialog', async () => {
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-template-delete-${TEMPLATE_ID}`)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId(`ai-office-template-delete-${TEMPLATE_ID}`));
    fireEvent.click(screen.getByTestId('ai-office-template-delete-confirm'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    );
    const delCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(String(delCall![0])).toBe(`/client-ai/admin/templates/${TEMPLATE_ID}`);
  });

  it('hides create, edit and delete for a read-only holder and skips the org lookup', async () => {
    grants.current = [READ_GRANT];
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() =>
      expect(screen.getByTestId(`ai-office-template-row-${TEMPLATE_ID}`)).toBeInTheDocument()
    );
    expect(screen.queryByTestId('ai-office-template-create')).toBeNull();
    expect(screen.queryByTestId(`ai-office-template-edit-${TEMPLATE_ID}`)).toBeNull();
    expect(screen.queryByTestId(`ai-office-template-delete-${TEMPLATE_ID}`)).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/client-ai/admin/templates/org-options')
    ).toBe(false);
  });

  it('shows the write controls to the wildcard grant', async () => {
    grants.current = [{ resource: '*', action: '*' }];
    mockApi();
    render(<TemplatesTab />);
    await waitFor(() => expect(screen.getByTestId('ai-office-template-create')).toBeInTheDocument());
    expect(screen.getByTestId(`ai-office-template-edit-${TEMPLATE_ID}`)).toBeInTheDocument();
  });

  it('surfaces a 403 MFA_REQUIRED on save through the shared MFA message and keeps the dialog open', async () => {
    mockApi();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/client-ai/admin/templates' && init?.method === 'POST') {
        return makeJsonResponse({ error: 'MFA required', code: 'MFA_REQUIRED' }, false, 403);
      }
      return base(input, init);
    });
    render(<TemplatesTab />);
    await waitFor(() => expect(screen.getByTestId('ai-office-template-create')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-office-template-create'));
    fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'New' } });
    fireEvent.change(screen.getByTestId('ai-office-template-body'), { target: { value: 'Body' } });
    fireEvent.click(screen.getByTestId('ai-office-template-save'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Multi-factor authentication is required' })
      )
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ai-office-template-save')).toBeInTheDocument();
  });

  describe('create-dialog scope options', () => {
    const scopeOptions = () =>
      Array.from((screen.getByTestId('ai-office-template-scope') as HTMLSelectElement).options).map(
        (o) => o.value
      );

    async function openCreate() {
      render(<TemplatesTab />);
      await waitFor(() => expect(screen.getByTestId('ai-office-template-create')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-office-template-create'));
    }

    it('loads the org list from the templates org-options endpoint, not the org status list', async () => {
      mockApi();
      await openCreate();
      await waitFor(() => expect(scopeOptions()).toEqual(['partner', ORG_ID]));
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/client-ai/admin/orgs')).toBe(false);
    });

    it("falls back to the caller's own org when the org lookup is denied", async () => {
      grants.accessToken = tokenFor({ scope: 'organization', orgId: ORG_ID });
      mockApi();
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        if (String(input) === '/client-ai/admin/templates/org-options') {
          return makeJsonResponse({ error: 'Permission denied' }, false, 403);
        }
        return base(input, init);
      });
      await openCreate();
      await waitFor(() => expect(scopeOptions()).toEqual([ORG_ID]));
      expect(screen.getByRole('option', { name: 'Contoso Accounting' })).toBeInTheDocument();
    });

    it('does not offer partner-wide to an organization-scoped session and creates in its org', async () => {
      grants.accessToken = tokenFor({ scope: 'organization', orgId: ORG_ID });
      mockApi();
      await openCreate();
      await waitFor(() => expect(scopeOptions()).toEqual([ORG_ID]));
      fireEvent.change(screen.getByTestId('ai-office-template-name'), { target: { value: 'Mine' } });
      fireEvent.change(screen.getByTestId('ai-office-template-body'), { target: { value: 'Body' } });
      fireEvent.click(screen.getByTestId('ai-office-template-save'));
      await waitFor(() =>
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
      );
      const body = JSON.parse(
        String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body)
      );
      expect(body.orgId).toBe(ORG_ID);
    });

    it('does not offer partner-wide to a partner user who cannot manage partner-wide state', async () => {
      grants.accessToken = tokenFor({ scope: 'partner', partnerId: PARTNER_ID });
      grants.canManagePartnerWide = false;
      mockApi();
      await openCreate();
      await waitFor(() => expect(scopeOptions()).toEqual([ORG_ID]));
    });
  });
});
