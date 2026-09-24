import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  // Keep the real store: AutomationsPage reads useAuthStore via usePermissions().
  return { ...actual, fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() };
});
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import AutomationsPage from './AutomationsPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'X', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const AUTOMATION = {
  id: 'automation-1',
  name: 'Nightly cleanup',
  orgId: 'org-1',
  enabled: true,
  trigger: { type: 'manual' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function routeFetch(mutation: { status: number; payload: unknown }) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method && String(input) === '/automations') {
      return jsonResponse({ data: [AUTOMATION] });
    }
    return jsonResponse(mutation.payload, mutation.status);
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/automations' && !init?.method).length;

async function openDeleteDialog() {
  render(<AutomationsPage />);
  await screen.findByText('Nightly cleanup');
  fireEvent.click(screen.getByTestId('automation-menu-automation-1'));
  fireEvent.click(screen.getByTestId('automation-delete-automation-1'));
  const heading = await screen.findByRole('heading', { name: 'Delete Automation' });
  const dialog = heading.parentElement as HTMLElement;
  return within(dialog).getByRole('button', { name: 'Delete' });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('AutomationsPage delete confirmation (#3531)', () => {
  it('delete failure: toasts, keeps the modal open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Delete blew up' } });
    const confirm = await openDeleteDialog();
    expect(listFetches()).toBe(1);

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Delete blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith('/automations/automation-1', expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByRole('heading', { name: 'Delete Automation' })).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('delete failure (403) toasts the server reason and keeps the modal open', async () => {
    routeFetch({ status: 403, payload: { error: 'Insufficient permissions' } });
    fireEvent.click(await openDeleteDialog());

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Insufficient permissions' }),
      ),
    );
    expect(screen.getByRole('heading', { name: 'Delete Automation' })).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('delete success: refetches and closes the modal', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    fireEvent.click(await openDeleteDialog());

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delete Automation' })).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('run-now failure: toasts and does not refetch', async () => {
    routeFetch({ status: 500, payload: { error: 'Trigger blew up' } });
    render(<AutomationsPage />);
    await screen.findByText('Nightly cleanup');

    fireEvent.click(screen.getByTestId('automation-run-automation-1'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Trigger blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith('/automations/automation-1/trigger', expect.objectContaining({ method: 'POST' }));
    expect(listFetches()).toBe(1);
  });

  it('toggle failure: toasts and leaves the switch in its previous state', async () => {
    routeFetch({ status: 500, payload: { error: 'Toggle blew up' } });
    render(<AutomationsPage />);
    await screen.findByText('Nightly cleanup');
    const toggle = screen.getByTestId('automation-toggle-automation-1');
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Toggle blew up' })),
    );
    expect(screen.getByTestId('automation-toggle-automation-1')).toBeChecked();
  });
});
