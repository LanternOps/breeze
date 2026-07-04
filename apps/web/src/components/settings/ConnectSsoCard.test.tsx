import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectSsoCard from './ConnectSsoCard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

// runAction (used for the mutation) toasts through this module; mock it so the
// real runAction path runs without touching the DOM toast host.
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const assignMock = vi.fn();
function setLocation(search: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { search, assign: assignMock, href: 'http://localhost/settings/profile', pathname: '/settings/profile' }
  });
}

describe('ConnectSsoCard (#2183)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocation('');
  });

  it('renders one row per provider with a Connect button or Connected badge', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({
      data: [
        { id: 'p-1', name: 'Okta', type: 'oidc', linked: false },
        { id: 'p-2', name: 'Entra', type: 'oidc', linked: true }
      ]
    }));

    render(<ConnectSsoCard />);

    expect(await screen.findByText('Okta')).toBeInTheDocument();
    expect(screen.getByTestId('connect-sso-p-1')).toBeInTheDocument();
    // Linked provider shows a "Connected" badge, not a button.
    expect(screen.getByText('Entra')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-sso-p-2')).not.toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('clicking Connect starts linking and navigates to the returned authUrl', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === '/sso/link/options') {
        return Promise.resolve(jsonResponse({ data: [{ id: 'p-1', name: 'Okta', type: 'oidc', linked: false }] }));
      }
      if (url === '/sso/link/start/p-1') {
        return Promise.resolve(jsonResponse({ authUrl: 'https://idp.example.com/authorize?x=1' }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    render(<ConnectSsoCard />);

    fireEvent.click(await screen.findByTestId('connect-sso-p-1'));

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith('https://idp.example.com/authorize?x=1');
    });
    // The POST went through the /sso/link/start endpoint.
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/sso/link/start/p-1', expect.objectContaining({ method: 'POST' }));
  });

  it('shows a success banner when the page loads with ?ssoLinked=1', async () => {
    setLocation('?ssoLinked=1');
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    render(<ConnectSsoCard />);

    expect(await screen.findByText(/connected/i)).toBeInTheDocument();
  });

  it('shows an error banner for ?ssoLinkError=email_mismatch', async () => {
    setLocation('?ssoLinkError=email_mismatch');
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    render(<ConnectSsoCard />);

    expect(await screen.findByText(/different email/i)).toBeInTheDocument();
  });
});
