import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SavedFilterList } from './SavedFilterList';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore, type Organization } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // orgStore registers an orgId provider at module load.
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

// The condition builder (and its live preview fetch) is not under test here.
vi.mock('./FilterBuilder', () => ({
  FilterBuilder: () => <div data-testid="filter-builder-stub" />,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const orgA: Organization = { id: 'org-aaaa', partnerId: 'p-1', name: 'Acme Corp', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const orgB: Organization = { id: 'org-bbbb', partnerId: 'p-1', name: 'Beta Inc', status: 'active', createdAt: '2026-01-01T00:00:00Z' };

const existingFilter = {
  id: 'filter-1',
  orgId: 'org-aaaa',
  name: 'Windows Servers',
  description: null,
  conditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] },
  createdBy: 'user-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

let listPayload: unknown[] = [];
let saveResponse: Response = jsonResponse({ data: { id: 'new-1' } }, 201);

function mutationCalls() {
  return fetchWithAuthMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
}

function mutationBody(): Record<string, unknown> {
  const init = mutationCalls()[0]![1] as RequestInit;
  return JSON.parse(String(init.body));
}

async function openCreateForm() {
  render(<SavedFilterList />);
  fireEvent.click(await screen.findByRole('button', { name: /New Filter/i }));
  fireEvent.change(screen.getByPlaceholderText(/Windows Servers/i), { target: { value: 'Offline laptops' } });
}

function createButton() {
  return screen.getByRole('button', { name: /^Create Filter$/i });
}

// #8330: saved filters are org-owned (saved_filters.org_id NOT NULL). With two or
// more orgs the API cannot infer the owner, so the create must name it in the body.
describe('SavedFilterList — create names its organization (#8330)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPayload = [];
    saveResponse = jsonResponse({ data: { id: 'new-1' } }, 201);
    fetchWithAuthMock.mockImplementation(async (_url, init) => {
      if (!init?.method || init.method === 'GET') return jsonResponse({ data: listPayload });
      return saveResponse;
    });
    useOrgStore.setState({ currentOrgId: 'org-bbbb', allOrgs: false, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
  });

  it('sends the header org as orgId in a focused org view, with no picker', async () => {
    await openCreateForm();
    expect(screen.queryByTestId('saved-filter-org-picker')).toBeNull();
    fireEvent.click(createButton());

    await waitFor(() => expect(mutationCalls()).toHaveLength(1));
    expect(mutationCalls()[0]![0]).toBe('/filters');
    expect(mutationBody()).toMatchObject({ name: 'Offline laptops', orgId: 'org-bbbb' });
  });

  it('shows the API error text instead of a generic failure', async () => {
    saveResponse = jsonResponse({ error: 'Access to this organization denied' }, 403);
    await openCreateForm();
    fireEvent.click(createButton());

    expect(await screen.findByText('Access to this organization denied')).toBeInTheDocument();
    expect(screen.queryByText('Failed to save filter')).toBeNull();
    // The form stays open so the user can correct and retry.
    expect(createButton()).toBeInTheDocument();
  });

  describe('All-organizations (fleet) view with two orgs', () => {
    beforeEach(() => {
      useOrgStore.setState({ currentOrgId: null, allOrgs: true, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
    });

    it('asks for an organization and keeps Create disabled until one is chosen', async () => {
      await openCreateForm();

      const select = screen.getByTestId('saved-filter-org-picker') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(expect.arrayContaining(['Acme Corp', 'Beta Inc']));
      expect(screen.getByTestId('saved-filter-org-hint')).toBeInTheDocument();
      expect(createButton()).toBeDisabled();

      fireEvent.change(select, { target: { value: 'org-aaaa' } });
      expect(createButton()).toBeEnabled();
      expect(screen.queryByTestId('saved-filter-org-hint')).toBeNull();
    });

    it('guards a programmatic submit with an inline message and no request', async () => {
      await openCreateForm();
      fireEvent.submit(createButton().closest('form')!);

      expect(await screen.findByText(/Select an organization/i)).toBeInTheDocument();
      expect(mutationCalls()).toHaveLength(0);
    });

    it('posts the chosen org once one is selected', async () => {
      await openCreateForm();
      fireEvent.change(screen.getByTestId('saved-filter-org-picker'), { target: { value: 'org-aaaa' } });
      fireEvent.click(createButton());

      await waitFor(() => expect(mutationCalls()).toHaveLength(1));
      expect(mutationBody()).toMatchObject({ name: 'Offline laptops', orgId: 'org-aaaa' });
    });

    it('edits an existing filter without asking for an organization', async () => {
      listPayload = [existingFilter];
      saveResponse = jsonResponse({ data: existingFilter });
      render(<SavedFilterList />);
      fireEvent.click(await screen.findByTitle('Edit'));

      expect(screen.queryByTestId('saved-filter-org-picker')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

      await waitFor(() => expect(mutationCalls()).toHaveLength(1));
      expect(mutationCalls()[0]![0]).toBe('/filters/filter-1');
      expect((mutationCalls()[0]![1] as RequestInit).method).toBe('PATCH');
      expect(mutationBody()).not.toHaveProperty('orgId');
    });
  });

  it('surfaces a delete failure through a toast', async () => {
    listPayload = [existingFilter];
    saveResponse = jsonResponse({ error: 'Saved filter not found' }, 404);
    render(<SavedFilterList />);
    fireEvent.click(await screen.findByTitle('Delete'));
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ }).at(-1)!);

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Saved filter not found' })),
    );
  });
});
