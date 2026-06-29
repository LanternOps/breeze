import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: any[]) => fetchWithAuth(...a) }));
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
  beforeEach(() => fetchWithAuth.mockReset());

  it('lists existing connections on mount', async () => {
    fetchWithAuth.mockResolvedValueOnce(
      jsonRes({
        connections: [
          { id: 'c1', mailboxAddress: 'support@a.com', displayName: 'Support', status: 'connected', tenantId: 't', lastPolledAt: null, lastError: null },
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
    Object.defineProperty(window, 'location', { value: { assign, href: '', hash: '', pathname: '/settings/partner' }, writable: true });

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

  it('Re-test calls the retest endpoint', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(
        jsonRes({
          connections: [
            { id: 'c1', mailboxAddress: 'support@a.com', displayName: null, status: 'error', tenantId: 't', lastPolledAt: null, lastError: 'Graph returned 403' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonRes({ ok: true }))
      .mockResolvedValueOnce(jsonRes({ connections: [] }));
    render(<M365MailboxCard />);
    fireEvent.click(await screen.findByRole('button', { name: /re-test/i }));
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
            { id: 'c1', mailboxAddress: 'support@a.com', displayName: null, status: 'connected', tenantId: 't', lastPolledAt: null, lastError: null },
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
