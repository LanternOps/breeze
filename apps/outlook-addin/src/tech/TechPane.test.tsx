import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  // TimeWidget (Task 24) polls this unconditionally once the pane is ready —
  // stub it so pane-level tests don't hit the real network.
  vi.spyOn(api, 'fetchRunningTimer').mockResolvedValue({ running: null });
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

  it('a failed body read warns on console and gates create behind a warning; retry recovers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mock = getOfficeMock();
    mock.setItem(
      { subject: 'Printer down', body: 'the body', from: { displayName: 'A', emailAddress: 'a@x.com' } },
      'read',
    );
    mock.failBodyGet = true;
    vi.spyOn(api, 'fetchEmailContext').mockResolvedValue({
      ...emptyContext(0),
      org: { id: 'org-1', name: 'Acme' },
    });
    // Never resolves — this test asserts the DETERMINISTIC prefill after retry,
    // which a resolved AI draft would overwrite.
    vi.spyOn(api, 'fetchDraft').mockImplementation(() => new Promise(() => {}));
    render(<TechPane session={session} />);
    await waitFor(() => expect(screen.getByTestId('create-ticket-button')).toBeTruthy());
    expect(warnSpy).toHaveBeenCalledWith(
      'TechPane: failed to read the message body',
      expect.anything(),
    );

    fireEvent.click(screen.getByTestId('create-ticket-button'));
    await waitFor(() => expect(screen.getByTestId('body-read-warning')).toBeTruthy());
    expect(screen.queryByTestId('create-ticket-form')).toBeNull();

    // Host recovered — retry swaps the real body in and reveals the form.
    mock.failBodyGet = false;
    fireEvent.click(screen.getByTestId('body-read-retry'));
    await waitFor(() => expect(screen.getByTestId('create-ticket-form')).toBeTruthy());
    expect(screen.queryByTestId('body-read-warning')).toBeNull();
    expect((screen.getByTestId('create-ticket-description') as HTMLTextAreaElement).value).toBe(
      'the body',
    );
  });

  it('an explicit "Continue without body" acknowledges the failed read and reveals the form', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mock = getOfficeMock();
    mock.setItem(
      { subject: 'Printer down', from: { displayName: 'A', emailAddress: 'a@x.com' } },
      'read',
    );
    mock.failBodyGet = true;
    vi.spyOn(api, 'fetchEmailContext').mockResolvedValue({
      ...emptyContext(0),
      org: { id: 'org-1', name: 'Acme' },
    });
    vi.spyOn(api, 'fetchDraft').mockResolvedValue({
      draft: { subject: 'x', summary: 'y', suggestedTimeMinutes: 5, inputTokens: 1, outputTokens: 1 },
    });
    render(<TechPane session={session} />);
    await waitFor(() => expect(screen.getByTestId('create-ticket-button')).toBeTruthy());

    fireEvent.click(screen.getByTestId('create-ticket-button'));
    await waitFor(() => expect(screen.getByTestId('body-read-warning')).toBeTruthy());
    fireEvent.click(screen.getByTestId('body-read-continue'));
    await waitFor(() => expect(screen.getByTestId('create-ticket-form')).toBeTruthy());
  });

  it('a created ticket flows through onDone and becomes the selected (linkable) ticket', async () => {
    getOfficeMock().setItem(
      { subject: 'Printer down', body: 'b', from: { displayName: 'A', emailAddress: 'a@x.com' } },
      'read',
    );
    vi.spyOn(api, 'fetchEmailContext').mockResolvedValue({
      ...emptyContext(0),
      org: { id: 'org-1', name: 'Acme' },
    });
    vi.spyOn(api, 'fetchDraft').mockResolvedValue({
      draft: { subject: 'x', summary: 'y', suggestedTimeMinutes: 5, inputTokens: 1, outputTokens: 1 },
    });
    vi.spyOn(api, 'createTicketFromEmail').mockResolvedValue({
      ticket: { id: 't-1', internalNumber: 'T-1', subject: 'x', status: 'new', priority: null, updatedAt: '', submitterEmail: null, matchesSubmitter: false },
      alreadyExisted: true,
    });
    render(<TechPane session={session} />);
    await waitFor(() => expect(screen.getByTestId('create-ticket-button')).toBeTruthy());

    fireEvent.click(screen.getByTestId('create-ticket-button'));
    await waitFor(() => expect(screen.getByTestId('create-ticket-form')).toBeTruthy());
    fireEvent.click(screen.getByTestId('create-ticket-submit'));

    // The form closes and the created/existing ticket is selected for linking.
    await waitFor(() => expect(screen.getByTestId('link-email-action')).toBeTruthy());
    expect(screen.getByTestId('link-email-submit').textContent).toContain('T-1');
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
