import { useRef, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/dateTimeFormat';
import TicketFeed from './TicketFeed';
import type { TicketDetail } from './ticketConfig';

interface Props {
  ticket: TicketDetail;
  merged: boolean;
  onSaveDescription: (description: string) => void;
  onEditComment?: (commentId: string, content: string) => void;
  onDeleteComment?: (commentId: string) => void;
  mergedFromNumbers: Record<string, string>;
}

/**
 * The thread, read top to bottom: the requester's own words first (the
 * description, as message 1), then the feed. Message bodies hold a reading
 * measure near 72ch; the column itself may be wider.
 */
export default function TicketConversation({ ticket, merged, onSaveDescription, onEditComment, onDeleteComment, mergedFromNumbers }: Props) {
  const { t } = useTranslation('tickets');
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const author = ticket.submitterName ?? ticket.submitterEmail ?? t('ticketFeed.requester');

  return (
    <div className="w-full max-w-[78ch] space-y-3 px-4 py-4">
      <article className="group rounded-lg border p-3" data-testid="ticket-description-message" aria-label={t('ticketFocus.descriptionAria', { author })}>
        <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{author}</span>
          <span>{t('ticketFeed.requester')}</span>
          <time className="ml-auto" dateTime={ticket.createdAt} title={formatDateTime(ticket.createdAt)}>
            {formatDateTime(ticket.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </time>
          {!merged && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded px-1 text-xs text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              data-testid="ticket-workbench-description-edit-btn"
            >
              {ticket.description ? t('common:actions.edit') : t('ticketWorkbench.description.add')}
            </button>
          )}
        </div>
        {editing && !merged ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              rows={4}
              defaultValue={ticket.description ?? ''}
              data-testid="ticket-workbench-description-textarea"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                data-testid="ticket-workbench-description-cancel-btn"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onSaveDescription(textareaRef.current?.value ?? '');
                  setEditing(false);
                }}
                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white"
                data-testid="ticket-workbench-description-save-btn"
              >
                {t('common:actions.save')}
              </button>
            </div>
          </div>
        ) : ticket.description ? (
          <p className="max-w-[72ch] whitespace-pre-wrap text-sm">{ticket.description}</p>
        ) : (
          <p className="text-sm italic text-muted-foreground">{t('ticketWorkbench.description.empty')}</p>
        )}
      </article>
      <TicketFeed
        ticketId={ticket.id}
        comments={ticket.comments}
        onEditComment={merged ? undefined : onEditComment}
        onDeleteComment={merged ? undefined : onDeleteComment}
        // Delete stays for redaction on every comment; TicketFeed itself never
        // offers Edit on a requester's words.
        canManageComment={() => !merged}
        mergedFromNumbers={mergedFromNumbers}
        embedded
      />
    </div>
  );
}
