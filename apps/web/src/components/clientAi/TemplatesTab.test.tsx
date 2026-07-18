import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TemplatesTab from './TemplatesTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

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
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({ data: [{ orgId: ORG_ID, orgName: 'Contoso Accounting' }] });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('TemplatesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
