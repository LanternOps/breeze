import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SavedViewsMenu } from './SavedViewsMenu';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore, type Organization } from '../../stores/orgStore';
import { showToast } from '../shared/Toast';
import type { FilterConditionGroup } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })),
  // orgStore registers an orgId provider at module load.
  registerOrgIdProvider: vi.fn(),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const orgA: Organization = { id: 'org-aaaa', partnerId: 'p-1', name: 'Acme Corp', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const orgB: Organization = { id: 'org-bbbb', partnerId: 'p-1', name: 'Beta Inc', status: 'active', createdAt: '2026-01-01T00:00:00Z' };

const activeFilter: FilterConditionGroup = {
  operator: 'AND',
  conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }],
};

const savedView = {
  id: 'view-1',
  orgId: 'org-aaaa',
  name: 'Windows boxes',
  description: null,
  conditions: activeFilter,
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
let mutationResponse: Response = jsonResponse({ data: { id: 'new-1' } }, 201);

function mutationCalls() {
  return fetchWithAuthMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
}

function listCalls() {
  return fetchWithAuthMock.mock.calls.filter(([url, init]) => url === '/filters' && (!init?.method || init.method === 'GET'));
}

function mutationBody(): Record<string, unknown> {
  const init = mutationCalls()[0]![1] as RequestInit;
  return JSON.parse(String(init.body));
}

async function openNamingRow(value: FilterConditionGroup | null = activeFilter) {
  render(<SavedViewsMenu value={value} onApply={vi.fn()} />);
  await waitFor(() => expect(listCalls()).toHaveLength(1));
  fireEvent.click(screen.getByTestId('saved-views-button'));
  fireEvent.click(await screen.findByTestId('saved-view-save-current'));
  fireEvent.change(screen.getByTestId('saved-view-name-input'), { target: { value: 'Offline laptops' } });
}

function setFocusedOrg(orgId: string) {
  useOrgStore.setState({ currentOrgId: orgId, allOrgs: false, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
}

function setAllOrgs() {
  useOrgStore.setState({ currentOrgId: null, allOrgs: true, organizations: [orgA, orgB], organizationsLoaded: true, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  listPayload = [];
  mutationResponse = jsonResponse({ data: { id: 'new-1' } }, 201);
  fetchWithAuthMock.mockImplementation(async (_url, init) => {
    if (!init?.method || init.method === 'GET') return jsonResponse({ data: listPayload });
    return mutationResponse;
  });
  useOrgStore.setState({ currentOrgId: null, allOrgs: false, organizations: [], organizationsLoaded: false, error: null });
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has localStorage; the guard mirrors the component.
  }
});

// #9037: the Views popover shared the Columns menu's problems — role="menu"
// with no menu items, no Escape, and clipped off the left edge at 390px.
describe('SavedViewsMenu popover (#9037)', () => {
  it('is a labelled non-modal dialog advertised by its trigger', () => {
    render(<SavedViewsMenu value={null} onApply={vi.fn()} />);
    const trigger = screen.getByTestId('saved-views-button');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(trigger);
    const panel = screen.getByTestId('saved-views-menu');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'false');
    expect(panel).toHaveAccessibleName();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<SavedViewsMenu value={null} onApply={vi.fn()} />);
    const trigger = screen.getByTestId('saved-views-button');
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByTestId('saved-views-menu'), { key: 'Escape' });
    expect(screen.queryByTestId('saved-views-menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('pins to the viewport gutters below sm instead of hanging off the left edge', () => {
    render(<SavedViewsMenu value={null} onApply={vi.fn()} />);
    fireEvent.click(screen.getByTestId('saved-views-button'));
    const panel = screen.getByTestId('saved-views-menu');
    expect(panel).toHaveClass('max-sm:fixed', 'max-sm:inset-x-4', 'max-sm:w-auto');
    expect(panel.innerHTML).not.toContain('text-[10px]');
  });
});

// #11879: saved views are saved filters, which are org-owned
// (saved_filters.org_id NOT NULL). A partner with 2+ orgs got
// "orgId is required when partner has multiple organizations" when saving a
// view from the All-organizations Devices list, because the POST carried no
// orgId. Same ownership rule as the Settings › Saved filters form (#8330).
describe('SavedViewsMenu — saving a view names its organization (#11879)', () => {
  it('sends the selected org in a focused org view, with no picker', async () => {
    setFocusedOrg('org-bbbb');
    await openNamingRow();
    expect(screen.queryByTestId('saved-view-org-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('saved-view-save-confirm'));

    await waitFor(() => expect(mutationCalls()).toHaveLength(1));
    expect(mutationCalls()[0]![0]).toBe('/filters');
    expect(mutationBody()).toMatchObject({ name: 'Offline laptops', conditions: activeFilter, orgId: 'org-bbbb' });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(screen.queryByTestId('saved-view-name-input')).toBeNull();
  });

  describe('All-organizations view with two orgs', () => {
    beforeEach(setAllOrgs);

    it('asks which org owns the view and keeps Save disabled until one is chosen', async () => {
      await openNamingRow();
      const select = screen.getByTestId('saved-view-org-picker') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(expect.arrayContaining(['Acme Corp', 'Beta Inc']));
      expect(screen.getByTestId('saved-view-org-hint')).toBeInTheDocument();
      expect(screen.getByTestId('saved-view-save-confirm')).toBeDisabled();

      fireEvent.change(select, { target: { value: 'org-aaaa' } });
      expect(screen.getByTestId('saved-view-save-confirm')).toBeEnabled();
      expect(screen.queryByTestId('saved-view-org-hint')).toBeNull();
    });

    it('does not post on Enter before an org is chosen', async () => {
      await openNamingRow();
      fireEvent.keyDown(screen.getByTestId('saved-view-name-input'), { key: 'Enter' });
      await Promise.resolve();
      expect(mutationCalls()).toHaveLength(0);
    });

    it('posts the chosen org', async () => {
      await openNamingRow();
      fireEvent.change(screen.getByTestId('saved-view-org-picker'), { target: { value: 'org-aaaa' } });
      fireEvent.click(screen.getByTestId('saved-view-save-confirm'));

      await waitFor(() => expect(mutationCalls()).toHaveLength(1));
      expect(mutationBody()).toMatchObject({ name: 'Offline laptops', orgId: 'org-aaaa' });
    });
  });

  it('explains instead of posting while no org scope is resolved', async () => {
    // Org list failed to load and nothing is selected: neither focused nor all-orgs.
    useOrgStore.setState({ currentOrgId: null, allOrgs: false, organizations: [], organizationsLoaded: false, error: 'boom' });
    await openNamingRow();
    expect(screen.queryByTestId('saved-view-org-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('saved-view-save-confirm'));

    expect(await screen.findByTestId('saved-view-org-required')).toHaveTextContent(/Select an organization/i);
    expect(mutationCalls()).toHaveLength(0);
  });

  it('toasts the API error text and keeps the name row open', async () => {
    setFocusedOrg('org-bbbb');
    mutationResponse = jsonResponse({ error: 'orgId is required when partner has multiple organizations' }, 400);
    await openNamingRow();
    fireEvent.click(screen.getByTestId('saved-view-save-confirm'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'orgId is required when partner has multiple organizations' }),
      ),
    );
    expect(screen.getByTestId('saved-view-name-input')).toHaveValue('Offline laptops');
    expect(listCalls()).toHaveLength(1);
  });

  it('treats an HTTP-200 {success:false} body as a failed save', async () => {
    setFocusedOrg('org-bbbb');
    mutationResponse = jsonResponse({ success: false, error: 'Could not store view' }, 200);
    await openNamingRow();
    fireEvent.click(screen.getByTestId('saved-view-save-confirm'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Could not store view' })),
    );
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(screen.getByTestId('saved-view-name-input')).toBeInTheDocument();
  });

  it('leaves a 401 to the auth redirect: no toast', async () => {
    setFocusedOrg('org-bbbb');
    mutationResponse = jsonResponse({ error: 'Unauthorized' }, 401);
    await openNamingRow();
    fireEvent.click(screen.getByTestId('saved-view-save-confirm'));

    await waitFor(() => expect(mutationCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('saved-view-save-confirm')).toBeEnabled());
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('toasts the API error text when a delete fails and keeps the default view', async () => {
    setFocusedOrg('org-aaaa');
    listPayload = [savedView];
    window.localStorage.setItem('breeze.devices.defaultView', 'view-1');
    mutationResponse = jsonResponse({ error: 'Not allowed' }, 403);
    render(<SavedViewsMenu value={activeFilter} onApply={vi.fn()} />);
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('saved-views-button'));
    fireEvent.click(await screen.findByTestId('saved-view-delete-view-1'));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Not allowed' })),
    );
    expect(mutationCalls()[0]![0]).toBe('/filters/view-1');
    expect(window.localStorage.getItem('breeze.devices.defaultView')).toBe('view-1');
    expect(listCalls()).toHaveLength(1);
  });

  it('refreshes the list when the view was already deleted elsewhere (404)', async () => {
    setFocusedOrg('org-aaaa');
    listPayload = [savedView];
    mutationResponse = jsonResponse({ error: 'Saved filter not found' }, 404);
    render(<SavedViewsMenu value={null} onApply={vi.fn()} />);
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('saved-views-button'));
    listPayload = [];
    fireEvent.click(await screen.findByTestId('saved-view-delete-view-1'));

    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('saved-view-view-1')).toBeNull());
  });

  it('a successful delete of the default view clears the stored default and refetches', async () => {
    setFocusedOrg('org-aaaa');
    listPayload = [savedView];
    window.localStorage.setItem('breeze.devices.defaultView', 'view-1');
    mutationResponse = jsonResponse({ data: savedView }, 200);
    render(<SavedViewsMenu value={activeFilter} onApply={vi.fn()} />);
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('saved-views-button'));
    listPayload = [];
    fireEvent.click(await screen.findByTestId('saved-view-delete-view-1'));

    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(window.localStorage.getItem('breeze.devices.defaultView')).toBeNull();
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('drops the "select an organization" message once the org scope resolves', async () => {
    useOrgStore.setState({ currentOrgId: null, allOrgs: false, organizations: [], organizationsLoaded: false, error: 'boom' });
    await openNamingRow();
    fireEvent.click(screen.getByTestId('saved-view-save-confirm'));
    expect(await screen.findByTestId('saved-view-org-required')).toBeInTheDocument();

    act(() => setFocusedOrg('org-bbbb'));
    expect(screen.queryByTestId('saved-view-org-required')).toBeNull();
  });
});
