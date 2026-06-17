import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertTemplateList from './AlertTemplateList';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({ organizations: [{ id: 'org-1', name: 'Acme Co' }] }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const navMock = vi.mocked(navigateTo);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const rows = [
  { id: 't-pw', name: 'Partner CPU', description: null, category: 'Performance', severity: 'high', orgId: null, partnerId: 'p-1', isBuiltIn: false, autoResolve: false },
  { id: 't-org', name: 'Org Disk', description: null, category: 'Capacity', severity: 'medium', orgId: 'org-1', partnerId: 'p-1', isBuiltIn: false, autoResolve: false },
  { id: 't-bi', name: 'Built-in Down', description: null, category: 'Availability', severity: 'critical', orgId: null, partnerId: null, isBuiltIn: true, autoResolve: true },
];

describe('AlertTemplateList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/alert-templates/templates')) return json({ data: rows });
      return json({ data: [] });
    });
  });

  it('fetches the scoped CRUD endpoint and renders a scope badge per row', async () => {
    render(<AlertTemplateList />);
    await waitFor(() => expect(screen.getByTestId('alert-template-list')).toBeInTheDocument());

    expect(fetchMock.mock.calls[0]![0]).toMatch(/^\/alert-templates\/templates/);

    expect(within(screen.getByTestId('alert-template-row-t-pw')).getByText('Partner-wide')).toBeInTheDocument();
    expect(within(screen.getByTestId('alert-template-row-t-org')).getByText('Acme Co')).toBeInTheDocument();
    expect(within(screen.getByTestId('alert-template-row-t-bi')).getByText('System')).toBeInTheDocument();
  });

  it('filters by scope', async () => {
    render(<AlertTemplateList />);
    await waitFor(() => expect(screen.getByTestId('alert-template-list')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('alert-template-scope-filter'), { target: { value: 'partner' } });
    expect(screen.getByTestId('alert-template-row-t-pw')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-template-row-t-org')).not.toBeInTheDocument();
    expect(screen.queryByTestId('alert-template-row-t-bi')).not.toBeInTheDocument();
  });

  it('navigates to the create and edit routes', async () => {
    render(<AlertTemplateList />);
    await waitFor(() => expect(screen.getByTestId('alert-template-list')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('alert-template-create'));
    expect(navMock).toHaveBeenCalledWith('/settings/alert-templates/new');

    fireEvent.click(screen.getByTestId('alert-template-edit-t-org'));
    expect(navMock).toHaveBeenCalledWith('/settings/alert-templates/t-org');
  });

  it('disables delete on built-in templates and deletes a custom one via runAction', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<AlertTemplateList />);
    await waitFor(() => expect(screen.getByTestId('alert-template-list')).toBeInTheDocument());

    expect(screen.getByTestId('alert-template-delete-t-bi')).toBeDisabled();

    fireEvent.click(screen.getByTestId('alert-template-delete-t-org'));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find((c) => c[0] === '/alert-templates/templates/t-org' && (c[1] as RequestInit)?.method === 'DELETE');
      expect(del).toBeTruthy();
    });
  });
});
