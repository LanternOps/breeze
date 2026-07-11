import { useMemo, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { statusConfig, type TicketComment, type TicketStatus } from './ticketConfig';
import { formatDateTime, formatTime } from '@/lib/dateTimeFormat';

const SYSTEM_TYPES = new Set(['status_change', 'assignment', 'system', 'time_entry']);

type TFunction = ReturnType<typeof useTranslation>['t'];

function systemLine(c: TicketComment, t: TFunction): string {
  if (c.commentType === 'status_change') {
    const from = statusConfig[c.oldValue as TicketStatus] ? t(/* i18n-dynamic */ `ticketFeed.status.${c.oldValue}`) : c.oldValue;
    const to = statusConfig[c.newValue as TicketStatus] ? t(/* i18n-dynamic */ `ticketFeed.status.${c.newValue}`) : c.newValue;
    return t('ticketFeed.system.statusChanged', {
      author: c.authorName ?? t('ticketFeed.system.systemAuthor'),
      from,
      to,
    });
  }
  if (c.commentType === 'assignment') {
    return c.newValue
      ? t('ticketFeed.system.assigned', { author: c.authorName ?? t('ticketFeed.system.systemAuthor') })
      : t('ticketFeed.system.unassigned', { author: c.authorName ?? t('ticketFeed.system.systemAuthor') });
  }
  if (c.commentType === 'time_entry') {
    return c.content || t('ticketFeed.system.loggedTime', { author: c.authorName ?? t('ticketFeed.system.technicianAuthor') });
  }
  return c.content || t('ticketFeed.system.systemEvent');
}

type FeedBlock = { kind: 'comment'; item: TicketComment } | { kind: 'system-run'; items: TicketComment[] };

function groupFeed(comments: TicketComment[]): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  for (const c of comments) {
    if (SYSTEM_TYPES.has(c.commentType)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'system-run') last.items.push(c);
      else blocks.push({ kind: 'system-run', items: [c] });
    } else {
      blocks.push({ kind: 'comment', item: c });
    }
  }
  return blocks;
}

function SystemRun({ items }: { items: TicketComment[] }) {
  const { t } = useTranslation('tickets');
  const [open, setOpen] = useState(items.length < 3);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid="ticket-feed-system-collapsed"
      >
        {t('ticketFeed.system.collapsed', { count: items.length })}
      </button>
    );
  }
  return (
    <div className="space-y-1">
      {items.map((c) => (
        <div key={c.id} className="flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
          <span>{systemLine(c, t)}</span>
          <span title={formatDateTime(c.createdAt)}>{formatTime(c.createdAt, { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      ))}
    </div>
  );
}

export default function TicketFeed({
  comments,
  onEditComment,
  onDeleteComment,
  canManageComment,
}: {
  comments: TicketComment[];
  onEditComment?: (id: string, content: string) => void;
  onDeleteComment?: (id: string) => void;
  canManageComment?: (c: TicketComment) => boolean;
}) {
  const { t } = useTranslation('tickets');
  const blocks = useMemo(() => groupFeed(comments), [comments]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  if (comments.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="ticket-feed-empty">{t('ticketFeed.empty')}</p>;
  }

  const openEditor = (id: string, content: string) => {
    setEditingId(id);
    setDraft(content);
  };

  const closeEditor = () => {
    setEditingId(null);
    setDraft('');
  };

  const saveEdit = (id: string, originalContent: string) => {
    if (!draft.trim() || draft === originalContent) {
      closeEditor();
      return;
    }
    onEditComment?.(id, draft);
    closeEditor();
  };

  return (
    <>
      <div className="space-y-3 p-4" data-testid="ticket-feed">
        {blocks.map((b, i) =>
          b.kind === 'system-run' ? (
            <SystemRun key={`run-${i}`} items={b.items} />
          ) : b.item.deleted ? (
            <div
              key={b.item.id}
              className="rounded-lg border border-dashed p-3 text-sm italic text-muted-foreground"
              data-testid={`ticket-comment-deleted-${b.item.id}`}
            >
              {t('ticketFeed.commentDeleted', { author: b.item.authorName ?? t('ticketFeed.commentFallback') })}
            </div>
          ) : (
            <div
              key={b.item.id}
              className={cn(
                'rounded-lg border p-3',
                !b.item.isPublic && 'border-warning/30 bg-warning/10'
              )}
              data-testid={`ticket-comment-${b.item.id}`}
            >
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{b.item.authorName ?? (b.item.portalUserId ? t('ticketFeed.requester') : t('ticketFeed.technician'))}</span>
                {!b.item.isPublic && <span className="font-medium text-warning">{t('ticketFeed.internal')}</span>}
                {b.item.editedAt && (
                  <span data-testid={`ticket-comment-edited-${b.item.id}`} title={formatDateTime(b.item.editedAt)}>{t('ticketFeed.edited')}</span>
                )}
                <span className="ml-auto" title={formatDateTime(b.item.createdAt)}>
                  {formatDateTime(b.item.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                {canManageComment?.(b.item) && onEditComment && (
                  <button
                    type="button"
                    className="text-xs hover:text-foreground"
                    data-testid={`ticket-comment-edit-${b.item.id}`}
                    onClick={() => openEditor(b.item.id, b.item.content)}
                  >
                    {t('common:actions.edit')}
                  </button>
                )}
                {canManageComment?.(b.item) && onDeleteComment && (
                  <button
                    type="button"
                    className="text-xs hover:text-destructive"
                    data-testid={`ticket-comment-delete-${b.item.id}`}
                    onClick={() => setConfirmDeleteId(b.item.id)}
                  >
                    {t('common:actions.delete')}
                  </button>
                )}
              </div>
              {editingId === b.item.id ? (
                <div className="space-y-2 mt-1">
                  <textarea
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    data-testid={`ticket-comment-edit-textarea-${b.item.id}`}
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={closeEditor}
                      className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                      data-testid={`ticket-comment-edit-cancel-${b.item.id}`}
                    >
                      {t('common:actions.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={() => saveEdit(b.item.id, b.item.content)}
                      className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white"
                      data-testid={`ticket-comment-edit-save-${b.item.id}`}
                    >
                      {t('common:actions.save')}
                    </button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm">{b.item.content}</p>
              )}
            </div>
          )
        )}
      </div>
      <ConfirmDialog
        open={confirmDeleteId !== null}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId) {
            onDeleteComment?.(confirmDeleteId);
          }
          setConfirmDeleteId(null);
        }}
        title={t('ticketFeed.deleteDialog.title')}
        message={t('ticketFeed.deleteDialog.message')}
        confirmLabel={t('common:actions.delete')}
        variant="destructive"
        confirmTestId="ticket-comment-delete-confirm"
      />
    </>
  );
}
