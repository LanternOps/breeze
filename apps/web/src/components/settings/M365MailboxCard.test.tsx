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

  describe('trusted ARC sealers (#10862)', () => {
    const conn = (over: Record<string, unknown> = {}) => ({
      id: 'c1',
      mailboxAddress: 'support@a.com',
      displayName: 'Support',
      status: 'connected',
      lastPolledAt: null,
      lastMessageAt: null,
      trustedArcSealers: [],
      ...over,
    });

    it('starts empty, and saves a normalized list through the PATCH route', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn()] }));
      render(<M365MailboxCard />);
      const input = await screen.findByTestId('m365-arc-sealers-input');
      expect(input).toHaveValue('');

      fireEvent.change(input, { target: { value: 'Gateway.Example, mx.gateway.example gateway.example' } });
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ ok: true, trustedArcSealers: ['gateway.example', 'mx.gateway.example'] }));
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn({ trustedArcSealers: ['gateway.example', 'mx.gateway.example'] })] }));
      fireEvent.click(screen.getByTestId('m365-arc-sealers-save'));

      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
        '/tickets/mailbox/connections/c1/trusted-arc-sealers',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ sealers: ['gateway.example', 'mx.gateway.example'] }),
        }),
      ));
    });

    it('shows the saved list and lets it be cleared', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn({ trustedArcSealers: ['gateway.example'] })] }));
      render(<M365MailboxCard />);
      const input = await screen.findByTestId('m365-arc-sealers-input');
      expect(input).toHaveValue('gateway.example');

      fireEvent.change(input, { target: { value: '' } });
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ ok: true, trustedArcSealers: [] }));
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn()] }));
      fireEvent.click(screen.getByTestId('m365-arc-sealers-save'));
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
        '/tickets/mailbox/connections/c1/trusted-arc-sealers',
        expect.objectContaining({ body: JSON.stringify({ sealers: [] }) }),
      ));
    });

    it('keeps an edit made before the mount effects flush (no late saved→draft clobber, #11350)', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn({ trustedArcSealers: ['gateway.example'] })] }));
      // Edit the instant the input is inserted into the DOM — a microtask after the
      // commit, before React's passive effects flush. Under CPU load a user (or a
      // test) can land in this window; a mount-time `setDraft(saved)` would then
      // overwrite the edit.
      const observer = new MutationObserver(() => {
        const el = document.querySelector<HTMLInputElement>('[data-testid="m365-arc-sealers-input"]');
        if (!el) return;
        observer.disconnect();
        fireEvent.change(el, { target: { value: 'edited.example' } });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      render(<M365MailboxCard />);
      await waitFor(() => expect(screen.getByTestId('m365-arc-sealers-input')).toHaveValue('edited.example'));
      // Let any pending passive effect run, then confirm the edit survived.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByTestId('m365-arc-sealers-input')).toHaveValue('edited.example');
      observer.disconnect();
    });

    it('still adopts a genuinely new saved list from the server', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn({ trustedArcSealers: ['gateway.example'] })] }));
      render(<M365MailboxCard />);
      const input = await screen.findByTestId('m365-arc-sealers-input');
      fireEvent.change(input, { target: { value: 'edited.example' } });
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ ok: true, trustedArcSealers: ['edited.example'] }));
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn({ trustedArcSealers: ['edited.example', 'mx.edited.example'] })] }));
      fireEvent.click(screen.getByTestId('m365-arc-sealers-save'));
      await waitFor(() => expect(screen.getByTestId('m365-arc-sealers-input')).toHaveValue('edited.example, mx.edited.example'));
    });

    it.each(['*.gateway.example', 'a@gateway.example', 'localhost'])('blocks saving the invalid entry %s without calling the API', async (value) => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn()] }));
      render(<M365MailboxCard />);
      fireEvent.change(await screen.findByTestId('m365-arc-sealers-input'), { target: { value } });
      expect(screen.getByTestId('m365-arc-sealers-invalid')).toBeInTheDocument();
      expect(screen.getByTestId('m365-arc-sealers-save')).toBeDisabled();
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    });

    it('blocks more than ten entries', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn()] }));
      render(<M365MailboxCard />);
      fireEvent.change(await screen.findByTestId('m365-arc-sealers-input'), {
        target: { value: Array.from({ length: 11 }, (_, i) => `g${i}.example`).join(' ') },
      });
      expect(screen.getByTestId('m365-arc-sealers-save')).toBeDisabled();
    });

    it('is read-only without admin permission', async () => {
      grantedActions.delete('ticket_mailbox:admin');
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn({ trustedArcSealers: ['gateway.example'] })] }));
      render(<M365MailboxCard />);
      expect(await screen.findByTestId('m365-arc-sealers-readonly')).toHaveTextContent('gateway.example');
      expect(screen.queryByTestId('m365-arc-sealers-input')).not.toBeInTheDocument();
      expect(screen.queryByTestId('m365-arc-sealers-save')).not.toBeInTheDocument();
    });

    it('hides it for a read-only user when the list is empty, and tolerates an API that omits it', async () => {
      grantedActions.delete('ticket_mailbox:admin');
      const { trustedArcSealers: _omitted, ...legacy } = conn();
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [legacy] }));
      render(<M365MailboxCard />);
      await screen.findByTestId('m365-connection');
      expect(screen.queryByTestId('m365-arc-sealers-readonly')).not.toBeInTheDocument();
    });

    it('does not show it before consent completes', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [conn({ status: 'pending_consent' })] }));
      render(<M365MailboxCard />);
      await screen.findByTestId('m365-connection');
      expect(screen.queryByTestId('m365-arc-sealers-input')).not.toBeInTheDocument();
    });
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

  describe('connect baseline note (#10863)', () => {
    const row = (connectBaseline: unknown, status = 'connected') => ({
      id: 'c1',
      mailboxAddress: 'support@a.com',
      displayName: null,
      status,
      lastPolledAt: null,
      lastMessageAt: null,
      verificationError: null,
      connectBaseline,
    });
    const done = '2026-11-01T12:10:00.000Z';

    it('says how many messages already in the inbox will not be imported', async () => {
      fetchWithAuth.mockResolvedValueOnce(
        jsonRes({ connections: [row({ skippedCount: 9487, completedAt: done })] }),
      );
      render(<M365MailboxCard />);
      const note = await screen.findByTestId('m365-baseline-note');
      expect(note.textContent).toContain('9487 messages already in this inbox will not be imported');
      expect(screen.queryByTestId('m365-baseline-running')).toBeNull();
    });

    it('uses the singular for one message', async () => {
      fetchWithAuth.mockResolvedValueOnce(
        jsonRes({ connections: [row({ skippedCount: 1, completedAt: done })] }),
      );
      render(<M365MailboxCard />);
      const note = await screen.findByTestId('m365-baseline-note');
      expect(note.textContent).toContain('1 message already in this inbox will not be imported');
    });

    it('says the inbox is being read while the baseline runs, without a partial count', async () => {
      fetchWithAuth.mockResolvedValueOnce(
        jsonRes({ connections: [row({ skippedCount: 2000, completedAt: null })] }),
      );
      render(<M365MailboxCard />);
      const note = await screen.findByTestId('m365-baseline-running');
      expect(note.textContent).toMatch(/already in it will not be imported/);
      expect(note.textContent).not.toContain('2000');
      expect(screen.queryByTestId('m365-baseline-note')).toBeNull();
    });

    it.each([
      ['an empty inbox', { skippedCount: 0, completedAt: done }, 'connected'],
      ['a mailbox from before the floor', null, 'connected'],
      ['an older API with no field', undefined, 'connected'],
      ['a malformed count', { skippedCount: 'many', completedAt: done }, 'connected'],
      ['a negative count', { skippedCount: -1, completedAt: done }, 'connected'],
      ['a mailbox that is not polling', { skippedCount: 12, completedAt: done }, 'reauth_required'],
    ])('stays quiet for %s', async (_label, value, status) => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [row(value, status)] }));
      render(<M365MailboxCard />);
      expect(await screen.findByText('support@a.com')).toBeInTheDocument();
      expect(screen.queryByTestId('m365-baseline-note')).toBeNull();
      expect(screen.queryByTestId('m365-baseline-running')).toBeNull();
    });
  });

  describe('repeated transient poll failures (#8308)', () => {
    const connectedRow = (transientPollFailures: unknown) => ({
      id: 'c1',
      mailboxAddress: 'support@a.com',
      displayName: null,
      status: 'connected',
      lastPolledAt: null,
      lastMessageAt: null,
      verificationError: null,
      transientPollFailures,
    });

    it('warns once the poll has failed three times in a row', async () => {
      fetchWithAuth.mockResolvedValueOnce(
        jsonRes({ connections: [connectedRow({ count: 5, lastAt: '2026-10-11T12:00:00.000Z' })] }),
      );
      render(<M365MailboxCard />);
      const note = await screen.findByTestId('m365-poll-failing');
      expect(note.textContent).toContain('5');
      expect(note.textContent).toMatch(/temporary Microsoft 365 error/);
    });

    it.each([
      ['a single blip', { count: 2, lastAt: '2026-10-11T12:00:00.000Z' }],
      ['a healthy mailbox', null],
      ['an older API with no field', undefined],
      ['a malformed count', { count: 'many' }],
    ])('stays quiet for %s', async (_label, value) => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [connectedRow(value)] }));
      render(<M365MailboxCard />);
      expect(await screen.findByText('support@a.com')).toBeInTheDocument();
      expect(screen.queryByTestId('m365-poll-failing')).toBeNull();
    });
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
      const routerState = { index: 5, scrollX: 0, scrollY: 0 };
      window.history.replaceState(routerState, '');
      const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
      landOn(`?ticketMailbox=error&reason=${reason}`);
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [] }));

      render(<M365MailboxCard />);

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: expect.stringMatching(message) }),
        ),
      );
      // #8331: the router's history.state is passed through, never wiped with {}.
      expect(replaceState).toHaveBeenCalledWith(routerState, '', '/settings/ticketing#email');
      replaceState.mockRestore();
    });

    it('falls back to the generic failure for an unknown or absent reason', async () => {
      const routerState = { index: 5, scrollX: 0, scrollY: 0 };
      window.history.replaceState(routerState, '');
      const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
      landOn('?ticketMailbox=error&reason=%3Cscript%3E');
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [] }));

      render(<M365MailboxCard />);

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'M365 connection failed' }),
      );
      expect(replaceState).toHaveBeenCalledWith(routerState, '', '/settings/ticketing#email');
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
