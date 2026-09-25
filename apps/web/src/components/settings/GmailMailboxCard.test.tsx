import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { fetchWithAuth, fetchAllOrganizationsFrom, grantedActions, showToast } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  fetchAllOrganizationsFrom: vi.fn(),
  grantedActions: new Set<string>(['ticket_mailbox:read', 'ticket_mailbox:admin']),
  showToast: vi.fn(),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));
vi.mock('../../lib/fetchAllOrganizations', () => ({
  fetchAllOrganizationsFrom: (...a: any[]) => fetchAllOrganizationsFrom(...a),
}));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({
    can: (resource: string, action: string) => grantedActions.has(`${resource}:${action}`),
  }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));
vi.mock('../shared/Toast', () => ({ showToast }));

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
      // Faithful to the real runAction: a non-OK response (and an HTTP-200
      // {success:false} body) is a FAILURE, not a silent success. Tests must not
      // be able to pass a handler that ignores a failed request.
      if (!res.ok || (data && typeof data === 'object' && data.success === false)) {
        // The real runAction shows an error toast for a non-401 failure before
        // throwing; mirror that so a test can assert feedback is surfaced.
        showToast({ type: 'error', message: opts.errorFallback ?? 'failed' });
        throw new ActionError(opts.errorFallback ?? 'failed', res.status ?? 0);
      }
      return opts.parseSuccess ? opts.parseSuccess(data) : data;
    },
  };
});

import GmailMailboxCard from './GmailMailboxCard';

function jsonRes(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const GROW = { id: 'g1', provider: 'gmail', orgId: 'org-1', mailboxAddress: 'help@client.example', displayName: 'Help', status: 'connected', lastPolledAt: null, lastMessageAt: null };

describe('GmailMailboxCard', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchAllOrganizationsFrom.mockReset();
    showToast.mockReset();
    fetchAllOrganizationsFrom.mockResolvedValue([{ id: 'org-1', name: 'Acme' }]);
    grantedActions.clear();
    grantedActions.add('ticket_mailbox:read');
    grantedActions.add('ticket_mailbox:admin');
  });

  it('hides the surface and does not fetch without read permission', () => {
    grantedActions.clear();
    render(<GmailMailboxCard />);
    expect(screen.queryByTestId('gmail-mailbox-card')).not.toBeInTheDocument();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('shows a load error (not a false empty state) when the connections list fetch fails', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'unavailable' }, false, 503));
    render(<GmailMailboxCard />);
    expect(await screen.findByTestId('gmail-load-error')).toBeInTheDocument();
    // It must NOT claim the mailbox is simply not connected.
    expect(screen.queryByText(/No Gmail mailbox connected/i)).not.toBeInTheDocument();
  });

  it('lists gmail rows and filters out m365 rows', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({
        connections: [
          GROW,
          { id: 'm1', provider: 'm365', orgId: null, mailboxAddress: 'support@a.com', displayName: 'Support', status: 'connected', lastPolledAt: null, lastMessageAt: null },
        ],
      }),
    );
    render(<GmailMailboxCard />);
    expect(await screen.findByText('help@client.example')).toBeInTheDocument();
    // the m365 row belongs to the Microsoft card and must not appear here
    expect(screen.queryByText('support@a.com')).not.toBeInTheDocument();
  });

  it('names the organization whose Google Workspace connection holds each mailbox credential', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [GROW, { ...GROW, id: 'g9', orgId: 'org-hidden', mailboxAddress: 'other@client.example' }] }));
    render(<GmailMailboxCard />);
    await screen.findByText('help@client.example');
    await waitFor(() => {
      const lines = screen.getAllByTestId('gmail-credential-org').map((el) => el.textContent);
      expect(lines[0]).toContain('Acme');
      expect(lines[1]).toContain('an organization you cannot view');
    });
  });

  it('treats one malformed connection row as a load error, never as "no mailbox connected"', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [{ ...GROW, status: 42 }] }));
    render(<GmailMailboxCard />);
    expect(await screen.findByTestId('gmail-load-error')).toBeInTheDocument();
    expect(screen.queryByText(/No Gmail mailbox connected/i)).not.toBeInTheDocument();
  });

  it('says the organization list failed, disables the picker, and does not claim the org is hidden', async () => {
    fetchAllOrganizationsFrom.mockReset();
    fetchAllOrganizationsFrom.mockRejectedValue(new Error('503'));
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [GROW] }));
    render(<GmailMailboxCard />);
    expect(await screen.findByTestId('gmail-orgs-load-error')).toBeInTheDocument();
    expect(screen.getByTestId('gmail-org')).toBeDisabled();
    await screen.findByText('help@client.example');
    const line = screen.getByTestId('gmail-credential-org').textContent ?? '';
    expect(line).toContain('org-1');
    expect(line).not.toContain('an organization you cannot view');
  });

  it('shows status but no mutation controls with read-only permission', async () => {
    grantedActions.delete('ticket_mailbox:admin');
    // No organizations:read either: the org list is never fetched for this user,
    // and the name comes from the connection row itself.
    fetchAllOrganizationsFrom.mockRejectedValue(new Error('403'));
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [{ ...GROW, orgName: 'Acme', status: 'reauth_required' }] }));
    render(<GmailMailboxCard />);
    expect(await screen.findByText('help@client.example')).toBeInTheDocument();
    expect(screen.queryByTestId('gmail-connect')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gmail-reconnect')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
    // Read-only users still see which organization's credential the mailbox uses.
    expect(screen.getByTestId('gmail-credential-org').textContent).toContain('Acme');
    expect(fetchAllOrganizationsFrom).not.toHaveBeenCalled();
  });

  it('connects a new gmail mailbox via the DWD route with the selected org', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [] })); // initial refresh
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connectionId: 'g2', status: 'connected' })); // connect
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [] })); // post-connect refresh

    render(<GmailMailboxCard />);
    await screen.findByTestId('gmail-mailbox-card');
    await waitFor(() => expect(fetchAllOrganizationsFrom).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('gmail-org'), { target: { value: 'org-1' } });
    fireEvent.change(screen.getByLabelText(/mailbox address/i), { target: { value: 'help@client.example' } });
    fireEvent.click(screen.getByTestId('gmail-connect'));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => c[0] === '/tickets/mailbox/connect/gmail');
      expect(call).toBeTruthy();
      expect(call![1].method).toBe('POST');
      expect(JSON.parse(call![1].body)).toMatchObject({ orgId: 'org-1', mailboxAddress: 'help@client.example' });
    });
  });

  it('surfaces a failed connect (e.g. no Google Workspace credential) and does not clear the form', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [] })); // initial refresh
    // 400 no_google_connection — the faithful runAction mock throws ActionError.
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'no_google_connection' }, false, 400));

    render(<GmailMailboxCard />);
    await screen.findByTestId('gmail-mailbox-card');
    await waitFor(() => expect(fetchAllOrganizationsFrom).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('gmail-org'), { target: { value: 'org-1' } });
    const addr = screen.getByLabelText(/mailbox address/i) as HTMLInputElement;
    fireEvent.change(addr, { target: { value: 'help@client.example' } });
    fireEvent.click(screen.getByTestId('gmail-connect'));

    await waitFor(() => {
      expect(fetchWithAuth.mock.calls.some((c) => c[0] === '/tickets/mailbox/connect/gmail')).toBe(true);
    });
    // The failure is SURFACED to the user (real runAction toasts non-401 failures).
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    // And the address field is NOT cleared (only a success clears it).
    expect(addr.value).toBe('help@client.example');
  });

  it('reconnects an existing row against its own org (provider-correct, not the Microsoft consent path)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [{ ...GROW, status: 'reauth_required' }] }));
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connectionId: 'g1', status: 'connected' })); // reconnect
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [GROW] })); // refresh

    render(<GmailMailboxCard />);
    fireEvent.click(await screen.findByTestId('gmail-reconnect'));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => c[0] === '/tickets/mailbox/connect/gmail');
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1].body)).toMatchObject({ orgId: 'org-1', mailboxAddress: 'help@client.example' });
    });
  });

  it('disables disconnect while a reconnect is in flight (guards the resurrect-vs-disconnect race)', async () => {
    let resolveConnect!: (v: any) => void;
    const pending = new Promise((r) => { resolveConnect = r; });
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [{ ...GROW, status: 'reauth_required' }] })); // initial
    fetchWithAuth.mockReturnValueOnce(pending as any); // reconnect POST stays pending
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [GROW] })); // post-reconnect refresh

    render(<GmailMailboxCard />);
    fireEvent.click(await screen.findByTestId('gmail-reconnect'));

    await waitFor(() =>
      expect((screen.getByTestId('gmail-disconnect') as HTMLButtonElement).disabled).toBe(true),
    );
    // Let the reconnect finish so state settles.
    resolveConnect(jsonRes({ connectionId: 'g1', status: 'connected' }));
    await waitFor(() =>
      expect((screen.getByTestId('gmail-disconnect') as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('disconnects a row via DELETE on the shared connection endpoint', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [GROW] }));
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ ok: true })); // delete
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ connections: [] })); // refresh

    render(<GmailMailboxCard />);
    fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => c[0] === '/tickets/mailbox/connections/g1');
      expect(call).toBeTruthy();
      expect(call![1].method).toBe('DELETE');
    });
  });
});
