import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type AccessReviewStatus = 'pending' | 'in_progress' | 'completed';

export type AccessReview = {
  id: string;
  name: string;
  description?: string;
  status: AccessReviewStatus;
  reviewerId?: string;
  reviewerName?: string;
  dueDate?: string;
  createdAt: string;
  completedAt?: string;
};

type AccessReviewListProps = {
  reviews: AccessReview[];
  onCreateNew?: () => void;
  onViewReview?: (review: AccessReview) => void;
};

const statusStyles: Record<AccessReviewStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-700',
  in_progress: 'bg-blue-500/10 text-blue-700',
  completed: 'bg-emerald-500/10 text-emerald-700'
};

const statusLabels: Record<AccessReviewStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed'
};

const dayMs = 1000 * 60 * 60 * 24;

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function getDueStatus(dueDate?: string): { label: string; isOverdue: boolean } {
  if (!dueDate) {
    return { label: 'No deadline', isOverdue: false };
  }
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) {
    return { label: 'No deadline', isOverdue: false };
  }
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  if (diffMs < 0) {
    const overdueDays = Math.ceil(Math.abs(diffMs) / dayMs);
    return { label: `${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`, isOverdue: true };
  }
  const remainingDays = Math.ceil(diffMs / dayMs);
  if (remainingDays === 0) {
    return { label: 'Due today', isOverdue: false };
  }
  return { label: `${remainingDays} day${remainingDays === 1 ? '' : 's'} remaining`, isOverdue: false };
}

export default function AccessReviewList({
  reviews,
  onCreateNew,
  onViewReview
}: AccessReviewListProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<AccessReviewStatus | 'all'>('all');

  const filteredReviews = useMemo(() => {
    let result = reviews;

    // Filter by status
    if (statusFilter !== 'all') {
      result = result.filter((review) => review.status === statusFilter);
    }

    // Filter by search query
    const normalized = query.trim().toLowerCase();
    if (normalized) {
      result = result.filter((review) => {
        return (
          review.name.toLowerCase().includes(normalized) ||
          review.description?.toLowerCase().includes(normalized) ||
          review.reviewerName?.toLowerCase().includes(normalized)
        );
      });
    }

    return result;
  }, [query, reviews, statusFilter]);

  return (
    <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Access Reviews</h2>
          <p className="text-sm text-muted-foreground">
            Periodically review user access and permissions to maintain security.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onCreateNew?.()}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          New Review
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor="review-search" className="sr-only">
            Search reviews
          </label>
          <input
            id="review-search"
            type="search"
            placeholder="Search by name or description"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as AccessReviewStatus | 'all')}
          className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
        </select>
        <div className="text-sm text-muted-foreground">
          {filteredReviews.length} of {reviews.length} reviews
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Reviewer</th>
              <th className="px-4 py-3 font-medium">Due Date</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredReviews.map((review) => (
              <tr key={review.id} className="border-t">
                <td className="px-4 py-3">
                  <div>
                    <span className="font-medium">{review.name}</span>
                    {review.description && (
                      <p className="text-xs text-muted-foreground truncate max-w-xs">
                        {review.description}
                      </p>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                      statusStyles[review.status]
                    )}
                  >
                    {statusLabels[review.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {review.reviewerName || '-'}
                </td>
                <td
                  className={cn(
                    'px-4 py-3 text-muted-foreground',
                    review.dueDate && review.status !== 'completed' && getDueStatus(review.dueDate).isOverdue
                      ? 'text-destructive font-medium'
                      : ''
                  )}
                >
                  <div>
                    <span>{review.dueDate ? formatDate(review.dueDate) : '-'}</span>
                    {review.dueDate && (
                      <p
                        className={cn(
                          'text-xs',
                          review.status !== 'completed' && getDueStatus(review.dueDate).isOverdue
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                        )}
                      >
                        {getDueStatus(review.dueDate).label}
                      </p>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {formatDate(review.createdAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onViewReview?.(review)}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {review.status === 'completed' ? 'View' : 'Review'}
                  </button>
                </td>
              </tr>
            ))}
            {filteredReviews.length === 0 && (
              <tr className="border-t">
                <td className="px-4 py-8 text-center text-sm text-muted-foreground" colSpan={6}>
                  No access reviews match your criteria.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
