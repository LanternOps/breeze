import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { getOfficeMock } from '../__tests__/officeMock';
import { TechPane } from './TechPane';
import * as api from './api';
import type { EmailContextResponse } from './api';

const session = {
  v: 2 as const,
  persona: 'tech' as const,
  sessionToken: 'tech-tok',
  expiresAt: Date.now() + 60_000,
  user: { id: 'u-2', email: 'tech@partner.example', name: 'Tech User' },
  partner: { id: 'p-1' },
};

function emptyContext(itemGeneration: number): EmailContextResponse {
  return {
    itemGeneration,
    org: null,
    contacts: [],
    threadMatchedTicket: null,
    openTickets: [],
    recentTickets: [],
    orgSummary: null,
    inboundPathConfigured: true,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(api, 'fetchEmailContext').mockResolvedValue(emptyContext(0));
});

describe('TechPane', () => {
  it('compose mode shows the explanatory disabled state and never fetches', async () => {
    getOfficeMock().setItem({ subject: 'Draft' }, 'compose');
    render(<TechPane session={session} />);
    await waitFor(() => expect(screen.getByTestId('tech-compose-state')).toBeTruthy());
    expect(api.fetchEmailContext).not.toHaveBeenCalled();
  });

  it('no open item shows the empty state and never fetches', async () => {
    const g = globalThis as { Office?: { context?: { mailbox?: unknown } } };
    if (g.Office?.context) g.Office.context.mailbox = undefined;
    render(<TechPane session={session} />);
    await waitFor(() => expect(screen.getByTestId('tech-empty-state')).toBeTruthy());
    expect(api.fetchEmailContext).not.toHaveBeenCalled();
  });

  it('shared mailbox shows the informational notice and never fetches', async () => {
    getOfficeMock().setItem(
      { subject: 'Shared', from: { displayName: 'A', emailAddress: 'a@x.com' }, sharedMailbox: true },
      'read',
    );
    render(<TechPane session={session} />);
    await waitFor(() => expect(screen.getByTestId('tech-shared-mailbox-notice')).toBeTruthy());
    expect(screen.getByTestId('tech-shared-mailbox-notice').textContent).toContain(
      "Shared mailboxes aren't supported yet",
    );
    expect(api.fetchEmailContext).not.toHaveBeenCalled();
  });

  it('read mode fetches email context and renders ContextCard + TicketList', async () => {
    getOfficeMock().setItem(
      { subject: 'Printer down', from: { displayName: 'Alice', emailAddress: 'alice@acme.com' } },
      'read',
    );
    vi.spyOn(api, 'fetchEmailContext').mockResolvedValue({
      ...emptyContext(0),
      org: { id: 'org-1', name: 'Acme' },
    });
    render(<TechPane session={session} />);
    await waitFor(() => expect(screen.getByTestId('context-card')).toBeTruthy());
    expect(screen.getByTestId('context-card-org').textContent).toContain('Acme');
    expect(api.fetchEmailContext).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Printer down', itemGeneration: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('a fetch failure surfaces a dismissible tech-banner', async () => {
    getOfficeMock().setItem(
      { subject: 'x', from: { displayName: 'A', emailAddress: 'a@x.com' } },
      'read',
    );
    vi.spyOn(api, 'fetchEmailContext').mockRejectedValue(new api.TechApiError(500, 'server_error'));
    render(<TechPane session={session} />);
    await waitFor(() => expect(screen.getByTestId('tech-banner')).toBeTruthy());
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    dismiss.click();
    await waitFor(() => expect(screen.queryByTestId('tech-banner')).toBeNull());
  });

  it('rapid switchItem() twice renders only the latest generation, the earlier response is discarded', async () => {
    getOfficeMock().setItem(
      { subject: 'first', from: { displayName: 'A', emailAddress: 'a@x.com' } },
      'read',
    );

    let resolveFirst!: (v: EmailContextResponse) => void;
    const firstPromise = new Promise<EmailContextResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchSpy = vi.spyOn(api, 'fetchEmailContext');
    fetchSpy.mockImplementationOnce(async () => firstPromise);
    fetchSpy.mockImplementationOnce(async () => ({
      ...emptyContext(1),
      org: { id: 'org-second', name: 'Second Org' },
    }));

    render(<TechPane session={session} />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // Switch item BEFORE the first fetch resolves — bumps generation to 1 and
    // kicks off the second (faster) fetch.
    getOfficeMock().switchItem(
      { subject: 'second', from: { displayName: 'B', emailAddress: 'b@x.com' } },
      'read',
    );
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('context-card-org').textContent).toContain('Second Org'));

    // Now let the FIRST (stale) fetch resolve — its itemGeneration (0) no
    // longer matches the store's current generation (1), so it must be
    // discarded rather than clobbering the second org's render.
    resolveFirst({ ...emptyContext(0), org: { id: 'org-first', name: 'First Org' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('context-card-org').textContent).toContain('Second Org');
    expect(screen.queryByText('First Org')).toBeNull();
  });
});
