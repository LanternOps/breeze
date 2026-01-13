import { formatRelativeTime } from '@/lib/utils';

export type TicketComment = {
  id: string;
  author: string;
  createdAt: string;
  message: string;
  isPublic: boolean;
  authorRole?: string;
};

type TicketCommentsProps = {
  comments: TicketComment[];
  emptyMessage?: string;
};

export default function TicketComments({
  comments,
  emptyMessage = 'No public replies yet.'
}: TicketCommentsProps) {
  const publicComments = comments.filter(comment => comment.isPublic);

  if (publicComments.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {publicComments.map(comment => (
        <div key={comment.id} className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-foreground">{comment.author}</div>
              {comment.authorRole && (
                <div className="text-xs text-muted-foreground">{comment.authorRole}</div>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatRelativeTime(new Date(comment.createdAt))}
            </div>
          </div>
          <p className="mt-3 text-sm text-foreground whitespace-pre-line">
            {comment.message}
          </p>
        </div>
      ))}
    </div>
  );
}
