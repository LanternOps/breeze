import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { fetchWithAuth, grantedActions } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  grantedActions: new Set<string>(['ticket_mailbox:read', 'ticket_mailbox:admin']),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({
    can: (resource: string, action: string) => grantedActions.has(`${resource}:${action}`),
  }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

// Faithful options-based runAction mock: returns the parsed JSON body (as the real
// one does), invokes onUnauthorized + throws ActionError on 401.
vi.mock('../../lib/runAction', () => {
  class ActionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    ActionError,
    handleActionError: vi.fn(),
    runAction: async (opts: any) => {
      const res = await opts.request();
      const data = await res.json().catch(() => null);
      if (res.status === 401) {
        opts.onUnauthorized?.();
        throw new ActionError('Unauthorized', 401);
      }
      return opts.parseSuccess ? opts.parseSuccess(data) : data;
    },
  };
});

import M365MailboxCard from './M365MailboxCard';
import { showToast } from '../shared/Toast';

function jsonRes(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('M365MailboxCard', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    vi.mocked(showToast).mockClear();
    grantedActions.clear();
    grantedActions.add('ticket_mailbox:read');
    grantedActions.add('ticket_mailbox:admin');
  });

  it('hides the mailbox surface and does not fetch without read permission', () => {
    grantedActions.clear();

    render(<M365MailboxCard />);

    expect(screen.queryByTestId('m365-mailbox-card')).not.toBeInTheDocument();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('shows status but no mutation controls with read-only permission', async () => {
    grantedActions.delete('ticket_mailbox:admin');
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({
        connections: [
          {
            id: 'c1',
            mailboxAddress: 'support@a.com',
            displayName: 'Support',
            status: 'connected',
            lastPolledAt: null,
            lastMessageAt: null,
          },
          {
            id: 'c2',
            mailboxAddress: 'error@a.com',
            displayName: null,
            status: 'error',
            lastPolledAt: null,
            lastMessageAt: null,
          },
          {
            id: 'c3',
            mailboxAddress: 'reauth@a.com',
            displayName: null,
            status: 'reauth_required',
            lastPolledAt: null,
            lastMessageAt: null,
          },
        ],
      }),
    );

    render(<M365MailboxCard />);

    expect(await screen.findByTestId('m365-mailbox-card')).toBeInTheDocument();
    expect(await screen.findByText('support@a.com')).toBeInTheDocument();
    expect(screen.queryByTestId('m365-connect')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-test/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Application Access Policy/i)).not.toBeInTheDocument();
  });

  it('lists existing connections on mount', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({
        connections: [
          {
            id: 'c1',
            mailboxAddress: 'support@a.com',
            displayName: 'Support',
            status: 'connected',
            lastPolledAt: null,
            lastMessageAt: null,
          },
        ],
      }),
    );
    render(<M365MailboxCard />);
    expect(await screen.findByText('support@a.com')).toBeTruthy();
    expect(screen.getByText(/connected/i)).toBeTruthy();
  });

  it('does NOT render gmail rows in the Microsoft card (a gmail reconnect here would convert it to m365)', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({
        connections: [
          { id: 'm', provider: 'm365', mailboxAddress: 'support@a.com', displayName: 'Support', status: 'connected', lastPolledAt: null, lastMessageAt: null },
          { id: 'g', provider: 'gmail', mailboxAddress: 'help@client.example', displayName: 'Help', status: 'reauth_required', lastPolledAt: null, lastMessageAt: null },
        ],
      }),
    );
    render(<M365MailboxCard />);
    expect(await screen.findByText('support@a.com')).toBeInTheDocument();
    // The gmail row is filtered out entirely — its address never appears and no
    // Microsoft reconnect/retest control is offered for it.
    expect(screen.queryByText('help@client.example')).not.toBeInTheDocument();
  });

  it('Connect posts the address and redirects the browser to authUrl', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes({ connections: [] }))
      .mockResolvedValueOnce(jsonRes({ authUrl: 'https://login.microsoftonline.com/x', connectionId: 'c2' }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { assign, href: '', hash: '', pathname: '/settings/partner' },
      writable: true,
    });

    render(<M365MailboxCard />);
    fireEvent.change(await screen.findByLabelText(/mailbox address/i), { target: { value: 'support@a.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        expect.stringContaining('/tickets/mailbox/connect'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/x'));
  });

  it('sanitizes re-consent status and reconnects with the existing mailbox details', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(
        jsonRes({
          connections: [
            {
              id: 'c1',
              mailboxAddress: 'support@a.com',
              displayName: 'Support',
              status: 'reauth_required',
              lastPolledAt: null,
              lastMessageAt: null,
              tenantId: 'raw-tenant-id',
              lastError: 'raw Graph failure',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonRes({ authUrl: 'https://login.microsoftonline.com/reconsent' }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { assign, href: '', search: '', hash: '', pathname: '/settings/partner' },
      writable: true,
    });

    render(<M365MailboxCard />);

    expect(
      await screen.findByText(
        'Administrator re-consent is required before Microsoft 365 polling and replies resume.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('raw Graph failure')).not.toBeInTheDocument();
    expect(screen.queryByText('raw-tenant-id')).not.toBeInTheDocument();
    expect(screen.queryByText(/Application Access Policy/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-test/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('m365-reconnect'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/tickets/mailbox/connect',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ mailboxAddress: 'support@a.com', displayName: 'Support' }),
        }),
      ),
    );
  });

  it('discards malformed and unknown connection DTOs without crashing', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({
        connections: [
          {
            id: 'bad-status',
            mailboxAddress: 'unknown@a.com',
            displayName: null,
            status: 'surprise',
            lastPolledAt: null,
            lastMessageAt: null,
          },
          { id: 42, mailboxAddress: null, status: 'connected' },
          null,
        ],
      }),
    );

    render(<M365MailboxCard />);

    expect(await screen.findByText('No mailbox connected yet.')).toBeInTheDocument();
    expect(screen.queryByText('unknown@a.com')).not.toBeInTheDocument();
  });

  it('Re-test calls the retest endpoint', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(
        jsonRes({
          connections: [
            {
              id: 'c1',
              mailboxAddress: 'support@a.com',
              displayName: null,
              status: 'error',
              lastPolledAt: null,
              lastMessageAt: null,
              lastError: 'Graph returned 403',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonRes({ ok: true }))
      .mockResolvedValueOnce(jsonRes({ connections: [] }));
    render(<M365MailboxCard />);
    const retest = await screen.findByRole('button', { name: /re-test/i });
    expect(screen.queryByText('Graph returned 403')).not.toBeInTheDocument();
    fireEvent.click(retest);
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        expect.stringContaining('/tickets/mailbox/connections/c1/retest'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('renders the sanitized verification reason under the failed status', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({
        connections: [
          {
            id: 'c1',
            mailboxAddress: 'support@a.com',
            displayName: null,
            status: 'error',
            lastPolledAt: null,
            lastMessageAt: null,
            verificationError: 'Mailbox verification failed: Graph 403 (ErrorAccessDenied)',
          },
        ],
      }),
    );
    render(<M365MailboxCard />);
    expect(await screen.findByText('Mailbox verification failed: Graph 403 (ErrorAccessDenied)')).toBeInTheDocument();
  });

  describe('Application Access Policy snippet app id (#6935)', () => {
    const errorRow = {
      id: 'c1',
      mailboxAddress: 'support@a.com',
      displayName: null,
      status: 'error',
      lastPolledAt: null,
      lastMessageAt: null,
      verificationError: null,
    };

    it('uses the runtime appId from the connections response', async () => {
      fetchWithAuth.mockResolvedValueOnce(
        jsonRes({ connections: [errorRow], appId: 'c15fe9ee-0000-4000-8000-000000000001' }),
      );
      render(<M365MailboxCard />);
      const snippet = await screen.findByText(/New-ApplicationAccessPolicy/);
      expect(snippet.textContent).toContain('-AppId c15fe9ee-0000-4000-8000-000000000001');
      expect(snippet.textContent).not.toContain('<Breeze Ticketing app id>');
    });

    it.each([
      ['null', { appId: null }],
      ['absent', {}],
      ['blank', { appId: '   ' }],
      ['non-string', { appId: 42 }],
    ])('keeps the placeholder when appId is %s', async (_label, extra) => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [errorRow], ...extra }));
      render(<M365MailboxCard />);
      const snippet = await screen.findByText(/New-ApplicationAccessPolicy/);
      expect(snippet.textContent).toContain('-AppId <Breeze Ticketing app id>');
    });
  });

  it('Disconnect calls the delete endpoint', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(
        jsonRes({
          connections: [
            {
              id: 'c1',
              mailboxAddress: 'support@a.com',
              displayName: null,
              status: 'connected',
              lastPolledAt: null,
              lastMessageAt: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonRes({ ok: true }))
      .mockResolvedValueOnce(jsonRes({ connections: [] }));
    render(<M365MailboxCard />);
    fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        expect.stringContaining('/tickets/mailbox/connections/c1'),
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
  });
  describe('consent callback outcome (#6936)', () => {
    function landOn(search: string) {
      Object.defineProperty(window, 'location', {
        value: { assign: vi.fn(), href: '', search, hash: '#email', pathname: '/settings/ticketing' },
        writable: true,
      });
    }

    it.each([
      ['binding_mismatch', /same address as the redirect URI/i],
      ['expired', /expired or was already used/i],
      ['invalid_callback', /unexpected response/i],
    ])('names the likely cause for reason=%s and strips both params', async (reason, message) => {
      const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
      landOn(`?ticketMailbox=error&reason=${reason}`);
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [] }));

      render(<M365MailboxCard />);

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: expect.stringMatching(message) }),
        ),
      );
      expect(replaceState).toHaveBeenCalledWith({}, '', '/settings/ticketing#email');
      replaceState.mockRestore();
    });

    it('falls back to the generic failure for an unknown or absent reason', async () => {
      const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
      landOn('?ticketMailbox=error&reason=%3Cscript%3E');
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [] }));

      render(<M365MailboxCard />);

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'M365 connection failed' }),
      );
      expect(replaceState).toHaveBeenCalledWith({}, '', '/settings/ticketing#email');
      replaceState.mockRestore();
    });
  });

  it('renders an abandoned pending row as "Consent not completed" with Retry and Disconnect', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(
        jsonRes({
          connections: [
            {
              id: 'c1', provider: 'm365', mailboxAddress: 'support@a.com', displayName: 'Support',
              status: 'pending_consent', lastPolledAt: null, lastMessageAt: null, consentExpired: true,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonRes({ authUrl: 'https://login.microsoftonline.com/retry' }));
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { assign, href: '', search: '', hash: '', pathname: '/settings/ticketing' },
      writable: true,
    });

    render(<M365MailboxCard />);

    expect(await screen.findByTestId('m365-status')).toHaveTextContent('Consent not completed');
    expect(screen.getByTestId('m365-consent-expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('m365-retry-consent'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/tickets/mailbox/connect',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ mailboxAddress: 'support@a.com', displayName: 'Support' }),
        }),
      ),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/retry'));
  });

  it('keeps an in-flight pending row as "Pending consent" with no Retry', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({
        connections: [
          {
            id: 'c1', provider: 'm365', mailboxAddress: 'support@a.com', displayName: null,
            status: 'pending_consent', lastPolledAt: null, lastMessageAt: null, consentExpired: false,
          },
        ],
      }),
    );

    render(<M365MailboxCard />);

    expect(await screen.findByTestId('m365-status')).toHaveTextContent('Pending consent');
    expect(screen.queryByTestId('m365-consent-expired')).not.toBeInTheDocument();
    expect(screen.queryByTestId('m365-retry-consent')).not.toBeInTheDocument();
  });

  it('shows the exact redirect URI to register, as returned by the API', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({ connections: [], redirectUri: 'https://breeze.example.com/api/v1/tickets/mailbox/callback' }),
    );

    render(<M365MailboxCard />);

    expect(await screen.findByTestId('m365-redirect-uri')).toHaveTextContent(
      'https://breeze.example.com/api/v1/tickets/mailbox/callback',
    );
  });
});
