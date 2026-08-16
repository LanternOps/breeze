import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateTicketForm } from './CreateTicketForm';
import * as api from './api';
import { TechApiError } from './api';
import type { EmailContextResponse } from './api';
import type { EmailIdentity } from './emailIdentity';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const identity: EmailIdentity = {
  mode: 'read',
  subject: 'Printer down',
  from: { email: 'alice@acme.com', name: 'Alice' },
  sender: { email: 'alice@acme.com', name: 'Alice' },
  conversationId: 'conv-1',
  internetMessageId: '<msg-1@acme.com>',
  references: [],
  inReplyTo: null,
  headerCapable: true,
  sharedMailbox: false,
};

function baseContext(overrides: Partial<EmailContextResponse> = {}): EmailContextResponse {
  return {
    itemGeneration: 0,
    org: { id: 'org-1', name: 'Acme' },
    contacts: [],
    threadMatchedTicket: null,
    openTickets: [],
    recentTickets: [],
    orgSummary: null,
    inboundPathConfigured: true,
    ...overrides,
  };
}

function baseProps(overrides: Partial<ComponentProps<typeof CreateTicketForm>> = {}) {
  return {
    context: baseContext(),
    identity,
    bodyText: 'The printer on 3rd floor is jammed badly.',
    orgOverride: null,
    onDone: vi.fn(),
    onBanner: vi.fn(),
    ...overrides,
  };
}

describe('CreateTicketForm', () => {
  it('shows the deterministic fallback prefill immediately, before fetchDraft resolves', async () => {
    let resolveDraft!: (v: api.DraftResponse) => void;
    vi.spyOn(api, 'fetchDraft').mockImplementation(
      () => new Promise((resolve) => { resolveDraft = resolve; }),
    );
    render(<CreateTicketForm {...baseProps()} />);

    expect((screen.getByTestId('create-ticket-subject') as HTMLInputElement).value).toBe('Printer down');
    expect((screen.getByTestId('create-ticket-description') as HTMLTextAreaElement).value).toBe(
      'The printer on 3rd floor is jammed badly.',
    );
    expect(screen.queryByTestId('ai-draft-badge-subject')).toBeNull();

    // Resolve later so the test doesn't leave a dangling promise.
    resolveDraft({
      draft: { subject: 'AI subject', summary: 'AI summary', suggestedTimeMinutes: 10, inputTokens: 1, outputTokens: 1 },
    });
    await waitFor(() => expect(screen.getByTestId('ai-draft-badge-subject')).toBeTruthy());
  });

  it('AI result swaps in ONLY fields the technician has not edited yet', async () => {
    let resolveDraft!: (v: api.DraftResponse) => void;
    vi.spyOn(api, 'fetchDraft').mockImplementation(
      () => new Promise((resolve) => { resolveDraft = resolve; }),
    );
    render(<CreateTicketForm {...baseProps()} />);

    // Technician edits the subject before AI resolves.
    fireEvent.change(screen.getByTestId('create-ticket-subject'), {
      target: { value: 'My own subject' },
    });

    resolveDraft({
      draft: { subject: 'AI subject', summary: 'AI summary', suggestedTimeMinutes: 10, inputTokens: 1, outputTokens: 1 },
    });

    await waitFor(() =>
      expect((screen.getByTestId('create-ticket-description') as HTMLTextAreaElement).value).toBe(
        'AI summary',
      ),
    );
    // Subject was dirty -> must NOT be clobbered.
    expect((screen.getByTestId('create-ticket-subject') as HTMLInputElement).value).toBe('My own subject');
    expect(screen.queryByTestId('ai-draft-badge-subject')).toBeNull();
    expect(screen.getByTestId('ai-draft-badge-description')).toBeTruthy();
  });

  it('AI 4xx/5xx/timeout keeps the fallback silently (no banner)', async () => {
    vi.spyOn(api, 'fetchDraft').mockRejectedValue(new TechApiError(503, 'ai_unavailable'));
    const onBanner = vi.fn();
    render(<CreateTicketForm {...baseProps({ onBanner })} />);
    await new Promise((r) => setTimeout(r, 0));
    expect((screen.getByTestId('create-ticket-subject') as HTMLInputElement).value).toBe('Printer down');
    expect(onBanner).not.toHaveBeenCalled();
  });

  it('posts the exact fromEmailSchema shape including internetMessageId and requester union (raw)', async () => {
    vi.spyOn(api, 'fetchDraft').mockResolvedValue({
      draft: { subject: 'x', summary: 'y', suggestedTimeMinutes: 5, inputTokens: 1, outputTokens: 1 },
    });
    const createSpy = vi.spyOn(api, 'createTicketFromEmail').mockResolvedValue({
      ticket: { id: 't-1', internalNumber: 'T-1', subject: 'x', status: 'new', priority: null, updatedAt: '', submitterEmail: null, matchesSubmitter: false },
      alreadyExisted: false,
    });
    render(<CreateTicketForm {...baseProps()} />);

    fireEvent.click(screen.getByTestId('create-ticket-submit'));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith({
      orgId: 'org-1',
      subject: 'Printer down',
      description: 'The printer on 3rd floor is jammed badly.',
      from: { email: 'alice@acme.com', name: 'Alice' },
      internetMessageId: '<msg-1@acme.com>',
      requester: { kind: 'raw' },
      followUpOf: null,
    });
  });

  it('create_contact requires the explicit confirm checkbox before submit is enabled', async () => {
    vi.spyOn(api, 'fetchDraft').mockResolvedValue({
      draft: { subject: 'x', summary: 'y', suggestedTimeMinutes: 5, inputTokens: 1, outputTokens: 1 },
    });
    const createSpy = vi.spyOn(api, 'createTicketFromEmail').mockResolvedValue({
      ticket: { id: 't-1', internalNumber: 'T-1', subject: 'x', status: 'new', priority: null, updatedAt: '', submitterEmail: null, matchesSubmitter: false },
      alreadyExisted: false,
    });
    render(<CreateTicketForm {...baseProps()} />);

    fireEvent.click(screen.getByTestId('requester-mode-create-contact'));
    fireEvent.change(screen.getByTestId('create-contact-email'), {
      target: { value: 'new@acme.com' },
    });

    const submit = screen.getByTestId('create-ticket-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(createSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('create-contact-confirm'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requester: { kind: 'create_contact', email: 'new@acme.com', name: 'Alice' },
      }),
    );
  });

  it('surfaces a create failure via onBanner', async () => {
    vi.spyOn(api, 'fetchDraft').mockResolvedValue({
      draft: { subject: 'x', summary: 'y', suggestedTimeMinutes: 5, inputTokens: 1, outputTokens: 1 },
    });
    vi.spyOn(api, 'createTicketFromEmail').mockRejectedValue(new TechApiError(400, 'bad_request'));
    const onBanner = vi.fn();
    render(<CreateTicketForm {...baseProps({ onBanner })} />);
    fireEvent.click(screen.getByTestId('create-ticket-submit'));
    await waitFor(() => expect(onBanner).toHaveBeenCalledWith(expect.stringContaining('bad_request')));
  });
});
