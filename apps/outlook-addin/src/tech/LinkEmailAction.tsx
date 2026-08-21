/**
 * Link-email action (Task 23): attaches the open message to an already-
 * selected ticket via `linkEmail`, with a visibility toggle (public comment /
 * internal note). Two 409s are handled INLINE rather than as generic
 * failures, because each has a specific recovery affordance the technician
 * needs right now:
 *   - `ticket_closed` -> "Create linked follow-up" (fires `createTicketFromEmail`
 *     with `followUpOf`, carrying the closed ticket's thread forward).
 *   - `message_linked_elsewhere` -> "Open ticket <internalNumber>" (surfaces
 *     the ticket that already owns this message instead of silently no-oping).
 * Every other failure (network, other 4xx/5xx) surfaces via `onBanner`, same
 * as the rest of the pane. Success reports through `onDone` AND a local inline
 * `action-success` confirmation.
 */
import { useState } from 'react';
import {
  createTicketFromEmail,
  linkEmail,
  TechApiError,
  type AddinTicketSummary,
  type FromEmailResponse,
  type LinkEmailResponse,
} from './api';
import type { EmailIdentity } from './emailIdentity';

/** The subset of ticket fields this action needs — satisfied by both
 *  `AddinTicketSummary` (ticket list rows) and `MatchedTicket` (thread match). */
export interface LinkableTicket {
  id: string;
  internalNumber: string | null;
}

export type LinkEmailActionResult =
  | { kind: 'linked'; result: LinkEmailResponse }
  | { kind: 'followUpCreated'; result: FromEmailResponse };

export interface LinkEmailActionProps {
  ticket: LinkableTicket;
  identity: EmailIdentity;
  bodyText: string;
  /** The org the selected ticket lives in — required to create a linked
   *  follow-up ticket (from-email requires `orgId`). */
  orgId: string | null;
  onDone: (result: LinkEmailActionResult) => void;
  onBanner: (message: string | null) => void;
  /** Opening the other ticket is out of scope for this task — a no-op callback
   *  keeps the affordance real without pretending navigation exists yet. */
  onShowTicket?: (ticket: LinkableTicket) => void;
}

type ClosedConflict = { kind: 'ticket_closed'; ticket: LinkableTicket & { emailThreadKey: string | null } };
type ElsewhereConflict = { kind: 'message_linked_elsewhere'; ticket: AddinTicketSummary | null };
type Conflict = ClosedConflict | ElsewhereConflict;

/** The `message_linked_elsewhere` 409 affordance — the winner ticket plus an
 *  "Open ticket" button — shared with CreateTicketForm, whose from-email call
 *  can hit the same conflict. */
export function MessageLinkedElsewhereNotice({
  ticket,
  onShowTicket,
}: {
  ticket: AddinTicketSummary | null;
  onShowTicket?: (ticket: AddinTicketSummary) => void;
}) {
  return (
    <div data-testid="link-conflict-elsewhere" className="flex flex-col gap-1 text-xs text-amber-800">
      {ticket ? (
        <>
          <span>This message is already linked to another ticket.</span>
          <button
            type="button"
            data-testid="open-other-ticket-button"
            onClick={() => onShowTicket?.(ticket)}
            className="w-fit rounded-md border border-amber-300 bg-amber-50 px-2 py-1 hover:bg-amber-100"
          >
            Open ticket {ticket.internalNumber ?? ticket.id}
          </button>
        </>
      ) : (
        <span>This message is already linked to a ticket you don&apos;t have access to.</span>
      )}
    </div>
  );
}

/** Fallback quote used when the deterministic follow-up ticket is created
 *  from a closed-ticket link attempt — mirrors CreateTicketForm's truncation. */
function trimmedDescription(bodyText: string): string {
  return bodyText.trim().slice(0, 2000);
}

export function LinkEmailAction({
  ticket,
  identity,
  bodyText,
  orgId,
  onDone,
  onBanner,
  onShowTicket,
}: LinkEmailActionProps) {
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public');
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const from = identity.from;

  async function handleLink(): Promise<void> {
    if (!from) return;
    setSubmitting(true);
    setConflict(null);
    setSuccess(null);
    onBanner(null);
    try {
      const result = await linkEmail(ticket.id, {
        visibility,
        from,
        internetMessageId: identity.internetMessageId,
        subject: identity.subject,
        bodyText,
      });
      setSuccess('Email linked to the ticket.');
      onDone({ kind: 'linked', result });
    } catch (err) {
      if (err instanceof TechApiError && err.status === 409) {
        const body = err.body as { error: string; ticket: unknown } | null;
        if (err.code === 'ticket_closed' && body) {
          setConflict({ kind: 'ticket_closed', ticket: body.ticket as ClosedConflict['ticket'] });
          return;
        }
        if (err.code === 'message_linked_elsewhere') {
          setConflict({
            kind: 'message_linked_elsewhere',
            ticket: (body?.ticket ?? null) as AddinTicketSummary | null,
          });
          return;
        }
      }
      onBanner(err instanceof TechApiError ? `Failed to link email (${err.code}).` : 'Failed to link email.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCreateFollowUp(closed: ClosedConflict['ticket']): Promise<void> {
    if (!from || !orgId) {
      onBanner('Cannot create a follow-up ticket — no organization resolved.');
      return;
    }
    setSubmitting(true);
    onBanner(null);
    try {
      const result = await createTicketFromEmail({
        orgId,
        subject: identity.subject,
        description: trimmedDescription(bodyText),
        from,
        internetMessageId: identity.internetMessageId,
        requester: { kind: 'raw' },
        followUpOf: { ticketId: closed.id },
      });
      setConflict(null);
      setSuccess('Linked follow-up ticket created.');
      onDone({ kind: 'followUpCreated', result });
    } catch (err) {
      onBanner(
        err instanceof TechApiError
          ? `Failed to create follow-up ticket (${err.code}).`
          : 'Failed to create follow-up ticket.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="link-email-action" className="flex flex-col gap-2 rounded-md border border-gray-200 p-3">
      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="link-visibility"
            data-testid="link-visibility-public"
            checked={visibility === 'public'}
            onChange={() => setVisibility('public')}
          />
          Public comment
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="link-visibility"
            data-testid="link-visibility-internal"
            checked={visibility === 'internal'}
            onChange={() => setVisibility('internal')}
          />
          Internal note
        </label>
      </div>
      <button
        type="button"
        data-testid="link-email-submit"
        onClick={() => void handleLink()}
        disabled={submitting || !from}
        className="rounded-md border border-gray-300 px-2 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
      >
        Link email to ticket {ticket.internalNumber ?? ticket.id}
      </button>

      {success && (
        <div data-testid="action-success" className="text-xs text-green-700">
          {success}
        </div>
      )}

      {conflict?.kind === 'ticket_closed' && (
        <div data-testid="link-conflict-ticket-closed" className="flex flex-col gap-1 text-xs text-amber-800">
          <span>This ticket is closed — link it as a new follow-up instead.</span>
          <button
            type="button"
            data-testid="create-followup-button"
            onClick={() => void handleCreateFollowUp(conflict.ticket)}
            disabled={submitting}
            className="w-fit rounded-md border border-amber-300 bg-amber-50 px-2 py-1 hover:bg-amber-100 disabled:opacity-50"
          >
            Create linked follow-up
          </button>
        </div>
      )}

      {conflict?.kind === 'message_linked_elsewhere' && (
        <MessageLinkedElsewhereNotice ticket={conflict.ticket} onShowTicket={onShowTicket} />
      )}
    </div>
  );
}
