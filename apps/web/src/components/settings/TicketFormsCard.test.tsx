import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TicketFormsCard from './TicketFormsCard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const FORM = {
  id: 'f-1',
  orgId: null,
  partnerId: 'p-1',
  name: 'Onboarding',
  description: null,
  categoryId: null,
  fields: [{ key: 'affected_user', label: 'Affected user', type: 'text', required: true }],
  titleTemplate: null,
  descriptionIntro: null,
  defaultPriority: null,
  defaultTags: [],
  showInPortal: true,
  isActive: true,
  sortOrder: 0,
  version: 1
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [FORM] });
    if (url === '/ticket-forms' && init?.method === 'POST')
      return makeJsonResponse({ data: { ...FORM, id: 'f-2', name: 'Offboarding' } });
    if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }] });
    if (url === '/ticket-categories') return makeJsonResponse({ data: [{ id: 'cat-1', name: 'Hardware', isActive: true }] });
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
});

describe('TicketFormsCard', () => {
  it('lists forms with a Partner-wide badge for partner-wide rows', async () => {
    render(<TicketFormsCard />);
    expect(await screen.findByTestId('ticket-form-row-f-1')).toBeTruthy();
    expect(screen.getByTestId('ticket-form-row-f-1').textContent).toContain('Partner-wide');
  });

  it('opens the editor, adds a field, and creates a partner-wide form', async () => {
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-create'));
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Offboarding' } });
    fireEvent.click(screen.getByTestId('ticket-form-owner-partner'));
    fireEvent.click(screen.getByTestId('ticket-form-field-add'));
    fireEvent.change(screen.getByTestId('ticket-form-field-label-0'), { target: { value: 'Affected user' } });
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms' && (i as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.ownerScope).toBe('partner');
      expect(body.fields[0].key).toBe('affected_user');
    });
  });

  it('derives read-only field keys from the label, uniquified on collision', async () => {
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-create'));
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Dup keys' } });
    fireEvent.click(screen.getByTestId('ticket-form-field-add'));
    fireEvent.change(screen.getByTestId('ticket-form-field-label-0'), { target: { value: 'Serial number' } });
    fireEvent.click(screen.getByTestId('ticket-form-field-add'));
    fireEvent.change(screen.getByTestId('ticket-form-field-label-1'), { target: { value: 'Serial number' } });
    expect(screen.getByTestId('ticket-form-field-key-0').textContent).toContain('serial_number');
    expect(screen.getByTestId('ticket-form-field-key-1').textContent).toContain('serial_number_2');
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms' && (i as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.fields.map((f: { key: string }) => f.key)).toEqual(['serial_number', 'serial_number_2']);
    });
  });

  it('updates an existing form via PUT with no ownerScope/orgId, sending explicit nulls for cleared optionals', async () => {
    // Previously-set optionals: clearing them must send explicit null — the
    // update schema is .partial(), so an omitted key silently keeps the old value.
    const filledForm = {
      ...FORM,
      description: 'Old description',
      categoryId: 'cat-1',
      titleTemplate: 'Old {{affected_user}}',
      descriptionIntro: 'Old intro',
      defaultPriority: 'high'
    };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [filledForm] });
      if (url === '/ticket-forms/f-1' && init?.method === 'PUT') return makeJsonResponse({ data: FORM });
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [{ id: 'cat-1', name: 'Hardware', isActive: true }] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-edit-f-1'));
    // Ownership fieldset is create-only — hidden when editing.
    expect(screen.queryByTestId('ticket-form-owner-partner')).toBeNull();
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Onboarding v2' } });
    // Clear every previously-set optional.
    fireEvent.change(screen.getByTestId('ticket-form-description'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('ticket-form-category'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('ticket-form-title-template'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('ticket-form-description-intro'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('ticket-form-priority'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms/f-1' && (i as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.name).toBe('Onboarding v2');
      expect(body).not.toHaveProperty('ownerScope');
      expect(body).not.toHaveProperty('orgId');
      expect(body.description).toBeNull();
      expect(body.categoryId).toBeNull();
      expect(body.titleTemplate).toBeNull();
      expect(body.descriptionIntro).toBeNull();
      expect(body.defaultPriority).toBeNull();
    });
  });

  it('create omits empty optionals from the POST body (no nulls on create)', async () => {
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-create'));
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Bare' } });
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms' && (i as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body).not.toHaveProperty('description');
      expect(body).not.toHaveProperty('titleTemplate');
      expect(body).not.toHaveProperty('descriptionIntro');
      expect(body).not.toHaveProperty('defaultPriority');
      expect(body).not.toHaveProperty('categoryId');
    });
  });

  it('renders an inline retry state when the list load fails', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/ticket-forms') return makeJsonResponse({ error: 'boom' }, false, 500);
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-forms-error');
    // Recover on retry.
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/ticket-forms') return makeJsonResponse({ data: [FORM] });
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    fireEvent.click(screen.getByTestId('ticket-forms-retry'));
    expect(await screen.findByTestId('ticket-form-row-f-1')).toBeTruthy();
  });

  it('degrades (not hard-fails) when the orgs fetch REJECTS, and shows an inline org-load notice in the scope fieldset', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [FORM] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [{ id: 'cat-1', name: 'Hardware', isActive: true }] });
      if (url === '/orgs/organizations?limit=100') throw new Error('network down');
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    // Card still renders the forms list despite the orgs fetch rejecting.
    expect(await screen.findByTestId('ticket-form-row-f-1')).toBeTruthy();
    expect(screen.queryByTestId('ticket-forms-error')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    // Open editor, choose org scope → inline org-load notice appears (no misleading "select an org").
    fireEvent.click(screen.getByTestId('ticket-form-create'));
    fireEvent.click(screen.getByTestId('ticket-form-owner-org'));
    expect(await screen.findByTestId('ticket-form-orgs-error')).toBeTruthy();
    warnSpy.mockRestore();
  });

  it('blocks save with an inline issue when the title template references an unknown field key', async () => {
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-create'));
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Typo form' } });
    fireEvent.click(screen.getByTestId('ticket-form-field-add'));
    fireEvent.change(screen.getByTestId('ticket-form-field-label-0'), { target: { value: 'Device name' } });
    // Typo: {{devcie_name}} — field key is device_name.
    fireEvent.change(screen.getByTestId('ticket-form-title-template'), { target: { value: '{{devcie_name}}' } });
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    expect(await screen.findByTestId('ticket-form-issues')).toBeTruthy();
    expect(screen.getByTestId('ticket-form-issues').textContent).toContain('devcie_name');
    // No POST fired.
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/ticket-forms' && (i as RequestInit)?.method === 'POST')).toBe(false);
  });

  it('creates a partner-wide form with an org allowlist → POST body visibleOrgIds: [a, b]', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [FORM] });
      if (url === '/ticket-forms' && init?.method === 'POST')
        return makeJsonResponse({ data: { ...FORM, id: 'f-2' } });
      if (url === '/orgs/organizations?limit=100')
        return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-create'));
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Limited' } });
    fireEvent.click(screen.getByTestId('ticket-form-owner-partner'));
    fireEvent.click(screen.getByTestId('ticket-form-limit-orgs'));
    fireEvent.click(screen.getByTestId('ticket-form-visible-org-org-a'));
    fireEvent.click(screen.getByTestId('ticket-form-visible-org-org-b'));
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms' && (i as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.ownerScope).toBe('partner');
      expect(body.visibleOrgIds).toEqual(['org-a', 'org-b']);
    });
  });

  it('blocks save with an inline issue when limit-orgs is checked but zero orgs selected', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [FORM] });
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-create'));
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Empty allowlist' } });
    fireEvent.click(screen.getByTestId('ticket-form-limit-orgs'));
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    expect(await screen.findByTestId('ticket-form-issues')).toBeTruthy();
    expect(screen.getByTestId('ticket-form-issues').textContent).toContain('Select at least one organization');
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/ticket-forms' && (i as RequestInit)?.method === 'POST')).toBe(false);
  });

  it('hydrates the allowlist from a limited partner-wide row and clears it via unchecking → PUT visibleOrgIds: null', async () => {
    const limitedForm = { ...FORM, visibleOrgIds: ['org-a'] };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [limitedForm] });
      if (url === '/ticket-forms/f-1' && init?.method === 'PUT') return makeJsonResponse({ data: FORM });
      if (url === '/orgs/organizations?limit=100')
        return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-edit-f-1'));
    // Hydration: checkbox pre-checked, org-a pre-selected.
    expect((screen.getByTestId('ticket-form-limit-orgs') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('ticket-form-visible-org-org-a') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('ticket-form-visible-org-org-b') as HTMLInputElement).checked).toBe(false);
    // Uncheck the limit → save clears the allowlist.
    fireEvent.click(screen.getByTestId('ticket-form-limit-orgs'));
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms/f-1' && (i as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.visibleOrgIds).toBeNull();
    });
  });

  it('renders an N-orgs count badge for a limited partner-wide row', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method))
        return makeJsonResponse({ data: [{ ...FORM, visibleOrgIds: ['org-a', 'org-b'] }] });
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    expect(screen.getByTestId('ticket-form-org-count-f-1').textContent).toContain('2 orgs');
    expect(screen.queryByTestId('ticket-form-all-orgs-f-1')).toBeNull();
  });

  it('never shows the allowlist control for an org-owned form, and PUT omits visibleOrgIds', async () => {
    const orgForm = { ...FORM, orgId: 'org-a', partnerId: null, visibleOrgIds: null };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [orgForm] });
      if (url === '/ticket-forms/f-1' && init?.method === 'PUT') return makeJsonResponse({ data: orgForm });
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-edit-f-1'));
    expect(screen.queryByTestId('ticket-form-limit-orgs')).toBeNull();
    fireEvent.change(screen.getByTestId('ticket-form-name'), { target: { value: 'Org form v2' } });
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms/f-1' && (i as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body).not.toHaveProperty('visibleOrgIds');
    });
  });

  it('two-step delete: first click arms, second click fires DELETE', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [FORM] });
      if (url === '/ticket-forms/f-1' && init?.method === 'DELETE') return makeJsonResponse({ success: true });
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ data: [] });
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<TicketFormsCard />);
    await screen.findByTestId('ticket-form-row-f-1');
    fireEvent.click(screen.getByTestId('ticket-form-delete-f-1'));
    // Not yet deleted — armed.
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/ticket-forms/f-1' && (i as RequestInit)?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByTestId('ticket-form-delete-f-1'));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/ticket-forms/f-1' && (i as RequestInit)?.method === 'DELETE')).toBe(true);
    });
  });
});
