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

function jsonRes(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe('M365MailboxCard', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
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
    expect(screen.queryByText('Re-test')).not.toBeInTheDocument();

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
});
