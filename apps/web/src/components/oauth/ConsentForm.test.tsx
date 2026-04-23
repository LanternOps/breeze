import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConsentForm from './ConsentForm';
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

const interactionFixture = (overrides: Partial<{ partners: { partnerId: string; partnerName: string }[]; scopes: string[]; client_name: string }> = {}) => ({
  uid: 'uid-1',
  client: { client_id: 'client_abc', client_name: overrides.client_name ?? 'Claude' },
  scopes: overrides.scopes ?? ['mcp:read', 'mcp:write'],
  resource: 'https://us.2breeze.app/mcp/server',
  partners: overrides.partners ?? [{ partnerId: 'p1', partnerName: 'Acme MSP' }],
});

describe('ConsentForm', () => {
  const originalLocation = window.location;
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, href: 'http://localhost/oauth/consent?uid=uid-1' },
    });
  });

  it('renders client name, scopes, and Approve/Deny once details load', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(interactionFixture()));
    render(<ConsentForm uid="uid-1" />);

    expect(await screen.findByText(/Claude wants to access your Breeze tenant/)).toBeTruthy();
    expect(screen.getByText(/Read your fleet data/)).toBeTruthy();
    expect(screen.getByText(/Run actions on your fleet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy();
    expect(screen.queryByLabelText(/Connect to which tenant/)).toBeNull();
  });

  it('shows the tenant picker only when more than one partner is available', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        interactionFixture({
          partners: [
            { partnerId: 'p1', partnerName: 'Acme MSP' },
            { partnerId: 'p2', partnerName: 'Globex IT' },
          ],
        }),
      ),
    );
    render(<ConsentForm uid="uid-1" />);

    const select = (await screen.findByLabelText(/Connect to which tenant/)) as HTMLSelectElement;
    expect(select.value).toBe('p1');
    expect(select.options).toHaveLength(2);
  });

  it('redirects to /login with next= when the API returns 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    render(<ConsentForm uid="uid-1" />);

    const link = (await screen.findByRole('link', { name: /Sign in/ })) as HTMLAnchorElement;
    expect(link.href).toContain('/login?next=');
    expect(decodeURIComponent(link.href)).toContain('/oauth/consent?uid=uid-1');
  });

  it('shows an expired message when the API returns 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
    render(<ConsentForm uid="uid-1" />);
    expect(await screen.findByText(/Authorization request expired/)).toBeTruthy();
  });

  it('posts approve=true with the chosen partner_id and follows redirectTo', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(interactionFixture()));
    fetchMock.mockResolvedValueOnce(jsonResponse({ redirectTo: 'https://client.example/cb?code=abc' }));

    render(<ConsentForm uid="uid-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/oauth/interaction/uid-1/consent',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ partner_id: 'p1', approve: true }),
        }),
      );
    });
    await waitFor(() => {
      expect(window.location.href).toBe('https://client.example/cb?code=abc');
    });
  });

  it('posts approve=false on Deny', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(interactionFixture()));
    fetchMock.mockResolvedValueOnce(jsonResponse({ redirectTo: 'https://client.example/cb?error=access_denied' }));

    render(<ConsentForm uid="uid-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Deny/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/oauth/interaction/uid-1/consent',
        expect.objectContaining({
          body: JSON.stringify({ partner_id: 'p1', approve: false }),
        }),
      );
    });
  });

  it('shows the API error message when consent submission fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(interactionFixture()));
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not a member of this partner' }, 403));

    render(<ConsentForm uid="uid-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));

    expect(await screen.findByText(/not a member of this partner/)).toBeTruthy();
  });

  it('shows the no-tenants state when partners[] is empty', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(interactionFixture({ partners: [] })));
    render(<ConsentForm uid="uid-1" />);
    expect(await screen.findByText(/No tenant available/)).toBeTruthy();
  });
});
