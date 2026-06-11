import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { statusConfig, type TicketComment, type TicketStatus } from './ticketConfig';

const SYSTEM_TYPES = new Set(['status_change', 'assignment', 'system', 'time_entry']);

function systemLine(c: TicketComment): string {
  if (c.commentType === 'status_change') {
    const from = statusConfig[c.oldValue as TicketStatus]?.label ?? c.oldValue;
    const to = statusConfig[c.newValue as TicketStatus]?.label ?? c.newValue;
    return `${c.authorName ?? 'System'} changed status: ${from} to ${to}`;
  }
  if (c.commentType === 'assignment') {
    return c.newValue ? `${c.authorName ?? 'System'} assigned this ticket` : `${c.authorName ?? 'System'} unassigned this ticket`;
  }
  return c.content || 'System event';
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
  const [open, setOpen] = useState(items.length < 3);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid="ticket-feed-system-collapsed"
      >
        {items.length} changes. Show
      </button>
    );
  }
  return (
    <div className="space-y-1">
      {items.map((c) => (
        <div key={c.id} className="flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
          <span>{systemLine(c)}</span>
          <span title={new Date(c.createdAt).toLocaleString()}>{new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      ))}
    </div>
  );
}

export default function TicketFeed({ comments }: { comments: TicketComment[] }) {
  const blocks = useMemo(() => groupFeed(comments), [comments]);

  if (comments.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="ticket-feed-empty">No activity yet.</p>;
  }

  return (
    <div className="space-y-3 p-4" data-testid="ticket-feed">
      {blocks.map((b, i) =>
        b.kind === 'system-run' ? (
          <SystemRun key={`run-${i}`} items={b.items} />
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
              <span className="font-medium text-foreground">{b.item.authorName ?? (b.item.portalUserId ? 'Requester' : 'Technician')}</span>
              {!b.item.isPublic && <span className="font-medium text-warning">Internal</span>}
              <span className="ml-auto" title={new Date(b.item.createdAt).toLocaleString()}>
                {new Date(b.item.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm">{b.item.content}</p>
          </div>
        )
      )}
    </div>
  );
}
