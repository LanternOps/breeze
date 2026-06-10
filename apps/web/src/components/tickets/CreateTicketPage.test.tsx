import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CreateTicketPage from './CreateTicketPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockOptionsApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/orgs/organizations?limit=100') {
      return makeJsonResponse({ data: [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }] });
    }
    if (url === '/ticket-categories') {
      return makeJsonResponse({ data: [{ id: 'cat-1', name: 'Hardware', isActive: true }] });
    }
    if (url.startsWith('/devices?orgId=')) {
      return makeJsonResponse({ data: [{ id: 'dev-1', displayName: 'PC-1' }] });
    }
    if (url === '/tickets' && init?.method === 'POST') {
      return makeJsonResponse({ data: { id: 'tk-9', internalNumber: 'T-2026-0009' } });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 404);
  });
}

describe('CreateTicketPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits deviceId, categoryId and description from the payload when left empty', async () => {
    mockOptionsApi();
    render(<CreateTicketPage />);
    await screen.findByTestId('create-ticket-form');

    fireEvent.change(screen.getByTestId('create-ticket-org-input'), { target: { value: 'org-a' } });
    fireEvent.change(screen.getByTestId('create-ticket-subject-input'), { target: { value: 'Printer down' } });
    fireEvent.click(screen.getByTestId('create-ticket-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets', expect.objectContaining({ method: 'POST' }));
    });

    const postCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/tickets' && init?.method === 'POST');
    const body = JSON.parse(String(postCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).toEqual({ orgId: 'org-a', subject: 'Printer down', priority: 'normal' });
    expect(body).not.toHaveProperty('deviceId');
    expect(body).not.toHaveProperty('categoryId');
    expect(body).not.toHaveProperty('description');
  });

  it('loads the device list for the selected organization', async () => {
    mockOptionsApi();
    render(<CreateTicketPage />);
    await screen.findByTestId('create-ticket-form');

    expect(screen.getByTestId('create-ticket-device-input')).toBeDisabled();

    fireEvent.change(screen.getByTestId('create-ticket-org-input'), { target: { value: 'org-a' } });

    await screen.findByText('PC-1');
    expect(fetchMock).toHaveBeenCalledWith('/devices?orgId=org-a');
    expect(screen.getByTestId('create-ticket-device-input')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('create-ticket-device-input'), { target: { value: 'dev-1' } });
    expect(screen.getByTestId('create-ticket-device-input')).toHaveValue('dev-1');
  });

  it('shows the load-error retry state when the org fetch fails, and recovers on retry', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/orgs/organizations?limit=100') return makeJsonResponse({ error: 'boom' }, false, 500);
      if (url === '/ticket-categories') return makeJsonResponse({ data: [] });
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });
    render(<CreateTicketPage />);

    await screen.findByTestId('create-ticket-load-error');
    expect(screen.queryByTestId('create-ticket-form')).toBeNull();

    mockOptionsApi();
    fireEvent.click(screen.getByTestId('create-ticket-load-retry'));

    await screen.findByTestId('create-ticket-form');
    expect(screen.queryByTestId('create-ticket-load-error')).toBeNull();
    expect(screen.getByText('Org A')).toBeInTheDocument();
  });
});
