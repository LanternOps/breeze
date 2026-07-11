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
  it('lists forms with an All orgs badge for partner-wide rows', async () => {
    render(<TicketFormsCard />);
    expect(await screen.findByTestId('ticket-form-row-f-1')).toBeTruthy();
    expect(screen.getByTestId('ticket-form-row-f-1').textContent).toContain('All orgs');
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

  it('updates an existing form via PUT with no ownerScope/orgId in the body', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/ticket-forms' && (!init || !init.method)) return makeJsonResponse({ data: [FORM] });
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
    fireEvent.click(screen.getByTestId('ticket-form-save'));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([u, i]) => String(u) === '/ticket-forms/f-1' && (i as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.name).toBe('Onboarding v2');
      expect(body).not.toHaveProperty('ownerScope');
      expect(body).not.toHaveProperty('orgId');
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
