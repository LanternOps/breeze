import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectedAppsList from './ConnectedAppsList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const noContent = (status = 204): Response =>
  ({
    ok: true,
    status,
    statusText: 'No Content',
    json: vi.fn().mockResolvedValue({}),
  }) as unknown as Response;

const sampleApps = [
  {
    client_id: 'client_claude',
    client_name: 'Claude Desktop',
    created_at: '2026-04-20T15:00:00.000Z',
    last_used_at: '2026-04-23T16:30:00.000Z',
  },
  {
    client_id: 'client_chatgpt',
    client_name: 'ChatGPT',
    created_at: '2026-04-21T09:00:00.000Z',
    last_used_at: null,
  },
];

describe('ConnectedAppsList', () => {
  const originalLocation = window.location;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, href: 'http://localhost/settings/connected-apps' },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders the loading state, then the table of apps', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ clients: sampleApps }));
    render(<ConnectedAppsList />);

    expect(screen.getByText(/Loading connected apps/)).toBeTruthy();
    expect(await screen.findByText('Claude Desktop')).toBeTruthy();
    expect(screen.getByText('ChatGPT')).toBeTruthy();
    expect(screen.getByText('client_claude')).toBeTruthy();
    expect(screen.getByText('Never')).toBeTruthy();
  });

  it('renders the empty state when no apps are returned', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ clients: [] }));
    render(<ConnectedAppsList />);

    expect(await screen.findByText(/No connected apps yet/)).toBeTruthy();
  });

  it('redirects to /login on 401 and renders the redirecting fallback', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    render(<ConnectedAppsList />);

    expect(await screen.findByText(/Redirecting to sign in/)).toBeTruthy();
    expect(window.location.href).toBe('/login?next=/settings/connected-apps');
  });

  it('shows the API error message on non-401 failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'partner scope required' }, 403));
    render(<ConnectedAppsList />);

    expect(await screen.findByText(/partner scope required/)).toBeTruthy();
  });

  it('asks for confirmation, calls DELETE, and reloads after revoke', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ clients: sampleApps }))
      .mockResolvedValueOnce(noContent())
      .mockResolvedValueOnce(jsonResponse({ clients: [sampleApps[1]] }));

    render(<ConnectedAppsList />);
    const revokeBtn = (await screen.findAllByRole('button', { name: /Revoke/ }))[0];
    fireEvent.click(revokeBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/settings/connected-apps/client_claude',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('Claude Desktop')).toBeNull();
    });
    expect(screen.getByText('ChatGPT')).toBeTruthy();
  });

  it('skips the DELETE call when the user cancels confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fetchMock.mockResolvedValueOnce(jsonResponse({ clients: sampleApps }));

    render(<ConnectedAppsList />);
    const revokeBtn = (await screen.findAllByRole('button', { name: /Revoke/ }))[0];
    fireEvent.click(revokeBtn);

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a revoke error from the API', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ clients: sampleApps }))
      .mockResolvedValueOnce(jsonResponse({ message: 'something exploded' }, 500));

    render(<ConnectedAppsList />);
    const revokeBtn = (await screen.findAllByRole('button', { name: /Revoke/ }))[0];
    fireEvent.click(revokeBtn);

    expect(await screen.findByText(/something exploded/)).toBeTruthy();
  });
});
