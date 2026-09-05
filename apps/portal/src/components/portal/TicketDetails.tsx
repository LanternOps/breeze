import { PORTAL_TICKET_COMMENT_MAX_CHARS } from '@breeze/shared';
import { withBase } from '@/lib/basePath';
import React, { useEffect, useState } from 'react';
import { ArrowLeft, AlertCircle, Loader2 } from 'lucide-react';
import {
  portalApi,
  portalAttachmentContentPath,
  type TicketComment,
  type TicketCommentAttachment,
  type TicketDetails as TicketDetailsType,
  type TicketStatus,
} from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY, INPUT, StatusMark } from './ui';
import { ticketStatusLabel, ticketStatusTone } from './ticketMarks';
import { TicketSlaBadge } from './TicketList';

/** Activity copy derived from the ticket's own status. This component only ever
 *  sees the ticket record plus its public replies, so it must never assert that
 *  nothing has happened: the old hardcoded "No activity yet" told a customer with
 *  a resolved, long-since-answered ticket that their MSP had ignored them. */
function activityStatusText(status: TicketStatus, updatedAt: string | null): string {
  const when = updatedAt ? ` Last updated ${formatDate(updatedAt)}.` : '';
  switch (status) {
    case 'new':
      return 'We have your request. Our support team will follow up here.';
    case 'open':
      return 'A technician is on this. Updates appear here.';
    case 'pending':
      return 'We need something from you to keep going — see the latest reply below.';
    case 'on_hold':
      return `This request is on hold.${when}`;
    case 'resolved':
      return `This ticket is resolved.${when}`;
    case 'closed':
      return `This ticket is closed.${when}`;
    default:
      return when.trim() || 'Updates appear here.';
  }
}

interface TicketDetailsProps {
  ticket: TicketDetailsType | null;
  error?: string | null;
  /** HTTP status of the failed load: 404 reads as \"not found\"; anything else is an outage. */
  statusCode?: number;
}

/**
 * Render-only attachment strip under a public comment (W08 #3902). Images are
 * plain <img> tags: the request is same-origin and the portal session cookie
 * rides along, so no blob fetch is needed. Anything else is a download link.
 */
function CommentAttachments({
  ticketId,
  attachments,
}: {
  ticketId: string;
  attachments?: TicketCommentAttachment[];
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <ul className="mt-2.5 flex flex-wrap gap-2" data-testid="ticket-attachment-list">
      {attachments.map((a) =>
        a.contentType.startsWith('image/') ? (
          <li key={a.id}>
            <a
              href={portalAttachmentContentPath(ticketId, a.id)}
              target="_blank"
              rel="noreferrer"
              data-testid={`ticket-attachment-link-${a.id}`}
            >
              <img
                src={portalAttachmentContentPath(ticketId, a.id)}
                alt={a.originalFilename}
                loading="lazy"
                className="h-24 w-24 rounded border border-border/70 object-cover"
                data-testid={`ticket-attachment-image-${a.id}`}
              />
            </a>
          </li>
        ) : (
          <li key={a.id}>
            <a
              href={portalAttachmentContentPath(ticketId, a.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded border border-border/70 px-2.5 py-1.5 text-xs text-foreground hover:bg-muted"
              data-testid={`ticket-attachment-file-${a.id}`}
            >
              {a.originalFilename}
            </a>
          </li>
        ),
      )}
    </ul>
  );
}

/** The reply box that closes the loop the create-form promises ("say so in the
 *  ticket and we will update it"). Posts to the ticket's own comment thread;
 *  the new reply is appended locally so the conversation updates in place. */
function ReplyComposer({
  ticketId,
  onPosted,
}: {
  ticketId: string;
  onPosted: (comment: TicketComment) => void;
}) {
  const [content, setContent] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // A reply typed against an expired session is lost when the API's 401 sends
  // the customer to /login — the composer unmounts with their words in it.
  // Keep the draft in sessionStorage (per tab, per ticket) while it is being
  // written; restore it after sign-in brings them back; drop it once posted.
  const draftKey = `portal:reply-draft:${ticketId}`;
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(draftKey);
      if (saved) setContent(saved);
    } catch {
      /* storage unavailable (private mode, disabled) — the draft just isn't kept */
    }
  }, [draftKey]);
  const stash = (next: string) => {
    try {
      if (next.trim()) sessionStorage.setItem(draftKey, next);
      else sessionStorage.removeItem(draftKey);
    } catch {
      /* see above */
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || isSending) return;
    setIsSending(true);
    setSendError(null);
    const result = await portalApi.addTicketComment(ticketId, trimmed);
    if (result.data) {
      onPosted(result.data);
      setContent('');
      stash('');
    } else {
      setSendError(result.error || 'Your reply was not sent. Try again.');
    }
    setIsSending(false);
  };

  return (
    <form onSubmit={send} className="mt-5" data-testid="ticket-reply-form">
      <label htmlFor="ticket-reply" className="block text-sm font-medium text-foreground">
        Add a reply
      </label>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Anything you add here goes straight to your IT team.
      </p>
      <textarea
        id="ticket-reply"
        rows={3}
        maxLength={PORTAL_TICKET_COMMENT_MAX_CHARS}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          stash(e.target.value);
        }}
        disabled={isSending}
        placeholder="Has anything changed? Let us know here."
        className={cn(INPUT, 'min-h-[5.5rem] resize-y')}
        data-testid="ticket-reply-input"
      />
      {sendError && (
        <p role="alert" className="mt-2 text-sm font-medium text-destructive-on-tint">
          {sendError}
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <button
          type="submit"
          disabled={isSending || content.trim().length === 0}
          className={BTN_PRIMARY}
          data-testid="ticket-reply-submit"
        >
          {isSending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Sending
            </>
          ) : (
            'Send reply'
          )}
        </button>
      </div>
    </form>
  );
}

export function TicketDetails({ ticket, error, statusCode }: TicketDetailsProps) {
  // The API returns public replies newest-first; this reads as a conversation
  // under the description, so show them oldest-first. `comments` is defensively
  // defaulted for any payload that predates the field. Local state so a reply
  // posted from this page appears in the thread without a reload.
  const [replies, setReplies] = useState<TicketComment[]>(() =>
    [...(ticket?.comments ?? [])].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
  );
  // Announced to screen readers when a reply lands; visually the thread itself
  // is the confirmation.
  const [posted, setPosted] = useState(false);
  // Timestamps are the viewer's local zone, which the server cannot know, and
  // React 19 does NOT patch text whose hydration mismatch is merely suppressed —
  // it only silences the diff. So render them only after mount: server and
  // first client paint agree (empty), then the local values fill in.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const when = (iso: string) => (mounted ? formatDateTime(iso) : '');

  if (error || !ticket) {
    return (
      <div className="border-y border-border/70 py-14 text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-destructive-on-tint" strokeWidth={1.5} />
        <h3 className="mt-4 font-display text-lg font-semibold text-foreground">
          {statusCode === 404 || !error ? 'Ticket not found' : "We couldn't load this ticket"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {statusCode === 404 || !error
            ? "We couldn't find that ticket — it may have been merged with another request. Your tickets list has the latest."
            : 'Something went wrong on our side. Try again in a moment; your tickets list is unaffected.'}
        </p>
        <a
          href={withBase('/tickets')}
          className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary-on-tint underline-offset-4 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tickets
        </a>
      </div>
    );
  }

  const tone = ticketStatusTone(ticket.status);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <a
          href={withBase('/tickets')}
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to tickets
        </a>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight text-foreground">
            {ticket.subject}
          </h1>
          <p className="text-figures mt-1 text-sm text-muted-foreground">#{ticket.ticketNumber}</p>
        </div>
        <div className="flex items-center gap-4 pt-1.5">
          <StatusMark tone={tone}>
            {ticketStatusLabel(ticket.status)}
          </StatusMark>
          <TicketSlaBadge sla={ticket.sla} testId="portal-ticket-sla-badge" />
          {/* Priority is context, not state: one mark per row. Urgent and high
              keep their tinted text; routine priorities stay muted. */}
          <span
            className={cn(
              'text-xs font-medium',
              ticket.priority === 'urgent'
                ? 'text-destructive-on-tint'
                : ticket.priority === 'high'
                  ? 'text-warning-on-tint'
                  : 'text-muted-foreground'
            )}
          >
            {ticket.priority.charAt(0).toUpperCase() + ticket.priority.slice(1)} priority
          </span>
        </div>
      </header>

      <p className="mt-3 text-sm text-muted-foreground">
        Created {when(ticket.createdAt)}
        <span className="mx-2 text-border" aria-hidden="true">
          ·
        </span>
        Updated {when(ticket.updatedAt)}
      </p>

      <section className="mt-7 border-t border-border/70 pt-5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Description
        </h2>
        <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {ticket.description}
        </div>
      </section>

      <section className="mt-7 border-t border-border/70 pt-5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Activity
        </h2>
        <p
          className="mt-2 text-sm text-muted-foreground"
          data-testid="ticket-activity-status"
        >
          {activityStatusText(ticket.status, mounted ? ticket.updatedAt : null)}
        </p>

        {replies.length > 0 && (
          <ol className="mt-4 divide-y divide-border/70 border-y border-border/70">
            {replies.map((c) => (
              <li key={c.id} className="py-4" data-testid="ticket-comment">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {c.authorName || 'Support'}
                    {c.authorType !== 'portal' && (
                      <span className="ml-1.5 text-xs font-medium text-muted-foreground">Your IT team</span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{when(c.createdAt)}</span>
                </div>
                <div className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {c.content}
                </div>
                <CommentAttachments ticketId={ticket.id} attachments={c.attachments} />
              </li>
            ))}
          </ol>
        )}

        {/* Live confirmation for screen readers; sighted readers see the reply
            land in the thread above. */}
        <p role="status" className="sr-only">
          {posted ? 'Your reply was sent.' : ''}
        </p>

        {ticket.status !== 'closed' ? (
          <ReplyComposer
            ticketId={ticket.id}
            onPosted={(comment) => {
              setReplies((prev) => [...prev, comment]);
              setPosted(true);
            }}
          />
        ) : (
          <p className="mt-5 text-sm text-muted-foreground" data-testid="ticket-closed-note">
            This ticket is closed.{' '}
            <a
              href={withBase('/tickets/new')}
              className="font-medium text-primary-on-tint underline-offset-4 hover:underline"
            >
              Start a new ticket
            </a>{' '}
            if you need anything else.
          </p>
        )}
      </section>
    </div>
  );
}

export default TicketDetails;
